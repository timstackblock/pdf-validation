/**
 * WHAT THIS FILE DOES
 * This is the conductor of the whole process. For each submitted PDF it runs the three stages in order:
 * (1) get the text out - from a remembered earlier read, from the PDF's own text, or via OCR;
 * (2) find the invoice fields in that text and check them against the business rules;
 * (3) save the validated invoice to the database, or flag it as a duplicate.
 * A PDF goes in; the outcome (COMPLETED, DUPLICATE or FAILED with a reason) is written on its "documents"
 * row so anyone can look up what happened to it. The key rule: a document either ends up fully saved or not
 * saved at all, and every outcome - including failures - is recorded rather than lost. It also offers a batch
 * mode that processes many files and writes a summary tally of the run.
 */
import { createHash, randomUUID } from 'crypto';
import { extractNativeText, looksLikeInvoice, parseFields } from './extract';
import { ocrPdf } from './ocr';
import { transform } from './transform';
import { DB, insertInvoice, startJob, finishJob, now, InsertOpts } from './db';
import { ExtractionResult, Invoice } from './types';

// Fingerprint of a file's contents using SHA-256 (a standard method that turns any file into a fixed-length
// code; two files get the same code only if they are byte-for-byte identical). This is how we spot duplicates.
export const hashBuffer = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Stage 1: cache -> native text -> OCR fallback. Records an extraction job either way. */
// Get the text out of a PDF, cheapest method first:
//  - already read this exact file before? reuse the stored text (engine 'cache');
//  - PDF has its own text and it looks like an invoice? use that (engine 'native');
//  - otherwise run OCR (engine 'tesseract'), which is slow but works on scans.
// Whatever we get is remembered in the cache so re-submitting the file later is instant.
export async function extractText(db: DB, buf: Buffer, sourceHash: string): Promise<ExtractionResult> {
  const cached = db.prepare('SELECT text, engine, mean_confidence FROM extraction_cache WHERE source_hash = ?').get(sourceHash) as any;
  if (cached) return { text: cached.text, engine: 'cache', meanConfidence: cached.mean_confidence };

  const native = await extractNativeText(buf);
  let result: ExtractionResult = { text: native, engine: 'native', meanConfidence: null };
  if (!looksLikeInvoice(native)) {
    const o = ocrPdf(buf);
    result = { text: o.text, engine: 'tesseract', meanConfidence: o.meanConfidence };
  }
  db.prepare('INSERT OR REPLACE INTO extraction_cache (source_hash, text, engine, mean_confidence, created_at) VALUES (?,?,?,?,?)')
    .run(sourceHash, result.text, result.engine, result.meanConfidence, now());
  return result;
}

// Optional knobs: fixtureId tags a document for tests; forceFail and insertOpts are test-only ways to make
// processing fail on purpose so we can prove failures are handled cleanly.
export interface SubmitOpts { fixtureId?: string | null; forceFail?: boolean; insertOpts?: InsertOpts }

/** Register a document (status QUEUED). This is what the HTTP layer calls; processing happens in processDocument. */
// Give the PDF a short id (e.g. DOC-1a2b3c4d), fingerprint it, and log it as QUEUED. Nothing is read or
// validated yet - this is deliberately quick so the API can answer "received" immediately.
export function submitDocument(db: DB, buf: Buffer, filename: string, opts: SubmitOpts = {}) {
  const documentId = `DOC-${randomUUID().slice(0, 8)}`;
  db.prepare('INSERT INTO documents (document_id, filename, source_hash, test_fixture_id, status, submitted_at) VALUES (?,?,?,?,?,?)')
    .run(documentId, filename, hashBuffer(buf), opts.fixtureId ?? null, 'QUEUED', now());
  return documentId;
}

/** Worker: run the pipeline for one queued document. Never throws; outcome is recorded on the documents row. */
// Do the real work for one document. Every path ends by writing a final status on the documents row:
// COMPLETED (invoice saved), DUPLICATE (same file seen before, nothing saved) or FAILED (with the reason).
// Returns the invoice on success, or null if it was not saved. It never crashes the caller - a bad PDF must
// not take down the server or stop the rest of a batch.
export async function processDocument(db: DB, documentId: string, buf: Buffer, opts: SubmitOpts = {}): Promise<Invoice | null> {
  // Helper that writes the final outcome and timestamp onto the document's row.
  const done = (status: string, error?: string) =>
    db.prepare('UPDATE documents SET status = ?, error = ?, completed_at = ? WHERE document_id = ?').run(status, error ?? null, now(), documentId);
  let jobId: number | null = null;
  let doc: any;
  try {
    doc = db.prepare('SELECT * FROM documents WHERE document_id = ?').get(documentId);
    if (!doc) throw new Error(`unknown document ${documentId}`);
    db.prepare("UPDATE documents SET status = 'PROCESSING' WHERE document_id = ?").run(documentId);
    if (opts.forceFail) throw new Error('forced failure (test hook)');
    // Stage 1: read the text and log an extraction job saying how it was read.
    const ex = await extractText(db, buf, doc.source_hash);                       // stage 1
    jobId = startJob(db, documentId, doc.source_hash, ex.engine, ex.meanConfidence);
    // Stage 2: find the fields and validate them. Any rule violation throws and the document is FAILED.
    const invoice = transform(parseFields(ex.text));                                // stage 2
    // Stage 3: save it (all-or-nothing) or discover it is a duplicate.
    const r = insertInvoice(db, invoice, { documentId, sourceFile: doc.filename, sourceHash: doc.source_hash, fixtureId: doc.test_fixture_id, jobId }, opts.insertOpts); // stage 3
    finishJob(db, jobId);
    done(r === 'inserted' ? 'COMPLETED' : 'DUPLICATE');
    return invoice;
  } catch (e) {
    // Any error at any stage: close the job if one was opened, record FAILED plus the reason, and move on.
    if (jobId) finishJob(db, jobId);
    done('FAILED', (e as Error).message);
    return null;
  }
}

/** Convenience: submit + process synchronously (used by the integration layer, not the system test). */
// Submit and process in one go, waiting for the answer. Unlike processDocument, a FAILED outcome is raised as
// an error here so batch callers can count it as "rejected".
export async function processPdf(db: DB, buf: Buffer, filename: string, opts: SubmitOpts = {}) {
  const documentId = submitDocument(db, buf, filename, opts);
  const invoice = await processDocument(db, documentId, buf, opts);
  const doc = db.prepare('SELECT status, error FROM documents WHERE document_id = ?').get(documentId) as any;
  if (doc.status === 'FAILED') throw new Error(doc.error);
  return { documentId, result: doc.status === 'COMPLETED' ? 'inserted' as const : 'duplicate' as const, invoice: invoice! };
}

// Process a list of files one after another. A bad file is recorded as 'rejected' and the batch carries on.
// At the end a processing_runs row is written with the tallies (submitted / inserted / duplicates / rejected)
// and the total value in cents of everything newly inserted - the numbers a manager would want from the run.
export async function processBatch(db: DB, files: { buf: Buffer; name: string }[]) {
  const started = now();
  const outcomes: { file: string; result: 'inserted' | 'duplicate' | 'rejected'; amountCents?: number; error?: string }[] = [];
  for (const f of files) {
    try { const o = await processPdf(db, f.buf, f.name); outcomes.push({ file: f.name, result: o.result, amountCents: o.invoice.amountCents }); }
    catch (e) { outcomes.push({ file: f.name, result: 'rejected', error: (e as Error).message }); }
  }
  // Only newly inserted invoices count towards the run's total; duplicates were already counted in an earlier run.
  const ins = outcomes.filter(o => o.result === 'inserted');
  const summary = { submitted: files.length, inserted: ins.length, duplicates: outcomes.filter(o => o.result === 'duplicate').length,
    rejected: outcomes.filter(o => o.result === 'rejected').length, insertedAmountCents: ins.reduce((s, o) => s + o.amountCents!, 0) };
  db.prepare('INSERT INTO processing_runs (started_at, submitted, inserted, duplicates, rejected, inserted_amount_cents) VALUES (?,?,?,?,?,?)')
    .run(started, summary.submitted, summary.inserted, summary.duplicates, summary.rejected, summary.insertedAmountCents);
  return { outcomes, summary };
}
