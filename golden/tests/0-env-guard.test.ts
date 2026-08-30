/**
 * WHAT THIS TEST FILE PROVES
 *
 * Level covered: Level 0 — the safety gate that runs BEFORE any golden test touches a database.
 *
 * The golden suite deletes rows and re-submits PDFs. That is only acceptable against a throwaway
 * TEST database. This file proves the "environment guard" (a small check that inspects the
 * database location and the environment settings) refuses to run when anything smells like
 * production — a production-looking file name, a production server address, a missing
 * "I really mean it" flag, and so on.
 *
 * What "pass" means in business terms: the automated tests can never accidentally wipe or
 * rewrite real customer invoice data. Wrong environment = the suite stops before doing anything.
 *
 * Production bug this would catch: someone points CI at the wrong connection string, or a
 * developer runs the suite from a laptop with production credentials loaded. Without this guard
 * the cleanup step would silently delete real rows.
 *
 * Terms used below:
 *   - "env" / environment variables: named settings (like NODE_ENV) that a program reads at start-up.
 *   - SQLite: a database stored as a single file on disk; ":memory:" means a database that lives only in RAM.
 *   - Postgres URL: the address of a shared database server, e.g. postgres://user@host/database_name.
 */
import { assertGoldenTestEnvironment } from '../src/env-guard';
import { connectSystemUnderTest, detectGitCommit } from '../src/system-under-test';
// The "happy" settings: we are in test mode AND someone explicitly allowed the golden DB reset.
const ok = { NODE_ENV: 'test', ALLOW_GOLDEN_DB_RESET: 'true' };
describe('Environment guard', () => {
  // Scenario: a local database file clearly named as a test DB, with both safety flags set.
  // Expected: the guard lets the run proceed. This is the baseline "good" case; if it broke, no test could run at all.
  test('passes for a test DB with both flags', () => expect(() => assertGoldenTestEnvironment('/x/golden-test.sqlite', ok)).not.toThrow());
  // Scenario: the database is a remote server whose database NAME ends in "_test".
  // Expected: allowed. We care because CI usually runs against a shared remote test database, not a local file.
  test('passes for a remote test database URL', () => expect(() => assertGoldenTestEnvironment('postgres://golden@db.internal/pdf_ingestion_test', ok)).not.toThrow());
  // Scenario: the word "prod" appears in a parent folder name ("/srv/products/...") but the file itself is a test DB.
  // Expected: allowed — folder names are noise. But "prod" in the FILE name itself is refused.
  // Why: the guard must judge the actual database, not accidental words in the path, or it would be both too strict and too loose.
  test('an ancestor directory mentioning prod does not matter, the file name does', () => {
    expect(() => assertGoldenTestEnvironment('/srv/products/.data/golden-test.sqlite', ok)).not.toThrow();
    expect(() => assertGoldenTestEnvironment('/srv/qa/golden-test-prod.sqlite', ok)).toThrow(/mentions prod/);
  });
  // Scenario: a table of "must refuse" situations. Each row is [settings, database location, expected reason for refusal].
  // Expected: every one is blocked, and the error message names the specific reason so an operator can fix it fast.
  // Why we care: each row is a realistic way the suite could be pointed at real data by mistake.
  test.each([
    [{ ...ok, NODE_ENV: 'production' }, '/x/golden-test.sqlite', /NODE_ENV/],
    [{ ...ok, ALLOW_GOLDEN_DB_RESET: 'false' }, '/x/golden-test.sqlite', /ALLOW_GOLDEN_DB_RESET/],
    [ok, '/x/app.sqlite', /does not look like a test database/],
    [ok, '/x/prod-test.sqlite', /mentions prod/],
    [ok, ':memory:', /test database/],
    [ok, 'postgres://app@db.internal/pdf_ingestion', /does not look like a test database/],
    [ok, 'postgres://test_ro:pw@db.internal/pdf_ingestion', /does not look like a test database/],   // "test" only in the credential
    [ok, '/Users/x/latest/app.sqlite', /does not look like a test database/],                          // "test" only in an ancestor dir
    [ok, 'postgres://app@db-prod.internal/pdf_ingestion_test', /mentions prod/],
    [{ ...ok, TEST_ENVIRONMENT: 'production' }, '/x/golden-test.sqlite', /TEST_ENVIRONMENT/],
    [{ ...ok, PDF_INGEST_API_URL: 'https://pdf-ingest.prod.example.com' }, '/x/golden-test.sqlite', /PDF_INGEST_API_URL/],
  ])('refuses %j %s', (env, path, re) => expect(() => assertGoldenTestEnvironment(path, env)).toThrow(re));
});

// The suite can test either the bundled sample app ("local") or a deployed test environment ("remote",
// selected by setting PDF_INGEST_API_URL). These tests cover how that choice is validated.
describe('System under test selection', () => {
  // Scenario: remote mode is requested but no test database address is given, or a non-test one is given.
  // Expected: connection is refused with a clear message.
  // Why: in remote mode the suite verifies results by reading the database directly, so it must be told
  // exactly which database — and that database must be a test one.
  test('remote mode requires TEST_DATABASE_URL and refuses a non-test one', async () => {
    await expect(connectSystemUnderTest({ ...ok, PDF_INGEST_API_URL: 'https://api.test' })).rejects.toThrow(/TEST_DATABASE_URL is required/);
    await expect(connectSystemUnderTest({ ...ok, PDF_INGEST_API_URL: 'https://api.test', TEST_DATABASE_URL: 'postgres://x@db/pdf_ingestion' }))
      .rejects.toThrow(/does not look like a test database/);
  });
  // Scenario: the evidence report records which version of the code (git commit) was tested.
  // Expected: the commit is taken from CI settings when present, otherwise detected locally, and is never blank.
  // Why: an evidence report that cannot say WHICH build it tested is worthless for audit or release sign-off.
  test('git commit is never empty in the evidence', () => {
    expect(detectGitCommit({ GIT_COMMIT: 'abc123' })).toBe('abc123');
    expect(detectGitCommit({ CI_COMMIT_SHA: 'def456' })).toBe('def456');
    expect(detectGitCommit({})).toMatch(/^[0-9a-f]{40}$|^unknown/);
  });
});
