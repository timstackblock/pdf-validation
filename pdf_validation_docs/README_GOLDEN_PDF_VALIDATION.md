# Golden PDF Validation

## Purpose

Use the Golden suite to prove that the full PDF ingestion pipeline still works after code, configuration, OCR, or database changes.

Each committed PDF has a separate, human verified JSON file containing the expected database values. Every system run starts clean, forces a new processing cycle, and compares newly stored data with that contract.

```text
Golden PDF
  → remove prior fixture data and extraction cache
  → confirm zero matching rows remain
  → submit through the ingestion API
  → extract native text or run OCR
  → transform and persist
  → verify a new extraction job and new database row
  → compare fields, line items, audit data, and totals
  → write evidence report
```

This differs from Random PDF reconciliation, which validates one unknown PDF against existing data with a read only database connection and an independent reader.

## Golden contract

Files live in:

```text
fixtures/pdf/<fixtureId>.pdf
fixtures/expected/<fixtureId>.json
```

Expected JSON is the source of truth and is never generated from parser output. Required metadata includes `fixtureId`, `kind`, `expectedOutcome`, `verifiedBy`, `verifiedOn`, and expected database values for successful documents.

Rules:

- Money is stored as integer cents, never floating point values.
- Identifiers remain strings so leading zeros are preserved.
- `verifiedBy` beginning with `DRAFT` marks an unverified fixture. Drafts are excluded from normal runs.
- `expectedOutcome` is `COMPLETED` or `FAILED`.
- `allowRejection: true` is allowed for deliberately difficult OCR cases. The document may be rejected, but it may never complete with incorrect stored data.

Current set: 19 PDFs. Sixteen are verified and run by default. `GOLDEN-INV-007`, `GOLDEN-INV-105`, and `GOLDEN-INV-106` are drafts until manually verified.

## Safety and reset requirements

Golden testing is destructive by design because stale data can create false passes. Before every system test, the suite removes all reusable data for that fixture:

- document and final invoice rows
- line items and audit rows
- extraction job records
- extraction cache keyed by source hash

The suite then queries again and requires every matching count to be zero before submission.

Two safety controls run before cleanup:

1. **Environment guard:** `NODE_ENV=test`, `ALLOW_GOLDEN_DB_RESET=true`, and a database target that clearly identifies a test environment and does not contain `prod`.
2. **Restricted credentials:** the database adapter must verify that the connection has only the access needed for the QA schema. Production access must be impossible at the credential level.

Never use this suite against production or customer data.

## Test levels

| Level | Test file | Purpose |
|---|---|---|
| 0 | `golden/tests/0-env-guard.test.ts` | Stop destructive tests before they can touch an unsafe database or environment. |
| 1 | `golden/tests/1-extract.test.ts` | Verify native extraction and real OCR return the correct raw strings without silently transforming them. |
| 2 | `golden/tests/2-transform.test.ts` | Verify currency, dates, identifiers, status, required fields, and line item totals are transformed correctly. |
| 3 | `golden/tests/3-db.test.ts` | Verify parent, child, audit, uniqueness, foreign key, constraint, and transaction behavior. |
| 4 | `golden/tests/4-integration.test.ts` | Exercise PDF → extraction → transform → database in process and reconcile batch totals. |
| 5 | `golden/tests/5-golden-system.test.ts` | Submit through HTTP, wait for processing, prove a fresh extraction and row, and compare the full result to Golden JSON. |
| 6 | `golden/tests/6-stale-data-defense.test.ts` | Prove why reset, cache clearing, cleanup failure handling, and document ID lookup are required. |

The detailed reason and expected result for every GPDF case is in `TEST_PLAN_GOLDEN_PDF_VALIDATION.md`.

## Local and remote system testing

### Local reference mode

Default mode starts the bundled sample application:

```text
HTTP API → in process worker → pdf.js or Tesseract → SQLite
```

The SQLite file persists between runs so cleanup and fresh job checks are meaningful.

### Remote mode

Setting `PDF_INGEST_API_URL` makes Level 5 test a deployed test service. The real storage, queue, worker, OCR service, parser, and database can participate without changing the test.

Required remote settings:

| Variable | Purpose |
|---|---|
| `PDF_INGEST_API_URL` | Test ingestion API. |
| `TEST_DATABASE_URL` | Matching test database. Must identify a test target and not production. |
| `GOLDEN_DB_ADAPTER` | Module exporting `createGoldenDb(url): GoldenDb` for the real database. |
| `TEST_ENVIRONMENT` | Evidence label such as `staging`. |
| `GOLDEN_TIMEOUT_MS` | Optional processing timeout. Default: 60s local, 300s remote. |

`GoldenDb` is the only database seam the remote implementation needs to provide for cleanup and verification.

## Prerequisites

Day to day test execution requires:

- Node.js 20+
- npm 10+
- Tesseract 5 with `eng` and `osd`
- Poppler: `pdftoppm` and `pdftotext`
- ImageMagick: `magick` or `convert`
- git for commit evidence when available
- a C/C++ toolchain only if `better-sqlite3` must compile locally

Fixture regeneration additionally requires Python 3, Pillow, and a TrueType font such as DejaVu Sans or Arial.

Example macOS install:

```bash
brew install node tesseract poppler imagemagick
python3 -m pip install --user pillow
npm install
```

Example Debian or Ubuntu CI dependencies:

```bash
sudo apt-get install -y tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd \
  poppler-utils imagemagick python3 python3-pil fonts-dejavu-core build-essential git
npm install
```

Quick verification:

```bash
node -v
tesseract --list-langs        # eng and osd required
pdftoppm -v
pdftotext -v
magick -version || convert -version
npm run typecheck
```

Common failures: Node below 20 can cause `DOMMatrix` errors; `ENOENT` for `pdftoppm` or `tesseract` means the tool is missing from `PATH`; missing `osd.traineddata` prevents safe orientation handling.

## Running the suite

```bash
npm run test:golden          # verified fixtures, levels 0–6
npm run test:golden:system   # levels 5 and 6
npm run test:golden:drafts   # explicitly include unverified draft fixtures
npm run test:golden:remote   # level 5 against configured deployed test system
npm test                     # Golden + Random suites
```

Important environment variables:

| Variable | Default / rule |
|---|---|
| `NODE_ENV` | Must be `test`; npm Golden scripts set it. |
| `ALLOW_GOLDEN_DB_RESET` | Must be `true`; npm Golden scripts set it. |
| `GOLDEN_DB_PATH` | `.data/golden-test.sqlite` in local mode. |
| `GOLDEN_INCLUDE_DRAFTS` | Set `true` only to run draft expectations. |
| `TEST_ENVIRONMENT` | `local` unless supplied. |
| `GIT_COMMIT`, `CI_COMMIT_SHA`, `GITHUB_SHA`, `BUILD_SOURCEVERSION` | Used for evidence when present; otherwise git is queried. |

## Evidence

Each system run writes JSON and text reports under `reports/`. Evidence includes:

- run ID, environment, mode, git commit, API, database, start and finish time
- fixture ID, filename, SHA-256, expected outcome
- cleanup counts before and after reset
- document ID, submission/completion time, final status and error
- extraction job ID, prior job ID, engine, confidence, timestamps, document ownership, source hash match, and freshness
- database `processed_at` freshness
- field, line item, and audit comparisons
- the step where a fixture failed, including submission or polling failures
- overall PASS/FAIL counts

## Fixture maintenance

The committed PDFs normally do not need regeneration. If a fixture must change:

1. Regenerate only that fixture, for example `npm run fixtures -- GOLDEN-INV-106`.
2. Open the resulting PDF and verify every expected value manually.
3. Update the matching JSON and `verifiedOn`.
4. Replace any `DRAFT` verifier only after human verification.

Do not regenerate all scanned fixtures casually. Font and Pillow differences can change PDF bytes and SHA-256 values.
