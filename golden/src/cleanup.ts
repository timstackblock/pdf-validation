/**
 * WHAT THIS FILE DOES
 *
 * This is "checkpoint 0" of the golden suite: the step that wipes out everything a previous test run
 * left in the database for one golden PDF, and then proves the wipe worked, BEFORE the PDF is submitted.
 * Inputs: a database connection, the database name/path (for the safety guard), the fixture id
 * (e.g. GOLDEN-INV-001) and the PDF's SHA-256 hash (a fingerprint computed from the file's bytes,
 * unique to that exact file). Output: a small report with the row counts before and after the delete,
 * plus the id of the last extraction job seen for this PDF so a later step can prove a NEW job ran.
 * Risk protected against: a stale row from yesterday making today's test pass even though the PDF was
 * never re-processed (a "false pass"). If anything is left over, this file throws and the run must stop.
 */
import { GoldenDb, Counts } from './golden-db';
import { assertGoldenTestEnvironment } from './env-guard';

export type { Counts };
// The evidence produced by one cleanup: which fixture, how many rows existed before, how many remain
// after (must all be zero), and the highest extraction-job id seen before deletion (null if none).
export interface CleanupReport { fixtureId: string; before: Counts; after: Counts; previousJobId: number | null; }

// Counts every table's rows that belong to this fixture (matched by fixture id OR file hash, so rows
// written by a run that forgot to tag the fixture id are still found).
export const countGoldenRows = (db: GoldenDb, fixtureId: string, sourceHash: string) => db.countGoldenRows(fixtureId, sourceHash);
// True only when every count is zero — the only state in which submitting the PDF is allowed.
export const isClean = (c: Counts) => Object.values(c).every(v => v === 0);

/**
 * CHECKPOINT 0. Deletes everything a previous run left for this fixture — final rows, children,
 * staging (documents), extraction jobs AND the extraction cache — in dependency order, in one
 * transaction, then verifies. Throws if anything remains; callers must not submit the PDF in that case.
 *
 * In plain terms: "start from a blank slate for this PDF, and prove it." A transaction means all the
 * deletes succeed together or none of them do, so a half-cleaned state is impossible.
 */
export function resetGoldenFixture(db: GoldenDb, dbTarget: string, fixtureId: string, sourceHash: string): CleanupReport {
  // Safety first: refuse to delete anything unless the environment clearly looks like a test database.
  assertGoldenTestEnvironment(dbTarget);
  // Record what was there before, for the evidence report (non-zero "before" counts show cleanup mattered).
  const before = db.countGoldenRows(fixtureId, sourceHash);
  // Remember the newest extraction job for this file so the test can later prove a different, newer job ran.
  const previousJobId = db.previousJobId(sourceHash);
  db.deleteGoldenRows(fixtureId, sourceHash);
  // Never trust the delete — count again and refuse to continue if anything survived.
  const after = db.countGoldenRows(fixtureId, sourceHash);
  if (!isClean(after)) throw new Error(`Golden cleanup failed for ${fixtureId}: ${JSON.stringify(after)} — refusing to continue`);
  return { fixtureId, before, after, previousJobId };
}
