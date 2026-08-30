/**
 * WHAT THIS FILE DOES
 *
 * This is the safety catch that stops the golden suite from deleting data in the wrong database.
 * Because the suite's cleanup step really does run DELETE statements, it must never be pointed at
 * production, at a customer database, or at a developer's real data by mistake. Input: the database
 * target (a SQLite file path in local mode, or a database URL in remote mode) plus the environment
 * variables the run was started with. Output: nothing if everything looks safe; otherwise it throws
 * an error and the run stops before a single row is touched. Risk protected against: deleting the wrong
 * database. It checks the name of the database, not its folders or passwords, so "test" appearing
 * somewhere unrelated in the path cannot trick it.
 *
 * Destructive cleanup is only allowed when every one of these holds. Called before any DELETE.
 * `dbTarget` is a SQLite path in local mode or the database URL in remote mode.
 *
 * This is a STRING guard — a second line of defence. The first line is the credential: the golden suite must
 * connect with a role that can only SELECT/INSERT/DELETE inside the QA schema (see GoldenDb.verifyRestrictedAccess).
 */
import { basename } from 'path';

/**
 * The part of a database target that names the database: hostname + path for a URL, the file name for a path.
 * Ancestor directories and credentials are ignored, so `/Users/x/latest/app.sqlite` is NOT a test database and
 * `postgres://test_ro:pw@db/pdf_ingestion` is not either, while `/home/x/products/.data/golden-test.sqlite` is.
 */
export function databaseName(dbTarget: string): string {
  // Looks like a URL (e.g. "postgres://...")? Use its host and path; if it cannot be parsed, fall back to the raw text.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(dbTarget)) {
    try { const u = new URL(dbTarget); return `${u.hostname}${u.pathname}`; } catch { return dbTarget; }
  }
  // Otherwise it is a file path: only the file name itself counts.
  return basename(dbTarget);
}

// The guard itself. Every rule below must pass or the run is refused. The two environment flags
// (NODE_ENV=test and ALLOW_GOLDEN_DB_RESET=true) are set by the npm script or CI configuration, so that
// deleting data is always an explicit, deliberate choice — a test can never grant itself permission.
export function assertGoldenTestEnvironment(dbTarget: string, env: NodeJS.ProcessEnv = process.env) {
  // Rule 1: the process must declare itself a test process.
  if (env.NODE_ENV !== 'test') throw new Error(`Refusing golden cleanup: NODE_ENV is "${env.NODE_ENV}", not "test"`);
  // Rule 2: someone must have explicitly consented to a database reset.
  if (env.ALLOW_GOLDEN_DB_RESET !== 'true') throw new Error('Refusing golden cleanup: ALLOW_GOLDEN_DB_RESET is not "true"');
  const name = databaseName(dbTarget);
  // Rule 3: the database name must contain "test", and an in-memory database is refused (it would hide stale-data bugs).
  if (!/test/i.test(name) || dbTarget === ':memory:') throw new Error(`Refusing golden cleanup: database "${dbTarget}" does not look like a test database`);
  // Rule 4: any mention of "prod" in the database name, the environment label or the API address is a hard stop.
  if (/prod/i.test(name)) throw new Error(`Refusing golden cleanup: database "${dbTarget}" mentions prod`);
  if (env.TEST_ENVIRONMENT && /prod/i.test(env.TEST_ENVIRONMENT)) throw new Error(`Refusing golden cleanup: TEST_ENVIRONMENT is "${env.TEST_ENVIRONMENT}"`);
  if (env.PDF_INGEST_API_URL && /prod/i.test(env.PDF_INGEST_API_URL)) throw new Error(`Refusing golden cleanup: PDF_INGEST_API_URL "${env.PDF_INGEST_API_URL}" mentions prod`);
}
