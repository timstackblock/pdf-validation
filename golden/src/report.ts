/**
 * WHAT THIS FILE DOES
 *
 * This file writes the evidence report for a golden run: one machine-readable JSON file (complete) and
 * one human-readable text summary, both named after the run id, in the reports folder. Inputs: details
 * about the run (environment, git commit, API address, database description, start time) and one result
 * record per fixture. Outputs: reports/golden-<run>.json and reports/golden-<run>.txt, plus a summary
 * with pass/fail counts. Each fixture's record is created before the PDF is submitted and filled in as
 * steps complete, so a fixture whose upload or processing crashes still appears in the report with the
 * step it died in. Risk protected against: a summary that says "15 of 15 passed" when 16 were attempted,
 * or a pass with no evidence that a fresh scan actually happened.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CleanupReport } from './cleanup';

// One compared field: what the golden file expected, what the database held, and whether they matched exactly.
export interface FieldCheck { field: string; expected: unknown; actual: unknown; pass: boolean; }

/** Everything the test plan lists as evidence for one fixture. Created BEFORE submission so a crash still leaves a record. */
export interface FixtureResult {
  // Identity of the test case: id, PDF file name, SHA-256 fingerprint, native/scanned, expected outcome.
  fixtureId: string; pdf: string; sourceHash: string; kind: string; expectedOutcome: string; allowRejection?: boolean;
  // Before/after row counts from checkpoint 0 (proves the run started clean).
  cleanup?: CleanupReport;
  // What the API said: assigned document id, submission and completion times, final status and any error.
  documentId?: string; submittedAt?: string; completedAt?: string; finalStatus?: string; error?: string | null;
  // Proof that a NEW extraction really happened: the job id versus the previous one, which engine read the
  // file (never "cache"), OCR confidence, and three yes/no checks — is the job new, is it for this document,
  // and is it for this exact file.
  extraction?: { jobId: number; previousJobId: number | null; engine: string; meanConfidence: number | null; startedAt: string; completedAt: string | null;
    freshJob: boolean; belongsToDocument: boolean; matchesSourceHash: boolean };
  // When the invoice row was written, and whether that is after this run started (i.e. not a leftover).
  processedAt?: string; rowBelongsToRun?: boolean;
  // Every field comparison, then the child-row checks: line item count and audit notes.
  fields: FieldCheck[];
  lineItems?: { expected: number; actual: number; pass: boolean };
  audit?: { expected: string[]; actual: string[]; pass: boolean };
  /** Which step was in progress when the fixture failed, if it failed before comparison. */
  failedStep?: 'cleanup' | 'submit' | 'processing' | 'verify';
  result: 'PASS' | 'FAIL';
}

// Facts about the run as a whole, printed at the top of every report. `database` is a credential-free description.
export interface RunContext { runId: string; startedAt: string; environment: string; mode: string; gitCommit: string; apiUrl: string; database: string; }

// Writes both report files and returns the summary (counts of fixtures, passed, failed).
export function writeGoldenReport(dir: string, ctx: RunContext, results: FixtureResult[]) {
  mkdirSync(dir, { recursive: true });
  // Totals are derived from the actual result list, so they can never disagree with the details.
  const summary = { ...ctx, finishedAt: new Date().toISOString(), fixtures: results.length,
    passed: results.filter(r => r.result === 'PASS').length, failed: results.filter(r => r.result === 'FAIL').length };
  // The JSON file is the complete record, suitable for tooling and audits.
  writeFileSync(join(dir, `golden-${ctx.runId}.json`), JSON.stringify({ summary, results }, null, 2));

  // The text file is the readable version: a run header, then one block per fixture.
  const L: string[] = [
    `GOLDEN PDF VALIDATION — run ${ctx.runId}`,
    `Environment: ${ctx.environment} (${ctx.mode})   Git commit: ${ctx.gitCommit}`,
    `API: ${ctx.apiUrl}   Database: ${ctx.database}`,
    `Started: ${ctx.startedAt}   Finished: ${summary.finishedAt}`,
    `Fixtures: ${summary.fixtures}  PASS: ${summary.passed}  FAIL: ${summary.failed}`, ''];
  for (const r of results) {
    // Headline line: tick or cross, fixture id, kind and expected outcome.
    L.push(`${r.result === 'PASS' ? '✔' : '✘'} ${r.fixtureId}  (${r.kind}, expect ${r.expectedOutcome}${r.allowRejection ? ' or FAILED' : ''})`);
    L.push(`   PDF: ${r.pdf}   hash: ${r.sourceHash.slice(0, 16)}…   documentId: ${r.documentId ?? '(not submitted)'}`);
    // Each optional section is printed only if that step was reached, so the reader can see how far the fixture got.
    if (r.cleanup) { const b = r.cleanup.before; L.push(`   Cleanup: before {inv ${b.invoices}, docs ${b.documents}, jobs ${b.jobs}, cache ${b.cache}} → after all 0`); }
    if (r.submittedAt) L.push(`   Submitted: ${r.submittedAt}   Completed: ${r.completedAt ?? 'never'}`);
    L.push(`   Final status: ${r.finalStatus ?? 'n/a'}${r.error ? ` (${r.error})` : ''}${r.failedStep ? `   [failed during ${r.failedStep}]` : ''}`);
    if (r.extraction) {
      const x = r.extraction;
      L.push(`   Extraction: job #${x.jobId} (prev ${x.previousJobId ?? 'none'}) engine=${x.engine} conf=${x.meanConfidence ?? 'n/a'} started=${x.startedAt} fresh=${x.freshJob} belongsToDocument=${x.belongsToDocument} matchesHash=${x.matchesSourceHash}`);
    }
    if (r.processedAt) L.push(`   processed_at ${r.processedAt} belongs to run: ${r.rowBelongsToRun}`);
    // Only mismatching fields are listed in detail; passing ones are counted.
    const failed = r.fields.filter(f => !f.pass);
    L.push(`   Fields checked: ${r.fields.length}  passed: ${r.fields.length - failed.length}  failed: ${failed.length}`);
    for (const f of failed) L.push(`     ✘ ${f.field}: expected ${JSON.stringify(f.expected)} got ${JSON.stringify(f.actual)}`);
    if (r.lineItems) L.push(`   Line items: expected ${r.lineItems.expected} got ${r.lineItems.actual} → ${r.lineItems.pass ? 'ok' : 'MISMATCH'}`);
    if (r.audit) L.push(`   Audit rows: expected ${JSON.stringify(r.audit.expected)} got ${JSON.stringify(r.audit.actual)} → ${r.audit.pass ? 'ok' : 'MISMATCH'}`);
    L.push('');
  }
  writeFileSync(join(dir, `golden-${ctx.runId}.txt`), L.join('\n'));
  return summary;
}
