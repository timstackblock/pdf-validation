/**
 * WHAT THIS FILE DOES
 * This file owns the database: it opens it, creates the tables if they do not exist yet, and provides the
 * handful of write operations the pipeline needs (record an invoice, record an extraction job). The database
 * is SQLite, a single-file database that needs no separate server. The key business rule enforced here is
 * "all or nothing": an invoice, its line items and its audit note are saved together in one transaction (a
 * bundle of changes that either fully succeeds or is fully undone), so the database can never hold a half-saved
 * invoice. It also refuses to store the same PDF twice by checking the file's fingerprint (hash) first.
 */
import Database from 'better-sqlite3';
import { Invoice, Engine } from './types';
export type DB = Database.Database;

// Open (or create) the database file. Default ':memory:' means a throwaway database that lives only while the
// program runs - used by tests. Read-only mode is for inspection tools that must never change data.
export function openDb(path = ':memory:', opts: { readonly?: boolean } = {}): DB {
  const db = new Database(path, { readonly: !!opts.readonly });
  // foreign_keys = ON makes the database reject a line item that points at an invoice which does not exist
  // (a "foreign key" is a column that must match a row in another table).
  db.pragma('foreign_keys = ON');
  // WAL is a write mode that lets readers keep reading while a write is in progress; skipped in read-only mode.
  if (!opts.readonly) db.pragma('journal_mode = WAL');
  // Create all tables on first use so a brand-new database is ready immediately.
  if (!opts.readonly) db.exec(SCHEMA);
  return db;
}

// The table definitions. In plain terms:
//   documents         - every PDF ever submitted and where it got to (QUEUED -> PROCESSING -> COMPLETED/FAILED/DUPLICATE)
//   extraction_jobs   - one row per attempt to read text out of a PDF, and which method was used
//   extraction_cache  - remembered text for a file we already read, keyed by the file's fingerprint
//   invoices          - the validated invoice header (customer, account, date, total, status)
//   invoice_line_items- the individual lines belonging to an invoice
//   invoice_audit     - a human-readable note about where each invoice came from
//   processing_runs   - a summary tally for each batch run (how many inserted / duplicate / rejected)
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  document_id     TEXT PRIMARY KEY,
  filename        TEXT NOT NULL,
  source_hash     TEXT NOT NULL,
  test_fixture_id TEXT,
  status          TEXT NOT NULL CHECK (status IN ('QUEUED','PROCESSING','COMPLETED','FAILED','DUPLICATE')),
  error           TEXT,
  submitted_at    TEXT NOT NULL,
  completed_at    TEXT
);
-- AUTOINCREMENT: SQLite would otherwise reuse max(rowid)+1, so the job the golden reset just deleted could get
-- the SAME id as the new one and the "new job id != previous job id" proof would be false.
CREATE TABLE IF NOT EXISTS extraction_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id     TEXT NOT NULL REFERENCES documents(document_id),
  source_hash     TEXT NOT NULL,
  engine          TEXT NOT NULL CHECK (engine IN ('native','tesseract','cache')),
  mean_confidence REAL,
  started_at      TEXT NOT NULL,
  completed_at    TEXT
);
-- Extraction cache keyed by file hash. Production-style optimisation that the golden
-- reset MUST clear, otherwise a "fresh" run can silently reuse yesterday's OCR output.
CREATE TABLE IF NOT EXISTS extraction_cache (
  source_hash     TEXT PRIMARY KEY,
  text            TEXT NOT NULL,
  engine          TEXT NOT NULL,
  mean_confidence REAL,
  created_at      TEXT NOT NULL
);
-- source_hash is UNIQUE: the database itself guarantees the same PDF can never be stored as two invoices.
-- amount_cents is a whole number of cents so totals never suffer from decimal rounding.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  document_id     TEXT NOT NULL UNIQUE REFERENCES documents(document_id),
  test_fixture_id TEXT,
  customer_name   TEXT NOT NULL,
  account_number  TEXT NOT NULL,
  invoice_date    TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('Paid','Unpaid','Overdue')),
  source_file     TEXT NOT NULL,
  source_hash     TEXT NOT NULL UNIQUE,
  extraction_job_id INTEGER NOT NULL REFERENCES extraction_jobs(id),
  processed_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id INTEGER PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id),
  position     INTEGER NOT NULL,
  description  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invoice_audit (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  note TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processing_runs (
  id INTEGER PRIMARY KEY, started_at TEXT NOT NULL,
  submitted INTEGER NOT NULL, inserted INTEGER NOT NULL, duplicates INTEGER NOT NULL, rejected INTEGER NOT NULL,
  inserted_amount_cents INTEGER NOT NULL
);`;

// Current time as a standard text timestamp (e.g. 2026-08-30T14:05:00.000Z) - used for every date column above.
export const now = () => new Date().toISOString();

// Test-only switch: deliberately crash half-way through a save to prove the transaction undoes everything.
export interface InsertOpts { failAfterInvoiceInsert?: boolean; }

/** Transactional insert of invoice + children. Returns 'inserted' | 'duplicate'. */
// Save one validated invoice. Business rules:
//  1. If an invoice with the same file fingerprint already exists, do nothing and report 'duplicate' -
//     re-submitting the same PDF must never double-count revenue.
//  2. The invoice header, all its line items and the audit note are written inside ONE transaction. If anything
//     fails part-way, the database is left exactly as it was - no orphaned header without its lines.
export function insertInvoice(db: DB, inv: Invoice, meta: { documentId: string; sourceFile: string; sourceHash: string; fixtureId?: string | null; jobId: number }, opts: InsertOpts = {}) {
  if (db.prepare('SELECT 1 FROM invoices WHERE source_hash = ?').get(meta.sourceHash)) return 'duplicate' as const;
  db.transaction(() => {
    // Step 1: the invoice header row.
    const r = db.prepare(`INSERT INTO invoices (document_id, test_fixture_id, customer_name, account_number, invoice_date, amount_cents, status, source_file, source_hash, extraction_job_id, processed_at)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(meta.documentId, meta.fixtureId ?? null, inv.customerName, inv.accountNumber, inv.invoiceDate, inv.amountCents, inv.status, meta.sourceFile, meta.sourceHash, meta.jobId, now());
    // Test hook: simulate a crash here to verify the header above gets rolled back too.
    if (opts.failAfterInvoiceInsert) throw new Error('simulated failure after invoice insert');
    // Step 2: every line item, linked to the header just created.
    const li = db.prepare('INSERT INTO invoice_line_items (invoice_id, position, description, amount_cents) VALUES (?,?,?,?)');
    for (const l of inv.lineItems) li.run(r.lastInsertRowid, l.position, l.description, l.amountCents);
    // Step 3: a plain-English audit note so anyone can later see which file this invoice came from.
    db.prepare('INSERT INTO invoice_audit (invoice_id, note) VALUES (?, ?)').run(r.lastInsertRowid, `ingested from ${meta.sourceFile}`);
  })();
  return 'inserted' as const;
}

// Record that we started reading text from a document, noting which method was used and how confident the
// OCR was. Returns the new job's id so the invoice can later be linked back to exactly this reading attempt.
export function startJob(db: DB, documentId: string, sourceHash: string, engine: Engine, meanConfidence: number | null) {
  return Number(db.prepare('INSERT INTO extraction_jobs (document_id, source_hash, engine, mean_confidence, started_at) VALUES (?,?,?,?,?)')
    .run(documentId, sourceHash, engine, meanConfidence, now()).lastInsertRowid);
}
// Stamp the job as finished. Called on both success and failure so no job is left looking "still running".
export const finishJob = (db: DB, id: number) => db.prepare('UPDATE extraction_jobs SET completed_at = ? WHERE id = ?').run(now(), id);
