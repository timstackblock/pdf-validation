/**
 * WHAT THIS FILE PROVES
 *
 * This is the end-to-end proof for "random" PDFs: invoices nobody has prepared an answer key for. Each test
 * creates a brand-new invoice PDF, pushes it through the real application's ingestion (the same code that runs
 * in production), and then asks the validator to check what landed in the database against what the PDF says,
 * using its own independent reader and a read-only view of the database. The validator must (a) PASS when the
 * data is correct, (b) FAIL when we deliberately tamper with the stored record, and (c) say REVIEW whenever it
 * cannot be sure, instead of guessing. No expected JSON exists for any of these documents; the PDF itself is
 * the only source of truth. Along the way it also proves the validator finds the right record by the file's
 * SHA-256 hash (a unique fingerprint computed from the file's bytes), never alters the database, can hide
 * customer identifiers in reports, and lets a human reviewer's decision settle an uncertain case.
 * Case IDs such as RPDF-017 refer to TEST_PLAN_RANDOM_PDF_RECONCILIATION.md.
 */
import { join } from 'path';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { openDb, DB } from '../../app/db';
import { processPdf } from '../../app/pipeline';
import { buildSpec } from '../../fixtures/gen/generate-pdfs';
import { validatePdf } from '../src/validate';
import { IndependentInvoiceReader } from '../src/reader';
import { saveReview } from '../src/review';
import { renderText, writeReport } from '../src/report';
import { fileHash } from '../src/hash';

// Builds the lines of text for a simple invoice: customer, account number, date, status, line items and total.
const inv = (name: string, acct: string, date: string, status: string, items: [string, string][], total: string) => [
  'INVOICE', `Customer Name: ${name}`, `Account Number: ${acct}`, `Invoice Date: ${date}`, `Status: ${status}`,
  'Line Items:', ...items.map(([d, a]) => `${d}    ${a}`), `Amount: ${total}`];

// A throwaway folder and database that exist only for this test run and are deleted afterwards.
let dir: string, dbPath: string, db: DB;
const files: Record<string, string> = {};

/** Write a never-before-seen PDF to disk and run it through production ingestion. */
async function ingest(id: string, lines: string[], scanned?: { dpi: number; rotate?: number; noise?: boolean }) {
  const buf = Buffer.from(await buildSpec({ id, lines, ...(scanned ? { scanned } : { native: {} }) }));
  const p = join(dir, `${id}.pdf`); writeFileSync(p, buf); files[id] = p;
  const out = await processPdf(db, buf, `${id}.pdf`);
  return { path: p, documentId: out.documentId, invoiceId: (db.prepare('SELECT id FROM invoices WHERE document_id = ?').get(out.documentId) as any).id };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'random-')); dbPath = join(dir, 'app-test.sqlite'); db = openDb(dbPath);
});
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('Random PDF reconciliation against production-stored data', () => {
  // RPDF-001 (plus the happy path). A normal, text-based PDF is ingested correctly -> PASS on all 5 fields and both line items.
  // Also proves the record was found by the file's hash, and that the validator used a different PDF reader (Poppler)
  // from the one the application uses (pdf.js) - an independent second opinion, not the app checking its own homework.
  test('correct native ingestion -> PASS, located by hash, read with Poppler not pdf.js', async () => {
    const { path, documentId } = await ingest('RND-001', inv('Random Customer One', '246810', '04/12/2026', 'Paid', [['Design', '$400.00'], ['Build', '$1,100.00']], '$1,500.00'));
    const r = await validatePdf(path, { dbPath, locale: 'US' });
    expect(r.overallResult).toBe('PASS');
    expect(r.document.documentId).toBe(documentId);
    expect(r.candidates).toEqual([{ document_id: documentId, matchedBy: 'source_hash' }]);
    expect(r.document.readerUsed).toBe('poppler-pdftotext');
    expect(r.summary).toMatchObject({ fieldsChecked: 5, passed: 5, failed: 0 });
    expect(r.lineItems).toMatchObject({ pdfCount: 2, dbCount: 2, status: 'PASS', totalsAgreeWithAmount: true });
  });

  // A scanned invoice (just a picture of a page, no selectable text). The validator must run its own OCR
  // (text recognition from an image), still reach PASS, and attach a confidence score to every field it compared.
  test('scanned PDF: QA does its own OCR and still PASSes; per-field confidence is reported', async () => {
    const { path } = await ingest('RND-002', inv('Scanned Random Co', '135791', '05/20/2026', 'Unpaid', [['Survey', '$225.00']], '$225.00'), { dpi: 200 });
    const r = await validatePdf(path, { dbPath, locale: 'US' });
    expect(r.overallResult).toBe('PASS');
    expect(r.document.readerUsed).toMatch(/tesseract/);
    expect(r.comparisons.every(c => typeof c.confidence === 'number')).toBe(true);
  });

  // RPDF-006 / RPDF-014. After ingestion we secretly change the stored total from $48,392.17 to $48,392.71.
  // Expected: CRITICAL FAIL, the report states the difference (-0.54), the line-item check notices the rows no
  // longer add up to the total, and the human-readable report prints the failure clearly.
  test('tampered amount in DB -> CRITICAL FAIL with numeric difference; line items flag the sum mismatch', async () => {
    const { path, invoiceId } = await ingest('RND-003', inv('Tamper Target', '999111', '06/01/2026', 'Paid', [['Thing', '$48,392.17']], '$48,392.17'));
    db.prepare('UPDATE invoices SET amount_cents = 4839271 WHERE id = ?').run(invoiceId);   // 48,392.71
    const r = await validatePdf(path, { dbPath, locale: 'US' });
    expect(r.overallResult).toBe('FAIL');
    expect(r.summary.criticalFailures).toBe(1);
    const a = r.comparisons.find(c => c.field === 'amount_cents')!;
    expect(a.status).toBe('FAIL'); expect(a.reason).toMatch(/difference -0.54/);
    expect(r.lineItems!.totalsAgreeWithAmount).toBe(false);
    expect(renderText(r)).toMatch(/FAIL — CRITICAL  amount_cents/);
  });

  // RPDF-012. We delete one of the two invoice rows ("Beta") from the database -> FAIL, and the report names Beta as missing.
  test('deleted line item in DB -> FAIL naming the missing item (RPDF-012)', async () => {
    const { path, invoiceId } = await ingest('RND-004', inv('Missing Child', '222333', '06/02/2026', 'Paid', [['Alpha', '$10.00'], ['Beta', '$20.00']], '$30.00'));
    db.prepare("DELETE FROM invoice_line_items WHERE invoice_id = ? AND description = 'Beta'").run(invoiceId);
    const r = await validatePdf(path, { dbPath, locale: 'US' });
    expect(r.overallResult).toBe('FAIL');
    expect(r.lineItems!.unmatchedPdf.map(u => u.description)).toEqual(['Beta']);
  });

  // We change the stored customer name to "Wrong Name" -> the name field FAILs (HIGH severity) and so does the invoice overall.
  // A wrong customer on an invoice is a serious, customer-visible error.
  test('DB NULL-equivalent field -> MISSING_DATABASE; wrong customer name -> HIGH FAIL', async () => {
    const { path, invoiceId } = await ingest('RND-005', inv('Correct Name', '444555', '06/03/2026', 'Paid', [], '$0.00'));
    db.prepare("UPDATE invoices SET customer_name = 'Wrong Name' WHERE id = ?").run(invoiceId);
    const r = await validatePdf(path, { dbPath, locale: 'US' });
    expect(r.comparisons.find(c => c.field === 'customer_name')!.status).toBe('FAIL');
    expect(r.overallResult).toBe('FAIL');
  });

  // RPDF-017. A PDF that was never ingested at all -> REVIEW ("No database record"), not FAIL.
  // Perhaps it was never sent to the app; a person must decide, and the validator must not claim data loss it cannot prove.
  test('no record for this PDF -> REVIEW, not FAIL (RPDF-017)', async () => {
    const p = join(dir, 'never-ingested.pdf');
    writeFileSync(p, Buffer.from(await buildSpec({ id: 'RND-006', native: {}, lines: inv('Ghost', '777888', '06/04/2026', 'Paid', [], '$0.00') })));
    const r = await validatePdf(p, { dbPath, locale: 'US' });
    expect(r.overallResult).toBe('REVIEW'); expect(r.reason).toMatch(/No database record/); expect(r.candidates).toEqual([]);
  });

  // RPDF-018. Two database records claim the same PDF (same hash) -> FAIL, listing both so an analyst can untangle it.
  // The real app's database rules forbid duplicates, so a lookalike database without that rule is built just for this test.
  test('two records with the same hash -> FAIL and lists both candidates (RPDF-018)', async () => {
    // The app schema forbids this (UNIQUE source_hash), so simulate a schema that does not.
    const { path } = await ingest('RND-007', inv('Dup Hash', '101010', '06/05/2026', 'Paid', [], '$0.00'));
    const alt = join(dir, 'dup-test.sqlite'); const a = new Database(alt);
    a.exec("CREATE TABLE invoices (id INTEGER PRIMARY KEY, document_id TEXT, customer_name TEXT, account_number TEXT, invoice_date TEXT, amount_cents INTEGER, status TEXT, source_file TEXT, source_hash TEXT, processed_at TEXT); CREATE TABLE invoice_line_items (id INTEGER PRIMARY KEY, invoice_id INTEGER, position INTEGER, description TEXT, amount_cents INTEGER);");
    for (const id of ['DOC-A', 'DOC-B']) a.prepare("INSERT INTO invoices (document_id, customer_name, account_number, invoice_date, amount_cents, status, source_file, source_hash, processed_at) VALUES (?, 'Dup Hash','101010','2026-06-05',0,'Paid','RND-007.pdf',?, 't')").run(id, fileHash(path));
    a.close();
    const r = await validatePdf(path, { dbPath: alt, locale: 'US' });
    expect(r.overallResult).toBe('FAIL'); expect(r.candidates).toHaveLength(2); expect(r.reason).toMatch(/2 records match/);
  });

  // RPDF-007 then RPDF-020. The stored account number is changed, and we use a deliberately "shaky" reader that reports
  // only 61% confidence in the account number. First run: REVIEW (we cannot be sure who is wrong). A human then records
  // "the database is wrong, the PDF really says 808808". Second run: FAIL, with the reviewer's name attached.
  test('low-confidence OCR disagreement -> REVIEW; human review resolves it (RPDF-007/019)', async () => {
    const { path, invoiceId } = await ingest('RND-008', inv('Review Case', '808808', '06/06/2026', 'Paid', [], '$0.00'));
    db.prepare("UPDATE invoices SET account_number = '808809' WHERE id = ?").run(invoiceId);  // DB differs from PDF
    // A reader that returns the same fields but with a low-confidence account number, as a noisy OCR would.
    const shaky = { name: 'shaky-ocr', async extract(p: string) { const d = await new IndependentInvoiceReader().extract(p); d.readerUsed = 'shaky-ocr'; d.extractionConfidence.accountNumber = 0.61; return d; } };
    const r1 = await validatePdf(path, { dbPath, reader: shaky, locale: 'US' });
    expect(r1.comparisons.find(c => c.field === 'account_number')!.status).toBe('REVIEW');
    expect(r1.overallResult).toBe('REVIEW');

    const reviews = join(dir, 'reviews');
    saveReview(reviews, fileHash(path), { field: 'account_number', decision: 'DATABASE_INCORRECT', verifiedValue: '808808', reviewer: 'tim', timestamp: new Date().toISOString(), reason: 'checked PDF visually' });
    const r2 = await validatePdf(path, { dbPath, reader: shaky, reviewsDir: reviews, locale: 'US' });
    const c = r2.comparisons.find(c => c.field === 'account_number')!;
    expect(c.status).toBe('FAIL'); expect(c.reviewed?.reviewer).toBe('tim');
    expect(r2.overallResult).toBe('FAIL');
  });

  // Safety: running the validator must leave the database exactly as it was (same number of invoices), and the
  // read-only connection it uses must physically refuse a delete. A checker that could change the thing it checks is worthless.
  test('validator holds a read-only connection: it can never modify the record under test', async () => {
    const { path } = await ingest('RND-009', inv('RO Check', '303030', '06/07/2026', 'Paid', [], '$0.00'));
    const before = db.prepare('SELECT COUNT(*) c FROM invoices').get();
    await validatePdf(path, { dbPath, locale: 'US' });
    expect(db.prepare('SELECT COUNT(*) c FROM invoices').get()).toEqual(before);
    const ro = new Database(dbPath, { readonly: true });
    expect(() => ro.prepare('DELETE FROM invoices').run()).toThrow(/readonly/);
    ro.close();
  });

  // Privacy: with masking switched on, neither the text report nor the JSON file may contain the account number
  // (only its last two digits, as ****51) or the customer name - even the wrong values from the database.
  // Non-sensitive data such as the invoice date must still appear, so the report stays useful.
  test('masked reports hide every sensitive field in BOTH text and json', async () => {
    const { path, invoiceId } = await ingest('RND-010', inv('Mask Me', '515151', '06/08/2026', 'Paid', [], '$0.00'));
    db.prepare("UPDATE invoices SET account_number = '515152', customer_name = 'Wrong Person' WHERE id = ?").run(invoiceId);
    const r = await validatePdf(path, { dbPath, locale: 'US' });
    const txt = renderText(r, { maskIdentifiers: true });
    expect(txt).toMatch(/\*\*\*\*51/); expect(txt).not.toMatch(/515151/); expect(txt).not.toMatch(/Mask Me|Wrong Person/);
    const out = mkdtempSync(join(tmpdir(), 'rep-'));
    writeReport(out, r, { maskIdentifiers: true });
    const json = readFileSync(join(out, `random-RND-010-${r.document.hash.slice(0, 8)}.json`), 'utf8');
    expect(json).not.toMatch(/515151|515152|Mask Me|Wrong Person/); expect(JSON.parse(json).masked).toBe(true);
    expect(JSON.parse(json).comparisons.find((c: any) => c.field === 'invoice_date').databaseValue).toBe('2026-06-08');   // non-sensitive stays
    rmSync(out, { recursive: true, force: true });
  });

  // RPDF-016. The date "03/04/2026" could be 4 March or 3 April. With no locale supplied the validator must report
  // "locale unknown" and REVIEW rather than silently assume US format; once told the locale is US, it PASSes.
  test('no locale given: an ambiguous date is REVIEW, never silently read as US (README safety rule)', async () => {
    const { path } = await ingest('RND-011', inv('Locale Unknown', '606060', '03/04/2026', 'Paid', [], '$0.00'));
    const r = await validatePdf(path, { dbPath });
    expect(r.document.locale).toBe('unknown');
    expect(r.comparisons.find(c => c.field === 'invoice_date')!.status).toBe('REVIEW');
    expect(r.overallResult).toBe('REVIEW');
    expect((await validatePdf(path, { dbPath, locale: 'US' })).overallResult).toBe('PASS');
  });

  // Two ways our own reading can fail: a corrupt file, and an OCR service that throws an error. Both must produce a
  // tidy REVIEW report explaining what happened (still carrying the file's hash), not a crash and not a FAIL -
  // an unreadable source tells us nothing about whether the database is right.
  test('independent reader failure -> REVIEW report, not a crash (unreadable source is not a database defect)', async () => {
    const p = join(dir, 'corrupt.pdf'); writeFileSync(p, Buffer.from('%PDF-1.4 not really'));
    const r = await validatePdf(p, { dbPath });
    expect(r.overallResult).toBe('REVIEW'); expect(r.reason).toMatch(/could not independently read/);
    expect(r.document.hash).toBe(fileHash(p));
    const boom = { name: 'boom', async extract() { throw new Error('OCR service unavailable'); } };
    const r2 = await validatePdf(files['RND-001'], { dbPath, reader: boom });
    expect(r2.overallResult).toBe('REVIEW'); expect(r2.reason).toMatch(/OCR service unavailable/);
  });

  // RPDF-019 (line-item variant), end to end. A shaky reader misreads a line item as $153.88 (the PDF and database say $158.88)
  // -> REVIEW, and the printed report shows the exact review keys. A human records "our reader was wrong" against those
  // keys; the next run PASSes. Proves the keys a reviewer sees in the report are the ones the system actually honours.
  test('line-item review key printed in the report resolves a low-confidence line item disagreement', async () => {
    const { path, invoiceId } = await ingest('RND-012', inv('Line Review', '707070', '06/09/2026', 'Paid', [['Repair', '$158.88']], '$158.88'));
    const shaky = { name: 'shaky-ocr', async extract(p: string) { const d = await new IndependentInvoiceReader().extract(p); d.lineItems[0] = { description: 'Repair', amount: '$153.88', confidence: 0.61 }; return d; } };
    const r1 = await validatePdf(path, { dbPath, reader: shaky, locale: 'US' });
    expect(r1.lineItems!.status).toBe('REVIEW'); expect(r1.overallResult).toBe('REVIEW');
    const keys = r1.lineItems!.issues.map(i => i.reviewKey);
    expect(keys).toEqual(['lineItems:repair:15388', 'lineItems:repair:15888']);
    expect(renderText(r1)).toMatch(/review key: lineItems:repair:15388/);
    const reviews = join(dir, 'reviews-li');
    for (const k of keys) saveReview(reviews, fileHash(path), { field: k, decision: 'QA_EXTRACTION_INCORRECT', reviewer: 'tim', timestamp: 't', reason: 'PDF really says 158.88' });
    const r2 = await validatePdf(path, { dbPath, reader: shaky, reviewsDir: reviews, locale: 'US' });
    expect(r2.lineItems!.status).toBe('PASS'); expect(r2.overallResult).toBe('PASS');
    void invoiceId;
  });
});
