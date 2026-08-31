# pdf-validation

Reference implementation of two PDF-ingestion validation suites. **All documentation lives in [`pdf_validation_docs/`](pdf_validation_docs/)** — design,
test plans with traceability, setup, and the map from this code to the design:
[golden validation](pdf_validation_docs/README_GOLDEN_PDF_VALIDATION.md)
([test plan](pdf_validation_docs/TEST_PLAN_GOLDEN_PDF_VALIDATION.md)) ·
[random reconciliation](pdf_validation_docs/README_RANDOM_PDF_RECONCILIATION.md)
([test plan](pdf_validation_docs/TEST_PLAN_RANDOM_PDF_RECONCILIATION.md)).

```bash
npm install                  # Node >= 20; tesseract, poppler, ImageMagick — see pdf_validation_docs/README_GOLDEN_PDF_VALIDATION.md § Prerequisites
npm test                     # golden (levels 0–6) + random
npm run test:golden:drafts   # include the DRAFT fixtures
npm run test:golden:remote   # level 5 against PDF_INGEST_API_URL / TEST_DATABASE_URL
npm run validate:pdf -- ./input/some.pdf --db .data/app.sqlite --mask
```

| Directory | Contents |
|---|---|
| `app/` | sample system under test (HTTP API → in-process worker → pdf.js / Tesseract → SQLite) |
| `golden/` | golden suite: `src/` seams (env guard, cleanup, `GoldenDb`, ingestion client, report, system-under-test), `tests/` levels 0–6 |
| `random/` | random suite: reader, locator, rules, normalize, compare, reconcile, review, report, CLI |
| `fixtures/` | `pdf/` committed PDFs, `expected/` hand-verified JSON ([contract](fixtures/expected/README.md)), `gen/` generator |
| `reports/`, `reviews/`, `.data/` | evidence output, human review decisions, local SQLite files |
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
# Random PDF Reconciliation

## Purpose

Use the Random suite to answer one question for a PDF that was not predefined as test data:

> Did this exact PDF get stored correctly?

There is no expected JSON. The PDF is the source document, and QA reads it independently from the production ingestion path.

```text
Unknown PDF
  → calculate SHA-256
  → independently read native text or run QA OCR
  → locate existing database record by hash
  → read database with a read-only connection
  → normalize and compare fields
  → reconcile line items and totals
  → route uncertain OCR to REVIEW
  → apply saved human decisions when available
  → write JSON and text reports
```

This complements Golden testing. Golden validates repeatable regression scenarios by deleting and reprocessing known PDFs; Random validation never deletes or rewrites the record under test.

## Independence and read-only design

The QA reader must not reuse production extraction code. In the reference implementation:

```text
Production: pdf.js / production OCR → database
QA:         Poppler pdftotext → independent OCR fallback → comparison
```

The QA reader uses `pdftotext -layout` for native PDFs. If needed, it independently renders at 300 dpi with `pdftoppm`, preprocesses with ImageMagick, and reads Tesseract TSV so confidence is available per field.

The database is opened read-only. A validator should never `INSERT`, `UPDATE`, `DELETE`, or `TRUNCATE` production data.

## Record identification

SHA-256 of the exact PDF bytes is the primary key for reconciliation.

- One hash match: validate that record.
- No match: `REVIEW`; the validator cannot prove ingestion failed solely from lookup failure.
- Multiple matches: `FAIL` in the reference pipeline because `source_hash` is supposed to be unique.
- Filename is reported only as a weaker candidate signal and is not treated as proof of identity.

## Field rules

`random/src/rules.ts` is the single source for comparison type, requirement, severity, and sensitivity.

| Field | Comparison | Severity | Sensitive |
|---|---|---|---|
| customer name | text: trim, collapse spaces, case-insensitive | HIGH | yes |
| account number | exact string | CRITICAL | yes |
| invoice date | normalized date | HIGH | no |
| amount | integer cents | CRITICAL | no |
| status | case-insensitive enum | MEDIUM | no |

Important rules:

- Exact identifiers never lose leading zeros.
- Money uses integer cents; malformed values become uncertain rather than being guessed.
- Dates normalize to ISO. If a date such as `01/02/2026` is ambiguous and no locale is supplied, the result is `REVIEW`.
- OCR mismatches below the default 90% confidence threshold become `REVIEW`, not automatic database failures.

## Result states

| Status | Meaning |
|---|---|
| `PASS` | PDF and database agree after approved normalization. |
| `FAIL` | A reliable comparison proves the database result is wrong, or the database is internally inconsistent. |
| `REVIEW` | QA extraction, date interpretation, record identity, or source readability is uncertain. |
| `MISSING_PDF` | Database has a value but the QA reader could not find it. Treated as unresolved, not automatically a database defect. |
| `MISSING_DATABASE` | PDF reliably contains a required value but the database does not. Contributes to overall FAIL. |

Overall result is `FAIL` if any definite field/child defect or missing required database value exists; otherwise `REVIEW` if anything remains uncertain; otherwise `PASS`.

## Line items and totals

Child rows are matched by content, not row order. The invoice reference implementation uses normalized description plus integer cents. Add date/reference fields to the key when the real document provides them.

The validator checks all four relationships:

```text
PDF line-item sum  ↔  PDF stated amount
PDF stated amount ↔  DB stored amount
DB line-item sum   ↔  DB stored amount
PDF line-item sum  ↔  DB line-item sum
```

A database-internal mismatch is always `FAIL`. A PDF-internal mismatch is `REVIEW` unless a human review resolves the QA extraction uncertainty.

## Human review

Any `REVIEW` can be resolved for a header field or line item. Allowed decisions:

- `DATABASE_CORRECT`
- `DATABASE_INCORRECT`
- `QA_EXTRACTION_INCORRECT`
- `PDF_AMBIGUOUS`
- `UNABLE_TO_DETERMINE`

Reviews are stored by PDF hash and stable field/line-item key. `DATABASE_CORRECT` and `QA_EXTRACTION_INCORRECT` resolve to PASS; `DATABASE_INCORRECT` resolves to FAIL; ambiguous/undetermined decisions stay REVIEW.

## Security and reporting

Random PDFs may contain real customer information.

- Use read-only database credentials.
- Keep PDFs and reports in approved storage.
- Do not send documents to unapproved external readers.
- Use `--mask` when reports may be shared. Fields marked `sensitive` are masked in both JSON and text output.
- Apply appropriate access and retention rules to PDFs, reports, and review decisions.

Reports include PDF filename/hash, environment, matched record/candidates, independent reader, locale, validation time, field comparisons, OCR confidence, line-item issues/review keys, four-way totals, human decisions, summary counts, and overall result.

## Prerequisites

Required for normal validation:

- Node.js 20+
- npm 10+
- Poppler: `pdftotext` and `pdftoppm`
- Tesseract 5 with `eng` and `osd`
- ImageMagick: `magick` or `convert`
- npm dependencies from `package.json`

The sample SQLite implementation uses `better-sqlite3`; a C/C++ toolchain may be needed if no prebuilt binary is available.

Example macOS install:

```bash
brew install node tesseract poppler imagemagick
npm install
```

Example Debian or Ubuntu CI dependencies:

```bash
sudo apt-get install -y tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd poppler-utils imagemagick build-essential
npm install
```

Quick verification:

```bash
node -v
tesseract --list-langs
pdftotext -v
pdftoppm -v
magick -version || convert -version
npm run typecheck
```

## Running

Validate one PDF:

```bash
npm run validate:pdf -- ./input/some.pdf --db .data/app.sqlite \
  [--locale US|EU] [--mask] [--env staging] [--reviews reviews] [--out reports]
```

Pass `--locale` only when the document's date convention is known. Without it, ambiguous dates are intentionally `REVIEW`.

Record a human decision:

```bash
npm run review -- <sha256> account_number DATABASE_INCORRECT \
  --by tim --value '012345' --reason 'verified against PDF'

npm run review -- <sha256> 'lineItems:repair:15388' QA_EXTRACTION_INCORRECT --by tim
```

Run automated coverage:

```bash
npm run test:random
npm test
```

CLI exit codes: `FAIL` exits 1; `PASS` and `REVIEW` exit 0 so unresolved cases can be reviewed interactively.

## Adapting to another system

Replace only the system-specific seams:

- implement `DocumentReader` for the approved independent reader
- point the locator at the real tables using a SELECT-only account
- update the field rules for the document schema
- extend child-row matching keys when needed

Normalization, comparison, reconciliation, human review, and reporting can remain unchanged.

