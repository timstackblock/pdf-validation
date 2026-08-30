/**
 * WHAT THIS TEST FILE PROVES
 *
 * Level covered: Level 5 — the top of the pyramid. This is the GOLDEN SYSTEM TEST: it uses the product the way
 * a customer would (upload a PDF through the web API, wait for processing to finish) and then checks the
 * database the way an auditor would. It is the test that answers "does the deployed system produce the right
 * invoice records from these known PDFs, right now, on this build?"
 *
 * What "pass" means in business terms: for every approved sample PDF, a brand-new processing run happened
 * during THIS test (not a leftover from yesterday, not a cached answer), and every stored field, every line item
 * and the audit note match the hand-verified golden values exactly. Bad PDFs are refused for the right reason and
 * leave no rows. A written evidence report proves it, naming the build and environment tested.
 *
 * Production bug this would catch: any regression anywhere in the deployed path (API, queue, worker, OCR,
 * database) — and, critically, the "false positive" trap where an old row left in the database makes a broken
 * pipeline look healthy.
 *
 * Terms used below:
 *   - fixture / golden fixture: an approved sample PDF plus a JSON file of the exact values it must produce.
 *   - source hash: a SHA-256 fingerprint of the PDF's bytes — identical files always share the same fingerprint.
 *   - extraction job: the database record of one attempt to read a PDF (which engine, when it started/finished).
 *
 * Test-plan cases referenced: GPDF 001 (checkpoint 0), 003, 004, 005, 006-009 (FAILED fixtures), 010, 011,
 * 012 (duplicate via API), 013-016.
 *
 * ---- Original header (design notes) ----
 * LEVEL 5 — GOLDEN SYSTEM TEST
 *
 * Enters the system under test through its HTTP API only and verifies through the GoldenDb adapter only.
 * Which system that is comes from the environment (see src/system-under-test.ts):
 *   local  (default)          the sample app/ + persistent .data/golden-test.sqlite
 *   remote (PDF_INGEST_API_URL) the deployed test-environment API, its real queue/worker/OCR, and the real test DB
 *
 * For every fixture:
 *   0. reset: delete rows/jobs/cache left by earlier runs, verify zero remain (refuse to continue otherwise)
 *   1. submit via POST /documents, capture documentId + submission timestamp
 *   2. poll until the async worker finishes, capture completion timestamp
 *   3. prove a NEW extraction job ran: new id, started after the test started, right engine,
 *      AND it references THIS document_id and THIS PDF's hash
 *   4. prove the row belongs to THIS run (processed_at >= test start, document_id match)
 *   5. compare every field, every line item (position, description, amount) and the audit trail vs the golden JSON
 *   6. write evidence to reports/ — every attempted fixture appears, even ones that died mid-flight
 */
import { join } from 'path';
import { loadGolden, GoldenFixture } from '../src/fixtures';
import { resetGoldenFixture, isClean } from '../src/cleanup';
import { submitPdf, waitForDocument } from '../src/ingestion-client';
import { writeGoldenReport, FixtureResult, FieldCheck } from '../src/report';
import { connectSystemUnderTest, SystemUnderTest, detectGitCommit } from '../src/system-under-test';

// Where the evidence report goes, and a unique id + start time for this run (both appear in the report).
const REPORT_DIR = join(__dirname, '..', '..', 'reports');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runStartedAt = new Date().toISOString();

let sut: SystemUnderTest;
const results: FixtureResult[] = [];

// NODE_ENV=test and ALLOW_GOLDEN_DB_RESET=true are deliberately NOT set here: they come from the npm script / CI
// configuration, so the env guard is a real gate rather than one the test switches off for itself.
beforeAll(async () => { sut = await connectSystemUnderTest(); });
// After all fixtures: disconnect, then ALWAYS write the evidence report (even if disconnecting failed).
afterAll(async () => {
  try { await sut?.close(); }
  finally {   // the evidence report is written even if shutting down the system under test fails
    const s = writeGoldenReport(REPORT_DIR, { runId, startedAt: runStartedAt, environment: sut?.environment ?? 'unknown', mode: sut?.mode ?? 'unknown',
      gitCommit: detectGitCommit(), apiUrl: sut?.apiUrl ?? 'n/a', database: sut?.db.describe() ?? 'n/a' }, results);
    console.log(`golden report: reports/golden-${runId}.txt — ${s.passed}/${s.fixtures} passed (${s.environment}, ${s.gitCommit})`);
  }
});

// Timestamps are compared as instants (milliseconds), so different text formats from different databases still compare correctly.
const isoMs = (s: string) => { const t = Date.parse(s); if (Number.isNaN(t)) throw new Error(`adapter returned a non-ISO timestamp: "${s}"`); return t; };
/** A rejection only counts as the application's decision when it is a validation error, never an infrastructure one. */
const VALIDATION_REJECTION = /^(customerName|accountNumber|invoiceDate|amount|status|lineItems(\[\d+\]\.amount)?): /;
const INFRA_FAILURE = /pdftoppm|tesseract|convert|magick|ENOENT|no pages rendered|traineddata|ImageMagick not found|orientation detection unavailable/i;   // 'Unreadable PDF' is a legitimate rejection (GOLDEN-BAD-206)

// Scanned PDFs must be processed by real OCR (tesseract); native PDFs by the direct text reader.
const expectedEngine = (g: GoldenFixture) => g.kind === 'scanned' ? 'tesseract' : 'native';

// One test per golden fixture — good invoices (native, scanned, rotated, multi-page) AND deliberately bad ones.
describe.each(loadGolden())('$fixtureId', (g: GoldenFixture) => {
  // Scenario: wipe any old data for this fixture, upload the PDF through the API exactly as a customer would,
  // wait for the background worker, then check the database.
  // Expected: for a good fixture — exactly one NEW invoice row, produced by a NEW extraction job during this test,
  // matching the golden values field-for-field. For a bad fixture — status FAILED for an application reason, zero rows.
  // Why: this is the end-to-end proof that the deployed build handles known invoices correctly today.
  // Covers GPDF-001 (checkpoint 0), GPDF-003, GPDF-004, GPDF-010, GPDF-011, and GPDF-005/006/007/008/009/013/014/015/016 via fixtures.
  test(`fresh scan + insert matches golden (${g.kind}, expect ${g.expectedOutcome})`, async () => {
    // The evidence record exists from the first moment, so a crash in cleanup/submit/poll is still reported.
    const r: FixtureResult = { fixtureId: g.fixtureId, pdf: `${g.fixtureId}.pdf`, sourceHash: g.sourceHash, kind: g.kind, expectedOutcome: g.expectedOutcome,
      allowRejection: g.allowRejection, fields: [], result: 'FAIL' };
    results.push(r);
    const db = sut.db;

    try {
      // CHECKPOINT 0 — reset & verify (GPDF-001): delete yesterday's rows for this fixture and PROVE none remain.
      // If cleanup cannot be verified the test stops here, before uploading anything (GPDF-002).
      r.failedStep = 'cleanup';
      const cleanup = resetGoldenFixture(db, sut.dbTarget, g.fixtureId, g.sourceHash);
      r.cleanup = cleanup;
      expect(isClean(cleanup.after)).toBe(true);

      // CHECKPOINT 1 — submit through the API, noting the time so we can later prove the work happened after this moment.
      r.failedStep = 'submit';
      const testStartedAt = new Date().toISOString();
      r.documentId = await submitPdf(sut.apiUrl, g.pdf, `${g.fixtureId}.pdf`, { fixtureId: g.fixtureId });

      // CHECKPOINT 2 — wait for the (real or simulated) queue + worker
      r.failedStep = 'processing';
      const status = await waitForDocument(sut.apiUrl, r.documentId, sut.timeoutMs);
      r.submittedAt = status.submitted_at; r.completedAt = status.completed_at ?? undefined; r.finalStatus = status.status; r.error = status.error;

      // Verify — first the "bad fixture" path: expected to FAIL, for an application reason, with nothing stored.
      r.failedStep = 'verify';
      const counts = db.countGoldenRows(g.fixtureId, g.sourceHash);
      if (g.expectedOutcome === 'FAILED' || (g.allowRejection && status.status === 'FAILED')) {
        expect(status.status).toBe('FAILED');
        expect(status.error ?? '').not.toMatch(INFRA_FAILURE);                 // a missing OCR binary is not a pass
        if (g.allowRejection) expect(status.error ?? '').toMatch(VALIDATION_REJECTION);
        expect(counts.invoices).toBe(0); expect(counts.lineItems).toBe(0); expect(counts.audit).toBe(0);
        r.failedStep = undefined; r.result = 'PASS'; return;
      }

      // Good fixture path: processing completed and there is exactly one invoice row for this fixture.
      expect(status.status).toBe('COMPLETED');
      expect(counts.invoices).toBe(1);           // exactly one — never a second row from a duplicate/old run

      // CHECKPOINT 3 — the row for THIS documentId, belonging to THIS run (GPDF-003: processed after the test started)
      const row = db.invoiceByDocumentId(r.documentId);
      expect(row).toBeDefined();
      r.processedAt = row!.processed_at; r.rowBelongsToRun = isoMs(row!.processed_at) >= isoMs(testStartedAt);
      expect(r.rowBelongsToRun).toBe(true);
      expect(row!.test_fixture_id).toBe(g.fixtureId);

      // fresh extraction job — not cached, not yesterday's, and provably for THIS document and THIS file
      const job = db.extractionJob(row!.extraction_job_id);
      expect(job).toBeDefined();
      r.extraction = { jobId: job!.id, previousJobId: cleanup.previousJobId, engine: job!.engine, meanConfidence: job!.mean_confidence,
        startedAt: job!.started_at, completedAt: job!.completed_at,
        freshJob: job!.id !== cleanup.previousJobId && isoMs(job!.started_at) >= isoMs(testStartedAt),
        belongsToDocument: job!.document_id === r.documentId, matchesSourceHash: job!.source_hash === g.sourceHash };
      expect(r.extraction.freshJob).toBe(true);
      expect(r.extraction.belongsToDocument).toBe(true);
      expect(r.extraction.matchesSourceHash).toBe(true);
      expect(job!.engine).toBe(expectedEngine(g));
      expect(job!.completed_at).not.toBeNull();

      // CHECKPOINT 4 — field-by-field vs hand-verified golden (GPDF-004; strict equality, no rounding or trimming)
      const e = g.expected!;
      const checks: FieldCheck[] = [
        ['customer_name', e.customerName, row!.customer_name], ['account_number', e.accountNumber, row!.account_number],
        ['invoice_date', e.invoiceDate, row!.invoice_date], ['amount_cents', e.amountCents, row!.amount_cents], ['status', e.status, row!.status],
        ['source_hash', g.sourceHash, row!.source_hash], ['source_file', `${g.fixtureId}.pdf`, row!.source_file],
      ].map(([field, expected, actual]) => ({ field: field as string, expected, actual, pass: expected === actual }));

      // Line items (GPDF-010): same count, and each one's position, description and amount match.
      const items = db.lineItems(row!.id);
      e.lineItems.forEach((li, i) => {
        const a = items[i];
        checks.push({ field: `lineItems[${i}].position`, expected: li.position, actual: a?.position, pass: a?.position === li.position });
        checks.push({ field: `lineItems[${i}].description`, expected: li.description, actual: a?.description, pass: a?.description === li.description });
        checks.push({ field: `lineItems[${i}].amount_cents`, expected: li.amountCents, actual: a?.amount_cents, pass: a?.amount_cents === li.amountCents });
      });
      r.lineItems = { expected: e.lineItems.length, actual: items.length, pass: items.length === e.lineItems.length };
      // Reconciliation (GPDF-011): the line items must add up to the invoice total.
      const sum = items.reduce((s, i) => s + i.amount_cents, 0);
      if (items.length) checks.push({ field: 'sum(lineItems)==amount', expected: row!.amount_cents, actual: sum, pass: sum === row!.amount_cents });

      // the audit child row must have been recreated for THIS invoice, not survive from an old one
      const audit = db.auditNotes(row!.id);
      r.audit = { expected: [`ingested from ${g.fixtureId}.pdf`], actual: audit, pass: audit.length === 1 && audit[0] === `ingested from ${g.fixtureId}.pdf` };
      r.fields = checks;

      // Final verdict: every check passed. Any failing field is listed by name in the evidence report.
      expect(checks.filter(c => !c.pass)).toEqual([]);
      expect(r.lineItems.pass).toBe(true);
      expect(r.audit.pass).toBe(true);
      r.failedStep = undefined;
      r.result = 'PASS';
    } catch (err) {
      r.error = r.error ?? (err as Error).message;
      throw err;
    }
  });
});

// GPDF-012 (Duplicate PDF Handling) — proven through the public API, not just at the database layer.
describe('GPDF-012 — duplicate submission through the API', () => {
  const g = () => loadGolden().find(x => x.fixtureId === 'GOLDEN-INV-002')!;
  // Scenario: we submit the same PDF twice through the API.
  // Expected: the first completes normally; the second gets its own document id but finishes as DUPLICATE; afterwards
  // there is still exactly one invoice (with its original line items and audit note) and the first row is untouched.
  // Why: a customer re-uploading an invoice must never double-count revenue or overwrite the original record.
  test('same PDF POSTed twice: second is DUPLICATE, exactly one invoice row remains, first row untouched', async () => {
    // Step 1 — start clean.
    const fx = g(); const db = sut.db;
    resetGoldenFixture(db, sut.dbTarget, fx.fixtureId, fx.sourceHash);

    // Step 2 — first upload completes; remember the stored row.
    const first = await submitPdf(sut.apiUrl, fx.pdf, `${fx.fixtureId}.pdf`, { fixtureId: fx.fixtureId });
    expect((await waitForDocument(sut.apiUrl, first, sut.timeoutMs)).status).toBe('COMPLETED');
    const original = db.invoiceByDocumentId(first)!;

    // Step 3 — identical bytes uploaded again: new submission id, but outcome DUPLICATE.
    const second = await submitPdf(sut.apiUrl, fx.pdf, `${fx.fixtureId}.pdf`, { fixtureId: fx.fixtureId });
    expect(second).not.toBe(first);
    expect((await waitForDocument(sut.apiUrl, second, sut.timeoutMs)).status).toBe('DUPLICATE');

    // Step 4 — still one invoice, its children intact, nothing stored under the second id, first row byte-identical.
    const c = db.countGoldenRows(fx.fixtureId, fx.sourceHash);
    expect(c.invoices).toBe(1);
    expect(c.lineItems).toBe(fx.expected!.lineItems.length);
    expect(c.audit).toBe(1);
    expect(db.invoiceByDocumentId(second)).toBeUndefined();
    expect(db.invoiceByDocumentId(first)).toEqual(original);   // duplicate did not overwrite the first row
  });
});
