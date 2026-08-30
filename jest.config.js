/**
 * WHAT THIS FILE DOES
 *
 * Tells Jest (the tool that runs our automated tests) where the tests live and how to run them. There are two
 * separate suites: "golden" (the 19 hand-verified invoices in fixtures/, checked against known correct answers) and
 * "random" (never-before-seen invoices reconciled against whatever the application stored). Both are written in
 * TypeScript, so ts-jest translates them before running, and both run in a plain Node.js environment (no browser).
 * The generous two-minute limit per test exists because some tests ingest real PDFs and run OCR, which is slow.
 */
module.exports = {
  projects: [
    { displayName: 'golden', preset: 'ts-jest', testEnvironment: 'node', testMatch: ['<rootDir>/golden/tests/**/*.test.ts'], testTimeout: 120000 },
    { displayName: 'random', preset: 'ts-jest', testEnvironment: 'node', testMatch: ['<rootDir>/random/tests/**/*.test.ts'], testTimeout: 120000 },
  ],
};
