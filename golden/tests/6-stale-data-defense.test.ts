/**
 * WHAT THIS TEST FILE PROVES
 *
 * Level covered: the RESET stage ("checkpoint 0") that every Level 5 golden test runs first, tested on its own.
 * It uses its own persistent test database file plus the sample app's API, so it can deliberately plant
 * "yesterday's" data and show what happens with and without the reset.
 *
 * The problem being defended against: the golden suite looks up invoice rows to check them. If a row from an
 * earlier run is still in the database, a test could find that OLD row, see the right values, and report PASS —
 * even though today's processing silently failed. That is a false positive, and it is the single most dangerous
 * failure mode for this kind of test, because it makes a broken pipeline look healthy.
 *
 * What "pass" means in business terms: before each golden test, all traces of the fixture (invoice, line items,
 * audit note, document, extraction job, and cached OCR text) are deleted and PROVEN gone; if that cannot be done
 * the suite refuses to continue; and we demonstrate concretely that skipping the reset would produce a false pass.
 *
 * Production bug this would catch: a processing failure in a new build that goes unnoticed because the test
 * database still holds last week's correct rows; or a "fresh scan" that is really a cached result from before
 * an OCR change.
 *
 * Terms used below:
 *   - source hash: a SHA-256 fingerprint of the PDF's bytes; identical files always share the same fingerprint.
 *   - extraction cache: a shortcut table where the app stores OCR text by file fingerprint, so a repeat of the
 *     same file can skip OCR. Great in production; dangerous for a test that wants to prove OCR still works.
 *
 * Test-plan cases referenced: GPDF 001, GPDF 002, GPDF 017.
 *
 * (Original header: Proves the reset stage does what the false-positive scenario requires. Uses its own persistent test DB file.)
 */
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { openDb, DB, startJob } from '../../app/db';
import { startServer } from '../../app/server';
import { loadGolden } from '../src/fixtures';
import { resetGoldenFixture, countGoldenRows } from '../src/cleanup';
import { submitPdf, waitForDocument } from '../src/ingestion-client';
import { SqliteGoldenDb } from '../src/golden-db';

const DB_PATH = join(__dirname, '..', '..', '.data', 'stale-defense-test.sqlite');
// Two fixtures: a native PDF for most tests, and a scanned one for the OCR-cache test.
const g = loadGolden().find(x => x.fixtureId === 'GOLDEN-INV-001')!;
const scanned = loadGolden().find(x => x.fixtureId === 'GOLDEN-INV-101')!;
let db: DB, gdb: SqliteGoldenDb, api: { url: string; close: () => Promise<void> };

/** Simulate "yesterday's run": a completed row for the fixture, written directly. */
// The planted row carries the fixture's REAL account number and fingerprint (so a naive lookup would find it)
// but an obviously wrong customer name ("STALE VALUE") so we can tell it apart from a genuine result.
function seedOldGoldenRecord(fx = g) {
  db.prepare("INSERT INTO documents (document_id, filename, source_hash, test_fixture_id, status, submitted_at, completed_at) VALUES ('DOC-OLD','old.pdf',?,?,'COMPLETED','2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z')").run(fx.sourceHash, fx.fixtureId);
  const jobId = startJob(db, 'DOC-OLD', fx.sourceHash, 'native', null);
  db.prepare(`INSERT INTO invoices (document_id, test_fixture_id, customer_name, account_number, invoice_date, amount_cents, status, source_file, source_hash, extraction_job_id, processed_at)
              VALUES ('DOC-OLD', ?, 'STALE VALUE', ?, '2020-01-01', 1, 'Paid', 'old.pdf', ?, ?, '2026-01-01T00:00:01.000Z')`).run(fx.fixtureId, fx.expected!.accountNumber, fx.sourceHash, jobId);
  return jobId;
}

// Start from an empty database file and run the sample app's API against it.
beforeAll(async () => {
  // env guard flags come from the npm script / CI, never from the test itself
  mkdirSync(join(DB_PATH, '..'), { recursive: true }); rmSync(DB_PATH, { force: true });
  gdb = new SqliteGoldenDb(DB_PATH); db = gdb.raw; api = await startServer(db);
});
afterAll(async () => { await api.close(); db.close(); });
// Every test begins with the main fixture fully reset.
beforeEach(() => resetGoldenFixture(gdb, DB_PATH, g.fixtureId, g.sourceHash));

describe('Checkpoint 0 — stale data defense', () => {
  // GPDF-001 (Delete Existing Golden Record).
  // Scenario: an old completed row for the fixture exists; we run the reset.
  // Expected: the reset reports it saw 1 row before, and 0 rows in every one of the six related tables after.
  // Why: the reset must remove EVERYTHING tied to the fixture, and must be able to prove it did.
  test('GPDF-001: reset removes a pre-existing golden row and verifies zero remain', () => {
    seedOldGoldenRecord();
    expect(countGoldenRows(gdb, g.fixtureId, g.sourceHash).invoices).toBe(1);
    const rep = resetGoldenFixture(gdb, DB_PATH, g.fixtureId, g.sourceHash);
    expect(rep.before.invoices).toBe(1);
    expect(Object.values(rep.after)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  // GPDF-017 (Processing Failure Does Not Reuse Old Data).
  // Scenario: an old row exists; we reset; then we upload the PDF with a switch that FORCES processing to fail.
  // Expected: the upload is marked FAILED and a lookup by fixture id or by account number finds NOTHING.
  // Why: this is the honest outcome — today's failure is visible, because no old row is left to be mistaken for success.
  test('GPDF-017: old golden data cannot hide a failed current scan', async () => {
    seedOldGoldenRecord();
    resetGoldenFixture(gdb, DB_PATH, g.fixtureId, g.sourceHash);
    expect(countGoldenRows(gdb, g.fixtureId, g.sourceHash).invoices).toBe(0);

    const id = await submitPdf(api.url, g.pdf, 'GOLDEN-INV-001.pdf', { fixtureId: g.fixtureId, forceFail: true });
    const st = await waitForDocument(api.url, id);
    expect(st.status).toBe('FAILED');
    // The lookup a naive test would do finds NOTHING — no stale row to pass on.
    expect(db.prepare('SELECT COUNT(*) c FROM invoices WHERE test_fixture_id = ?').get(g.fixtureId)).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM invoices WHERE account_number = ?').get(g.expected!.accountNumber)).toEqual({ c: 0 });
  });

  // GPDF-017, the counter-example.
  // Scenario: same as above but WITHOUT the reset — old row planted, processing forced to fail.
  // Expected: a naive lookup by fixture id still finds a row — yesterday's "STALE VALUE" row.
  // Why: this proves the danger is real, not theoretical: skip checkpoint 0 and a broken pipeline passes.
  test('without the reset, a stale row WOULD produce a false pass (demonstrates why checkpoint 0 exists)', async () => {
    seedOldGoldenRecord();
    const id = await submitPdf(api.url, g.pdf, 'GOLDEN-INV-001.pdf', { fixtureId: g.fixtureId, forceFail: true });
    expect((await waitForDocument(api.url, id)).status).toBe('FAILED');
    const naive = db.prepare('SELECT customer_name FROM invoices WHERE test_fixture_id = ?').get(g.fixtureId) as any;
    expect(naive.customer_name).toBe('STALE VALUE');   // a row exists — but it is yesterday's
  });

  // GPDF-017, extraction-cache variant.
  // Scenario: a scanned PDF is processed once (which fills the OCR cache). We then delete only the visible result rows —
  // what a naive cleanup does — but leave the cache, and upload again.
  // Expected: the second run reports engine "cache", i.e. NO OCR actually happened. After a FULL reset (which clears
  // the cache), a third upload really runs tesseract.
  // Why: a test that believes it re-OCR'd a file when it merely replayed old text cannot detect an OCR regression.
  test('extraction cache: without clearing it, a "fresh" run silently reuses old OCR output', async () => {
    resetGoldenFixture(gdb, DB_PATH, scanned.fixtureId, scanned.sourceHash);
    // poison the cache the way a stale environment would — but with the right text so the insert succeeds
    const first = await submitPdf(api.url, scanned.pdf, 'x.pdf', { fixtureId: scanned.fixtureId });
    await waitForDocument(api.url, first);
    // delete only the final rows (what a naive cleanup does) and leave the cache
    db.transaction(() => {
      db.prepare('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE source_hash = ?)').run(scanned.sourceHash);
      db.prepare('DELETE FROM invoice_audit WHERE invoice_id IN (SELECT id FROM invoices WHERE source_hash = ?)').run(scanned.sourceHash);
      db.prepare('DELETE FROM invoices WHERE source_hash = ?').run(scanned.sourceHash);
      db.prepare('DELETE FROM extraction_jobs WHERE source_hash = ?').run(scanned.sourceHash);
      db.prepare('DELETE FROM documents WHERE source_hash = ?').run(scanned.sourceHash);
    })();   // note: extraction_cache deliberately NOT cleared
    // Second upload: looks fresh, but the engine column reveals it was served from cache.
    const second = await submitPdf(api.url, scanned.pdf, 'x.pdf', { fixtureId: scanned.fixtureId });
    await waitForDocument(api.url, second);
    const job = db.prepare('SELECT engine FROM extraction_jobs WHERE document_id = ?').get(second) as any;
    expect(job.engine).toBe('cache');   // no OCR happened — exactly the false "fresh scan" the plan warns about

    // full reset clears the cache, and the next run really OCRs
    resetGoldenFixture(gdb, DB_PATH, scanned.fixtureId, scanned.sourceHash);
    const third = await submitPdf(api.url, scanned.pdf, 'x.pdf', { fixtureId: scanned.fixtureId });
    await waitForDocument(api.url, third);
    expect((db.prepare('SELECT engine FROM extraction_jobs WHERE document_id = ?').get(third) as any).engine).toBe('tesseract');
  });

  // GPDF-002 (Fail When Cleanup Does Not Complete).
  // Scenario: an old row exists and the reset is attempted through a read-only database connection (so deleting is impossible).
  // Expected: the reset throws an error — and the old row is still there, proving nothing was uploaded or processed.
  // Why: if cleanup cannot be confirmed, continuing would risk exactly the false pass shown above; stopping is the only safe move.
  test('GPDF-002: if cleanup cannot complete, the suite refuses to proceed', () => {
    seedOldGoldenRecord();
    const ro = new SqliteGoldenDb(DB_PATH, { readonly: true });
    try { expect(() => resetGoldenFixture(ro, DB_PATH, g.fixtureId, g.sourceHash)).toThrow(/readonly|attempt to write/i); }
    finally { ro.close(); }
    expect(countGoldenRows(gdb, g.fixtureId, g.sourceHash).invoices).toBe(1); // still there; nothing was submitted
  });

  // Scenario: two invoices for the SAME account number exist (an old fixture row and a different February invoice).
  // Expected: searching by account number returns 2 rows (ambiguous); searching by document id returns exactly 1.
  // Why: this justifies the suite's design — golden tests look rows up by the document id returned from THIS upload,
  // never by a business field like account number that legitimately repeats across invoices.
  test('lookup by account_number is ambiguous; lookup by document_id is not', async () => {
    seedOldGoldenRecord();                       // an OLD invoice for the same account exists (not reset on purpose)
    db.prepare("INSERT INTO documents (document_id, filename, source_hash, status, submitted_at) VALUES ('DOC-OTHER','o.pdf','other-hash','COMPLETED','2026-02-01')").run();
    const j = startJob(db, 'DOC-OTHER', 'other-hash', 'native', null);
    db.prepare(`INSERT INTO invoices (document_id, customer_name, account_number, invoice_date, amount_cents, status, source_file, source_hash, extraction_job_id, processed_at)
                VALUES ('DOC-OTHER','Same Account Feb', ?, '2026-02-01', 999, 'Paid', 'o.pdf', 'other-hash', ?, '2026-02-01T00:00:00.000Z')`).run(g.expected!.accountNumber, j);
    expect((db.prepare('SELECT COUNT(*) c FROM invoices WHERE account_number = ?').get(g.expected!.accountNumber) as any).c).toBe(2);
    expect((db.prepare('SELECT COUNT(*) c FROM invoices WHERE document_id = ?').get('DOC-OLD') as any).c).toBe(1);
  });
});
