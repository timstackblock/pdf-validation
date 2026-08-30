/**
 * WHAT THIS FILE DOES
 *
 * This file is the golden suite's only doorway to the database. It defines a short list of questions
 * the suite needs answered ("how many rows exist for this fixture?", "delete them all", "give me the
 * invoice for this document id") as an interface called GoldenDb, and ships one implementation of it
 * for the SQLite database used by the sample app. Inputs: a database file path or connection; fixture
 * ids and PDF hashes. Outputs: row counts, invoice/job/line-item rows, and the side effect of deleting
 * a fixture's rows. Risk protected against: the tests being tied to one database product, and cleanup
 * missing a table (a leftover extraction cache entry, for example, would let the system skip the real
 * scan and silently reuse yesterday's text). Pointing the suite at a real Postgres/MySQL test database
 * means writing one more "adapter" (a small class that answers these same questions for that database).
 *
 * Level 5 and checkpoint 0 talk to the test database ONLY through this interface, so pointing the suite
 * at the real test database means writing one adapter (Postgres, MySQL, SQL Server…) that answers these
 * questions about your tables — parent, children, staging, extraction jobs, extraction cache — and
 * nothing else in golden/ changes.
 *
 * `SqliteGoldenDb` is the adapter for the sample app/ shipped with this repo.
 */
import Database from 'better-sqlite3';
import { openDb, DB } from '../../app/db';

// Row counts per table for one fixture: staging documents, invoices (parent), line items and audit
// notes (children), extraction jobs, and extraction-cache entries. All six must be zero before a submit.
export interface Counts { documents: number; invoices: number; lineItems: number; audit: number; jobs: number; cache: number; }
// One stored invoice as the database holds it: the values the golden expectations are compared against,
// plus bookkeeping (which document and extraction job produced it, and when it was processed).
export interface InvoiceRow {
  id: number; document_id: string; test_fixture_id: string | null; customer_name: string; account_number: string; invoice_date: string;
  amount_cents: number; status: string; source_file: string; source_hash: string; extraction_job_id: number; processed_at: string;
}
/** All timestamps returned by an adapter MUST be ISO-8601 strings parseable by Date.parse (the tests compare instants, not strings). */
// (ISO-8601 is the standard "2026-08-30T14:05:00Z" date-time format.) A JobRow records one extraction
// attempt: which document and file it was for, which engine did the reading (native text, OCR, or cache),
// how confident the OCR was, and when it started and finished.
export interface JobRow { id: number; document_id: string; source_hash: string; engine: string; mean_confidence: number | null; started_at: string; completed_at: string | null; }
// One stored invoice line item.
export interface LineItemRow { position: number; description: string; amount_cents: number; }

// The contract every database adapter must fulfil. The tests only ever call these methods.
export interface GoldenDb {
  /** Human-readable, credential-free description for the evidence report (e.g. "sqlite:.data/golden-test.sqlite"). */
  describe(): string;
  /**
   * Credential-level protection (README §"Environment safety"). The env guard is a string check; this is the
   * place to prove the connection itself cannot reach anything but the QA schema — e.g. `SELECT current_user`
   * and assert it is the restricted golden role, or probe a production table and assert permission denied.
   * Throw to refuse the run.
   */
  verifyRestrictedAccess(): void;

  // How many rows, per table, currently belong to this fixture (by fixture id or file hash).
  countGoldenRows(fixtureId: string, sourceHash: string): Counts;
  // The newest extraction-job id ever recorded for this file, or null; used to prove a NEW job ran later.
  previousJobId(sourceHash: string): number | null;
  /** Delete every row a previous run left for this fixture, children first, in ONE transaction. */
  deleteGoldenRows(fixtureId: string, sourceHash: string): void;

  // Lookups used during verification. Always by document id — never by account number, which can be
  // shared across customers and runs and would make the lookup ambiguous.
  invoiceByDocumentId(documentId: string): InvoiceRow | undefined;
  extractionJob(id: number): JobRow | undefined;
  lineItems(invoiceId: number): LineItemRow[];
  auditNotes(invoiceId: number): string[];
  // Release the connection at the end of the run.
  close(): void;
}

// The adapter for the sample app's SQLite database. Each method below is one question from the
// interface answered with a SQL query against the sample app's tables.
export class SqliteGoldenDb implements GoldenDb {
  readonly raw: DB;
  // Opens the SQLite file at `path` (optionally read-only, which level 6 uses to prove cleanup refuses to continue).
  constructor(readonly path: string, opts: { readonly?: boolean } = {}) { this.raw = openDb(path, opts); }
  // Wraps an already-open connection (used by tests that share one in-memory database with the app).
  static wrap(raw: DB, path: string) { const o = Object.create(SqliteGoldenDb.prototype) as SqliteGoldenDb; (o as any).raw = raw; (o as any).path = path; return o; }

  describe() { return `sqlite:${this.path}`; }
  verifyRestrictedAccess() {
    // SQLite has no users or grants, so the only credential-level check available is that the handle is not
    // in-memory (which the env guard already refuses) and not shared with a production file. Real adapters
    // MUST replace this with a role/grant check — see the interface doc.
    if (this.raw.name === '' || this.raw.name === ':memory:') throw new Error('golden db must be a file, not :memory:');
  }

  // Small helper: run a COUNT query and return the number.
  private n(sql: string, ...p: unknown[]) { return (this.raw.prepare(sql).get(...p) as any).c as number; }
  countGoldenRows(fixtureId: string, sourceHash: string): Counts {
    // Every table is matched on fixture id OR file hash, so a row that lost its fixture tag is still counted.
    const inv = 'SELECT id FROM invoices WHERE test_fixture_id = ? OR source_hash = ?';
    return {
      documents: this.n('SELECT COUNT(*) c FROM documents WHERE test_fixture_id = ? OR source_hash = ?', fixtureId, sourceHash),
      invoices:  this.n('SELECT COUNT(*) c FROM invoices WHERE test_fixture_id = ? OR source_hash = ?', fixtureId, sourceHash),
      lineItems: this.n(`SELECT COUNT(*) c FROM invoice_line_items WHERE invoice_id IN (${inv})`, fixtureId, sourceHash),
      audit:     this.n(`SELECT COUNT(*) c FROM invoice_audit WHERE invoice_id IN (${inv})`, fixtureId, sourceHash),
      jobs:      this.n('SELECT COUNT(*) c FROM extraction_jobs WHERE source_hash = ? OR document_id IN (SELECT document_id FROM documents WHERE test_fixture_id = ? OR source_hash = ?)', sourceHash, fixtureId, sourceHash),
      cache:     this.n('SELECT COUNT(*) c FROM extraction_cache WHERE source_hash = ?', sourceHash),
    };
  }
  previousJobId(sourceHash: string) {
    return (this.raw.prepare('SELECT MAX(id) id FROM extraction_jobs WHERE source_hash = ?').get(sourceHash) as any).id ?? null;
  }
  deleteGoldenRows(fixtureId: string, sourceHash: string) {
    const db = this.raw;
    // A transaction: either every delete below succeeds, or none of them do. Children (line items, audit)
    // go first because the database will not allow a parent invoice to be removed while children point at it.
    db.transaction(() => {
      const inv = 'SELECT id FROM invoices WHERE test_fixture_id = ? OR source_hash = ?';
      db.prepare(`DELETE FROM invoice_line_items WHERE invoice_id IN (${inv})`).run(fixtureId, sourceHash);
      db.prepare(`DELETE FROM invoice_audit WHERE invoice_id IN (${inv})`).run(fixtureId, sourceHash);
      db.prepare('DELETE FROM invoices WHERE test_fixture_id = ? OR source_hash = ?').run(fixtureId, sourceHash);
      // jobs of documents registered under this fixture id too — a regenerated PDF (new hash) leaves old-hash jobs
      // hanging off the old documents row, and the FK would otherwise make the documents delete fail forever
      const docs = 'SELECT document_id FROM documents WHERE test_fixture_id = ? OR source_hash = ?';
      db.prepare(`DELETE FROM extraction_jobs WHERE source_hash = ? OR document_id IN (${docs})`).run(sourceHash, fixtureId, sourceHash);
      // The extraction cache MUST be cleared: a cached result would let the next run skip the real scan entirely.
      db.prepare(`DELETE FROM extraction_cache WHERE source_hash = ? OR source_hash IN (SELECT source_hash FROM documents WHERE test_fixture_id = ?)`).run(sourceHash, fixtureId);
      // The staging row goes last, once nothing else refers to it.
      db.prepare('DELETE FROM documents WHERE test_fixture_id = ? OR source_hash = ?').run(fixtureId, sourceHash);
    })();
  }
  // Verification lookups (see the interface above for why these are by document id).
  invoiceByDocumentId(documentId: string) { return this.raw.prepare('SELECT * FROM invoices WHERE document_id = ?').get(documentId) as InvoiceRow | undefined; }
  extractionJob(id: number) { return this.raw.prepare('SELECT * FROM extraction_jobs WHERE id = ?').get(id) as JobRow | undefined; }
  lineItems(invoiceId: number) {
    // Ordered by position so they can be compared one-for-one with the expected list.
    return this.raw.prepare('SELECT position, description, amount_cents FROM invoice_line_items WHERE invoice_id = ? ORDER BY position').all(invoiceId) as LineItemRow[];
  }
  auditNotes(invoiceId: number) { return (this.raw.prepare('SELECT note FROM invoice_audit WHERE invoice_id = ? ORDER BY id').all(invoiceId) as any[]).map(r => r.note as string); }
  close() { this.raw.close(); }
}

export type { Database };
