/**
 * WHAT THIS FILE DOES
 *
 * Finds the production database record that belongs to the PDF being validated. It opens the database with a
 * read-only connection: the validator only inspects what production stored and can never change, delete or
 * reprocess a customer's record, even by accident. The lookup is by the file's SHA-256 fingerprint (see hash.ts),
 * which is the only identifier strong enough to say "this exact file". Exactly one hash match means we proceed;
 * zero means REVIEW (record identification may be incomplete, which is not proof ingestion failed); more than one is
 * a defect, because the pipeline is supposed to store each file once. A filename match is reported only as a weak
 * candidate for the tester's information and is never used to proceed on its own. Also fetches the record's line items.
 */
import Database from 'better-sqlite3';

/** The shape of one row in the production `invoices` table, as stored by the ingestion pipeline. */
export interface DbInvoice { id: number; document_id: string; customer_name: string; account_number: string; invoice_date: string; amount_cents: number; status: string; source_hash: string; source_file: string; processed_at: string; }

/** Read-only connection. The random validator never writes. */
// `readonly` makes any write attempt an error at the database layer; `fileMustExist` stops a typo in the path silently creating an empty database.
export const openReadOnly = (path: string) => new Database(path, { readonly: true, fileMustExist: true });

/** Find candidate records for a PDF. Hash first; filename is reported as a weaker secondary signal only. */
// Returns every candidate with the reason it matched, plus `confident`: the single row to proceed with, or null when there is none or more than one.
export function locate(db: Database.Database, hash: string, filename: string) {
  const byHash = db.prepare('SELECT * FROM invoices WHERE source_hash = ?').all(hash) as DbInvoice[];
  // Only look at filenames when the hash found nothing, so a weak match is never listed alongside a strong one.
  const byName = byHash.length ? [] : db.prepare('SELECT * FROM invoices WHERE source_file = ?').all(filename) as DbInvoice[];
  return {
    candidates: [...byHash.map(r => ({ row: r, matchedBy: 'source_hash' })), ...byName.map(r => ({ row: r, matchedBy: 'filename (weak)' }))],
    confident: byHash.length === 1 ? byHash[0] : null,
  };
}

/** The stored line items for one invoice, in their stored order. Order is informational only: matching is by content, never by position. */
export const lineItems = (db: Database.Database, invoiceId: number) =>
  db.prepare('SELECT position, description, amount_cents FROM invoice_line_items WHERE invoice_id = ? ORDER BY position').all(invoiceId) as { position: number; description: string; amount_cents: number }[];
