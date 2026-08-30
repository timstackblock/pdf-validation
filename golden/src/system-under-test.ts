/**
 * WHAT THIS FILE DOES
 *
 * This file decides WHICH ingestion system the golden suite is testing and connects to it. By default
 * ("local" mode) it starts the sample app that ships with this repo on the tester's own machine, with
 * its own SQLite database file. If the PDF_INGEST_API_URL environment variable is set ("remote" mode),
 * it instead points the suite at that deployed service and at the matching test database, reached
 * through a database adapter (a small module that answers the GoldenDb questions for that database).
 * Inputs: environment variables only — no code change is needed to switch targets. Outputs: a
 * SystemUnderTest bundle with the API address, database connection, timeout and a close() to shut it
 * all down, plus a helper that records the git commit for the evidence report. Risk protected against:
 * connecting cleanup to the wrong database — both the string guard and the credential check run here,
 * before anything else happens.
 *
 * Which system does Level 5 exercise? Decided by environment, never by code changes in the test:
 *
 *   mode "local"  (default) — the sample app/: in-process HTTP server + in-process worker + Tesseract + SQLite.
 *                            A reference implementation of the shape of the real thing.
 *   mode "remote"           — PDF_INGEST_API_URL is set: the test submits to THAT deployed API (real storage,
 *                            real queue, real worker, real OCR service, real parser) and verifies through the
 *                            real test database, reached via the GoldenDb adapter named by GOLDEN_DB_ADAPTER.
 *
 * Environment (remote mode):
 *   PDF_INGEST_API_URL   e.g. https://pdf-ingest.test.internal      — required to enable remote mode
 *   TEST_DATABASE_URL    connection string for the QA schema         — must contain "test", must not contain "prod"
 *   GOLDEN_DB_ADAPTER    module path exporting `createGoldenDb(url): GoldenDb` (default: sqlite adapter, which
 *                        treats TEST_DATABASE_URL as a file path — only useful when the remote API shares a SQLite file)
 *   TEST_ENVIRONMENT     label for the evidence report, e.g. "staging" (default "local")
 *   GOLDEN_TIMEOUT_MS    per-document processing timeout (default 60000 local, 300000 remote)
 */
import { join } from 'path';
import { mkdirSync } from 'fs';
import { GoldenDb, SqliteGoldenDb } from './golden-db';
import { assertGoldenTestEnvironment } from './env-guard';

// Everything a test needs to know about the system it is talking to.
export interface SystemUnderTest {
  // "local" = the sample app on this machine; "remote" = a deployed service.
  mode: 'local' | 'remote';
  // Free-text label for the report, e.g. "local" or "staging".
  environment: string;
  // Base address of the ingestion API.
  apiUrl: string;
  /** What the env guard was evaluated against (path or credential-free URL). */
  dbTarget: string;
  // The database connection used for cleanup and verification.
  db: GoldenDb;
  // How long to wait for one document to finish processing.
  timeoutMs: number;
  // Shuts down the server (local mode) and closes the database.
  close(): Promise<void>;
}

// The SQLite file used in local mode. It is deliberately kept between runs so reports show real
// "before" cleanup counts and the previous-versus-new extraction job id.
export const DEFAULT_LOCAL_DB = join(__dirname, '..', '..', '.data', 'golden-test.sqlite');

// Replaces "user:password@" in a URL with "***@" so no credential ever lands in a report.
const stripCredentials = (url: string) => url.replace(/\/\/[^@/]+@/, '//***@');

// Picks the mode from the environment, runs both safety checks, and returns the connected system.
export async function connectSystemUnderTest(env: NodeJS.ProcessEnv = process.env): Promise<SystemUnderTest> {
  const environment = env.TEST_ENVIRONMENT ?? 'local';
  // Remote mode: a deployed API plus an external test database.
  if (env.PDF_INGEST_API_URL) {
    const url = env.TEST_DATABASE_URL;
    if (!url) throw new Error('remote mode: TEST_DATABASE_URL is required alongside PDF_INGEST_API_URL');
    // Safety check 1: the database name/URL must look like a test database (string guard).
    assertGoldenTestEnvironment(url, env);
    // Load the adapter for the real database if one is named; otherwise fall back to the SQLite adapter.
    const adapter = env.GOLDEN_DB_ADAPTER ? require(env.GOLDEN_DB_ADAPTER) : null;
    const db: GoldenDb = adapter ? adapter.createGoldenDb(url) : new SqliteGoldenDb(url);
    // Safety check 2: the connection itself must be a restricted one (credential guard).
    db.verifyRestrictedAccess();
    // Trailing slash is trimmed so "<apiUrl>/documents" is always well-formed; the report gets a credential-free target.
    return { mode: 'remote', environment, apiUrl: env.PDF_INGEST_API_URL.replace(/\/$/, ''), dbTarget: stripCredentials(url), db,
      timeoutMs: Number(env.GOLDEN_TIMEOUT_MS ?? 300_000), close: async () => db.close() };
  }

  // Local mode: the sample app and a SQLite file on disk. The same two safety checks apply.
  const dbPath = env.GOLDEN_DB_PATH ?? DEFAULT_LOCAL_DB;
  assertGoldenTestEnvironment(dbPath, env);
  // Make sure the .data folder exists before opening the database file.
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new SqliteGoldenDb(dbPath);
  db.verifyRestrictedAccess();
  // The sample server is started in this process, sharing the same database file the tests will inspect.
  const { startServer } = await import('../../app/server');   // only the local mode ever touches app/
  const api = await startServer(db.raw);
  return { mode: 'local', environment, apiUrl: api.url, dbTarget: dbPath, db, timeoutMs: Number(env.GOLDEN_TIMEOUT_MS ?? 60_000),
    close: async () => { await api.close(); db.close(); } };
}

/**
 * Best-effort commit id for the evidence report: CI variables first, then git, then "unknown".
 * Refuses to report an ancestor repository's commit when this project is not actually tracked by it
 * (e.g. a checkout unzipped inside a home directory that happens to be a dotfiles repo).
 *
 * Why it matters: the report must say exactly which version of the code was tested, and a wrong
 * commit id is worse than "unknown".
 */
export function detectGitCommit(env: NodeJS.ProcessEnv = process.env, projectRoot = join(__dirname, '..', '..')): string {
  // CI systems (Jenkins, GitLab, GitHub, Azure) each expose the commit under their own variable name.
  const fromCi = env.GIT_COMMIT ?? env.CI_COMMIT_SHA ?? env.GITHUB_SHA ?? env.BUILD_SOURCEVERSION;
  if (fromCi) return fromCi;
  const { execFileSync, spawnSync } = require('child_process') as typeof import('child_process');
  try {
    // If git says this folder is ignored, an enclosing repository's commit would be misleading — report unknown.
    const ignored = spawnSync('git', ['check-ignore', '-q', projectRoot], { cwd: projectRoot, stdio: 'pipe' }).status === 0;
    if (ignored) return 'unknown (project not tracked by the enclosing git repository)';
    // Only report a commit if this project's own package.json is actually tracked by git.
    const tracked = execFileSync('git', ['ls-files', '--error-unmatch', 'package.json'], { cwd: projectRoot, stdio: 'pipe' }).toString().trim();
    if (!tracked) return 'unknown (not under version control)';
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, stdio: 'pipe' }).toString().trim();
  } catch { return 'unknown (not under version control)'; }
}
