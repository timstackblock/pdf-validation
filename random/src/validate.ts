/**
 * WHAT THIS FILE DOES
 *
 * This is the conductor of the Random PDF validator: it runs the whole workflow for one file, in order. It asks
 * QA's independent reader to read the PDF; opens the database read-only; finds the record by the file's SHA-256
 * fingerprint; compares every header field using the rulebook; reconciles line items and totals; overlays any saved
 * human decisions; and produces a single ValidationReport with an overall PASS, FAIL or REVIEW. Two rules protect the
 * database from being blamed for things that are not its fault: a PDF that QA itself cannot read produces a REVIEW
 * report rather than a crash, and no record (or an ambiguous match) is reported rather than assumed. Overall result:
 * any FAIL or MISSING_DATABASE anywhere means FAIL; otherwise any REVIEW or MISSING_PDF means REVIEW; otherwise PASS.
 * The database path is always an explicit input so a run can never silently point at the wrong environment.
 */
import { basename } from 'path';
import { DocumentReader, ValidationReport, FieldComparison } from './types';
import { IndependentInvoiceReader } from './reader';
import { openReadOnly, locate, lineItems } from './locator';
import { compareDocument } from './compare';
import { INVOICE_RULES } from './rules';
import { reconcileLineItems } from './reconcile';
import { loadReviews, applyReviews, isLineItemReview } from './review';
import { fileHash } from './hash';

/** Inputs for one run: which database, optionally which reader (default: QA's Poppler/Tesseract reader), where human decisions live, the date convention if known, and a label for the environment in the report. */
export interface ValidateOpts {
  dbPath: string; reader?: DocumentReader; reviewsDir?: string;
  /** Only pass a locale when the caller KNOWS it. With none, an ambiguous 01/02/2026 is REVIEW, never a guess. */
  locale?: 'US' | 'EU';
  environment?: string;
}

/** Count the field verdicts for the report header. "Critical failures" are FAIL or MISSING_DATABASE on a CRITICAL-severity field (money, account number). */
export function summarize(comparisons: FieldComparison[]) {
  const n = (s: string) => comparisons.filter(c => c.status === s).length;
  return { fieldsChecked: comparisons.length, passed: n('PASS'), failed: n('FAIL'), review: n('REVIEW'), missingPdf: n('MISSING_PDF'),
    missingDatabase: n('MISSING_DATABASE'), criticalFailures: comparisons.filter(c => ['FAIL', 'MISSING_DATABASE'].includes(c.status) && c.severity === 'CRITICAL').length };
}

/** The whole random-file workflow, read-only against the database. Never throws for an unreadable PDF — that is a REVIEW. */
export async function validatePdf(filePath: string, opts: ValidateOpts): Promise<ValidationReport> {
  const reader = opts.reader ?? new IndependentInvoiceReader();
  const filename = basename(filePath);
  const validatedAt = new Date().toISOString();
  const locale: 'US' | 'EU' | 'unknown' = opts.locale ?? 'unknown';
  const environment = opts.environment ?? opts.dbPath;

  // Step 1: read the PDF independently. A corrupt file or a crashed OCR service is not a database defect, so it yields a REVIEW report, not an error.
  let doc;
  try { doc = await reader.extract(filePath); }
  catch (error) {
    // Still try to fingerprint the file so the report can be tied to it later; if even that fails, say so.
    let hash = 'unreadable';
    try { hash = fileHash(filePath); } catch { /* file itself is unreadable */ }
    return { document: { filename, hash, environment, readerUsed: reader.name, validatedAt, locale }, candidates: [], comparisons: [], summary: summarize([]),
      overallResult: 'REVIEW', reason: `QA validator could not independently read this PDF: ${(error as Error).message}` };
  }

  // Step 2: open the database read-only; it is always closed at the end, whatever happens.
  const db = openReadOnly(opts.dbPath);
  try {
    const base = { document: { filename, hash: doc.sourceHash, environment, readerUsed: doc.readerUsed, validatedAt, locale } };
    // Step 3: find the record by hash. Every candidate (including weak filename matches) is reported for the tester.
    const loc = locate(db, doc.sourceHash, filename);
    const candidates = loc.candidates.map(c => ({ document_id: c.row.document_id, matchedBy: c.matchedBy }));
    // No single confident match: more than one hash match is a duplicate-ingestion defect (FAIL); none is REVIEW because the lookup itself may be incomplete.
    if (!loc.confident) {
      const reason = loc.candidates.length > 1 ? `${loc.candidates.length} records match this PDF; duplicates are not expected` : 'No database record could be confidently matched to this PDF';
      return { ...base, candidates, comparisons: [], summary: summarize([]), overallResult: loc.candidates.length > 1 ? 'FAIL' : 'REVIEW', reason };
    }
    const row = loc.confident;
    // Step 4: compare header fields, then overlay any human decisions that concern header fields (line-item decisions go to the reconciler instead).
    const reviews = opts.reviewsDir ? loadReviews(opts.reviewsDir, doc.sourceHash) : [];
    let comparisons = compareDocument(INVOICE_RULES, doc, row as any, { locale: opts.locale });
    if (reviews.length) comparisons = applyReviews(comparisons, reviews.filter(r => !isLineItemReview(r)));
    // Step 5: reconcile line items and the four totals, with the PDF's printed total and any line-item decisions.
    const li = reconcileLineItems(doc, lineItems(db, row.id), row.amount_cents, { pdfAmount: doc.amount, reviews: reviews.filter(isLineItemReview) });
    // Step 6: roll everything up. Failures anywhere win; otherwise open questions anywhere mean REVIEW.
    const summary = summarize(comparisons);
    const anyFail = summary.failed + summary.missingDatabase > 0 || li.status === 'FAIL';
    const anyReview = summary.review + summary.missingPdf > 0 || li.status === 'REVIEW';
    return { ...base, document: { ...base.document, documentId: row.document_id }, candidates, comparisons, lineItems: li, summary,
      overallResult: anyFail ? 'FAIL' : anyReview ? 'REVIEW' : 'PASS' };
  } finally { db.close(); }
}
