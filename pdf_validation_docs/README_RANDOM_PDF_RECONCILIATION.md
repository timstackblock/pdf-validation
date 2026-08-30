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
