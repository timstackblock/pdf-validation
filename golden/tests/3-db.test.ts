/**
 * WHAT THIS TEST FILE PROVES
 *
 * Level covered: Level 3 — "clean record in, database rows out". Given an already-validated invoice,
 * this step writes it to the database: one parent row (the invoice), child rows (its line items), and an
 * audit row (a note of where it came from). These tests use an in-memory database — a real database that
 * lives only in RAM for the duration of one test, so every test starts from a blank slate.
 *
 * What "pass" means in business terms: what we store is exactly what we were given, the same file can
 * never be stored twice, a half-finished write leaves nothing behind, and the database itself enforces
 * the rules even if application code is bypassed or buggy.
 *
 * Production bug this would catch: a duplicate upload double-counting revenue, an invoice saved without
 * its line items after a crash, a rogue status value slipping into reports, or line items being orphaned
 * when their invoice is deleted.
 *
 * Terms used below:
 *   - source_hash: a SHA-256 fingerprint of the PDF's bytes — a fixed-length code that changes if even
 *     one byte of the file changes, so identical files always share the same fingerprint.
 *   - UNIQUE / CHECK / FOREIGN KEY: rules built into the database tables themselves. UNIQUE forbids two
 *     rows with the same value; CHECK restricts a column to allowed values; a FOREIGN KEY says "this child
 *     row must point at a real parent row", so parents cannot vanish while children still reference them.
 *
 * Test-plan cases referenced: GPDF 010 (child records), GPDF 012 (duplicate handling).
 */
import { openDb, insertInvoice, startJob, DB } from '../../app/db';
import { Invoice } from '../../app/types';

// The validated invoice used by every test in this file.
const inv: Invoice = { customerName: 'John Smith', accountNumber: '123456', invoiceDate: '2026-08-15', amountCents: 125075, status: 'Paid',
  lineItems: [{ position: 1, description: 'Consulting', amountCents: 100000 }, { position: 2, description: 'Travel', amountCents: 25075 }] };
let db: DB, meta: any;
// Before each test: open a fresh in-memory database, register a submitted document and an extraction job for it,
// so the invoice insert has the parent records it is required to reference.
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO documents (document_id, filename, source_hash, status, submitted_at) VALUES ('DOC-1','a.pdf','hash-a','PROCESSING','2026-01-01')").run();
  meta = { documentId: 'DOC-1', sourceFile: 'a.pdf', sourceHash: 'hash-a', jobId: startJob(db, 'DOC-1', 'hash-a', 'native', null) };
});
afterEach(() => db.close());

describe('Level 3: typed record -> database contract', () => {
  // GPDF-004 / GPDF-010.
  // Scenario: one valid invoice is inserted.
  // Expected: the invoice row holds every field with the right type (cents as a whole number, a real timestamp),
  // both line items are stored in order, and exactly one audit note is written.
  // Why: this is the contract between the app and the database; any drift here corrupts every later report.
  test('inserts parent, children and audit with correct types', () => {
    expect(insertInvoice(db, inv, meta)).toBe('inserted');
    const row = db.prepare('SELECT * FROM invoices WHERE document_id = ?').get('DOC-1') as any;
    expect(row).toMatchObject({ customer_name: 'John Smith', account_number: '123456', invoice_date: '2026-08-15', amount_cents: 125075, status: 'Paid', source_hash: 'hash-a', extraction_job_id: meta.jobId });
    expect(Number.isInteger(row.amount_cents)).toBe(true);
    expect(row.processed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(db.prepare('SELECT description, amount_cents FROM invoice_line_items WHERE invoice_id = ? ORDER BY position').all(row.id))
      .toEqual([{ description: 'Consulting', amount_cents: 100000 }, { description: 'Travel', amount_cents: 25075 }]);
    expect(db.prepare('SELECT COUNT(*) c FROM invoice_audit').get()).toEqual({ c: 1 });
  });

  // GPDF-012 (Duplicate PDF Handling).
  // Scenario: the same file fingerprint is inserted twice.
  // Expected: the second attempt is reported as "duplicate" and only one invoice row exists.
  // Why: re-uploading an invoice must never double-count revenue.
  test('same hash twice -> one row, reported as duplicate', () => {
    insertInvoice(db, inv, meta);
    expect(insertInvoice(db, inv, { ...meta, documentId: 'DOC-1' })).toBe('duplicate');
    expect(db.prepare('SELECT COUNT(*) c FROM invoices').get()).toEqual({ c: 1 });
  });

  // GPDF-012, defence in depth.
  // Scenario: skip the application's duplicate check entirely and write a second row with the same fingerprint straight into the table.
  // Expected: the database itself refuses (UNIQUE rule).
  // Why: even a future bug or a manual script cannot create a duplicate — the last line of defence is the schema.
  test('UNIQUE(source_hash) holds even when the app check is bypassed', () => {
    insertInvoice(db, inv, meta);
    db.prepare("INSERT INTO documents (document_id, filename, source_hash, status, submitted_at) VALUES ('DOC-2','b.pdf','hash-a','PROCESSING','2026-01-01')").run();
    expect(() => db.prepare(`INSERT INTO invoices (document_id, customer_name, account_number, invoice_date, amount_cents, status, source_file, source_hash, extraction_job_id, processed_at)
      VALUES ('DOC-2','x','000000','2026-01-01',1,'Paid','x.pdf','hash-a',?, '2026-01-01')`).run(meta.jobId)).toThrow(/UNIQUE/);
  });

  // Scenario: the write is forced to crash after the invoice row is written but before its line items are.
  // Expected: the whole write is rolled back — zero rows in the invoice, line-item AND audit tables.
  // Why: an invoice with no line items would look complete but be unusable; "all or nothing" keeps the data honest.
  test('failure mid-transaction leaves zero rows in parent AND children', () => {
    expect(() => insertInvoice(db, inv, meta, { failAfterInvoiceInsert: true })).toThrow(/simulated/);
    for (const t of ['invoices', 'invoice_line_items', 'invoice_audit'])
      expect(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get()).toEqual({ c: 0 });
  });

  // Scenario: an invoice with a status value that Level 2 should already have rejected ("Pending") reaches the database.
  // Expected: the table's CHECK rule refuses it.
  // Why: two independent gates (app and schema) mean an unexpected status cannot reach dashboards even if one gate fails.
  test('schema CHECK rejects statuses the app should never produce', () => {
    expect(() => insertInvoice(db, { ...inv, status: 'Pending' as any }, meta)).toThrow(/CHECK/);
  });

  // GPDF-010 (child records stay attached to their parent).
  // Scenario: try to delete an invoice that still has line items.
  // Expected: refused by the FOREIGN KEY rule.
  // Why: it proves orphaned line items cannot exist — and, importantly for this suite, that cleanup must delete children first.
  test('foreign keys are enforced: cannot delete an invoice that still has children', () => {
    insertInvoice(db, inv, meta);
    expect(() => db.prepare('DELETE FROM invoices').run()).toThrow(/FOREIGN KEY/);
  });
});
