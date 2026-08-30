/**
 * WHAT THIS TEST FILE PROVES
 *
 * Level covered: Level 4 — the whole application pipeline run in one go (read -> convert -> store), but
 * called directly inside the test process rather than over the network, and against a fresh in-memory
 * database (a real database living only in RAM, thrown away after each test). Levels 1-3 proved each step
 * on its own; this level proves the steps work TOGETHER, for every approved sample invoice at once.
 *
 * What "pass" means in business terms: every good sample invoice (native and scanned) ends up in the
 * database with exactly the approved values; every deliberately bad sample is refused and leaves no trace;
 * and a batch run's summary numbers (submitted / inserted / duplicates / rejected, plus total money)
 * reconcile exactly.
 *
 * Production bug this would catch: a wiring error between steps (e.g. the converted record is stored under
 * the wrong column), the OCR path being skipped for scanned files, a bad file leaving a partial row, or a
 * batch summary that reports more (or less) revenue than was actually stored.
 *
 * Note on "allowRejection": a few scanned samples contain characters even a human might misread. For those,
 * the application is allowed to reject the file — but ONLY for a genuine validation reason, never because
 * the OCR software is missing from the machine.
 *
 * Test-plan cases referenced: GPDF 004, 006, 007, 008, 009 (bad fixtures), 010, 011, 013, 014.
 */
import { openDb, DB } from '../../app/db';
import { processPdf, processBatch } from '../../app/pipeline';
import { goldenGood, goldenBad } from '../src/fixtures';

let db: DB;
// Every test starts with an empty in-memory database.
beforeEach(() => { db = openDb(':memory:'); });
afterEach(() => db.close());

describe('Level 4: application integration (in-process, fresh in-memory DB)', () => {
  // GPDF-004 / GPDF-010 / GPDF-014.
  // Scenario: each approved "good" sample PDF is pushed through the full pipeline.
  // Expected: one row stored whose every field equals the hand-verified golden value, the right engine was
  // used (real OCR for scans, direct text for native files), and every line item matches in order.
  // Why: this is the closest thing to "does the product work" that can run without a server.
  test.each(goldenGood())('$fixtureId -> processPdf -> row matches expected', async ({ pdf, fixtureId, expected, sourceHash, kind, allowRejection }) => {
    let out;
    // Step 1 — run the pipeline; a rejection is only tolerated for fixtures flagged allowRejection.
    try { out = await processPdf(db, pdf, `${fixtureId}.pdf`, { fixtureId }); }
    catch (e) {
      if (!allowRejection) throw e;
      // tolerated only when the APPLICATION rejected it (validation error), never when the OCR toolchain is missing
      expect((e as Error).message).not.toMatch(/pdftoppm|tesseract|convert|magick|ENOENT|no pages rendered|traineddata|ImageMagick not found|orientation detection unavailable/i);
      expect((e as Error).message).toMatch(/^(customerName|accountNumber|invoiceDate|amount|status|lineItems)/);
      expect(db.prepare("SELECT status FROM documents").get()).toEqual({ status: 'FAILED' });
      return;
    }
    // Step 2 — the invoice row exists and every field matches the golden JSON exactly.
    expect(out.result).toBe('inserted');
    const row = db.prepare('SELECT * FROM invoices WHERE document_id = ?').get(out.documentId) as any;
    expect(row).toMatchObject({ customer_name: expected!.customerName, account_number: expected!.accountNumber, invoice_date: expected!.invoiceDate,
      amount_cents: expected!.amountCents, status: expected!.status, source_hash: sourceHash, test_fixture_id: fixtureId });
    // Step 3 — scanned files must have gone through real OCR (tesseract); native files through the direct reader.
    const job = db.prepare('SELECT engine FROM extraction_jobs WHERE id = ?').get(row.extraction_job_id) as any;
    expect(job.engine).toBe(kind === 'scanned' ? 'tesseract' : 'native');
    // Step 4 — line items: same count, same order, same descriptions and amounts.
    expect(db.prepare('SELECT position, description, amount_cents FROM invoice_line_items WHERE invoice_id = ? ORDER BY position').all(row.id))
      .toEqual(expected!.lineItems.map(l => ({ position: l.position, description: l.description, amount_cents: l.amountCents })));
  });

  // GPDF-006/007/008/009/013 (the "bad" fixtures: OCR garbage in the amount, missing field, impossible date, corrupt file...).
  // Scenario: each deliberately broken sample is pushed through the pipeline.
  // Expected: it is refused, zero invoice rows exist, and the document is marked FAILED.
  // Why: a bad file must fail visibly and cleanly — never a half-stored invoice with wrong numbers.
  test.each(goldenBad())('$fixtureId is rejected and writes nothing', async ({ pdf, fixtureId }) => {
    await expect(processPdf(db, pdf, `${fixtureId}.pdf`)).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM invoices').get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT status FROM documents").get()).toEqual({ status: 'FAILED' });
  });

  // GPDF-011 (Aggregate Reconciliation) / GPDF-012 (duplicate in a batch).
  // Scenario: one batch containing every good sample, every bad sample, and the first good sample a second time.
  // Expected: submitted = inserted + duplicates + rejected; exactly one duplicate; the rejected list is exactly the bad
  // samples (plus any tolerated allowRejection scans); and the total money stored equals the sum of the golden amounts —
  // in the invoice table, in the returned summary, AND in the stored run record.
  // Why: the batch summary is what an operator reads to trust a nightly run; it must agree with the database to the cent.
  test('batch reconciliation: submitted = inserted + duplicates + rejected; totals match goldens', async () => {
    // Step 1 — build the batch (good + bad + one deliberate repeat) and run it.
    const good = goldenGood(), bad = goldenBad();
    const files = [...good, ...bad, good[0]].map(g => ({ buf: g.pdf, name: `${g.fixtureId}.pdf` }));
    const { outcomes, summary } = await processBatch(db, files);
    // Step 2 — the counts add up.
    expect(summary.submitted).toBe(files.length);
    expect(summary.inserted + summary.duplicates + summary.rejected).toBe(summary.submitted);
    // an allowRejection fixture may be rejected instead of inserted; anything else rejected is a real failure
    const rejectedFiles = outcomes.filter(o => o.result === 'rejected').map(o => o.file);
    const tolerated = good.filter(g => g.allowRejection && rejectedFiles.includes(`${g.fixtureId}.pdf`));
    const inserted = good.filter(g => !tolerated.includes(g));
    // Step 3 — exactly the right files were rejected, and exactly one was a duplicate.
    expect(rejectedFiles.sort()).toEqual([...bad, ...tolerated].map(g => `${g.fixtureId}.pdf`).sort());
    expect(summary).toMatchObject({ inserted: inserted.length, duplicates: 1, rejected: bad.length + tolerated.length });
    // Step 4 — money reconciles: database total == summary total == sum of golden amounts.
    const expectedTotal = inserted.reduce((s, g) => s + g.expected!.amountCents, 0);
    expect((db.prepare('SELECT SUM(amount_cents) t FROM invoices').get() as any).t ?? 0).toBe(expectedTotal);
    expect(summary.insertedAmountCents).toBe(expectedTotal);
    // Step 5 — the run itself was recorded with the same counts.
    expect(db.prepare('SELECT submitted, inserted, duplicates, rejected FROM processing_runs').get())
      .toEqual({ submitted: files.length, inserted: inserted.length, duplicates: 1, rejected: bad.length + tolerated.length });
  });
});
