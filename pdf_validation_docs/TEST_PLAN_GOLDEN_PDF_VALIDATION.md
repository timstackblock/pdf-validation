# Test Plan: Golden PDF Validation

## Objective

Prove that known PDFs are freshly processed through the ingestion pipeline and that newly persisted data exactly matches human verified expectations. The plan is specifically designed to prevent stale database rows or cached extraction results from producing false passes.

## Scope

In scope: safety gates, cleanup, native extraction, OCR, transformation, persistence, API ingestion, asynchronous completion, fresh job proof, field and child row validation, totals, duplicates, negative PDFs, stale data defense, and evidence reporting.

Out of scope: production cleanup, random customer document validation, and performance/load testing.

## Preconditions

- Golden PDFs and expected JSON are committed.
- Non-draft expectations are human verified.
- The target is an isolated test environment.
- Cleanup credentials are restricted to the QA schema.
- The ingestion API, database, and required extraction tools are reachable.
- Remote mode has a working `GoldenDb` adapter.

## Execution flow

For each successful Golden fixture:

```text
safety check
→ delete fixture rows/jobs/cache
→ confirm all matching counts are zero
→ record test start
→ POST PDF
→ poll until terminal status
→ prove new extraction job belongs to this document and source hash
→ prove database row belongs to this run
→ compare fields, line items, audit rows, and totals
→ record evidence
```

Expected failure fixtures follow the same clean start but must finish `FAILED` with no completed invoice data.

## Test cases and rationale

| ID | What is tested | Why this test exists | Expected result | Main coverage |
|---|---|---|---|---|
| **GPDF-001** | Delete an existing Golden fixture and verify every related count is zero. | A stale row can satisfy a later query even if the new processing attempt fails. | Parent, child, document, job, and cache counts are all zero before submission. | `6-stale-data-defense.test.ts`, `cleanup.ts` |
| **GPDF-002** | Cleanup cannot complete. | Destructive setup must fail closed; continuing would make the result untrustworthy. | Submission does not begin and the test fails at cleanup. | `6-stale-data-defense.test.ts` |
| **GPDF-003** | Fresh processing through the HTTP API. | A correct old row is not proof that the current build processed the file. | New document/job IDs and timestamps are created during this run; job belongs to the document and SHA-256. | `5-golden-system.test.ts` |
| **GPDF-004** | Persist every expected field. | The business outcome is correct database data, not merely a successful HTTP response. | All expected values match the new row exactly after defined transformation. | Levels 4–5 |
| **GPDF-005** | Exact identifiers, including leading zeros. | Numeric coercion can corrupt account/reference numbers. | `012345` remains `012345`; no `0/O` forgiveness. | Levels 1–2; draft `GOLDEN-INV-007` adds system coverage when verified. |
| **GPDF-006** | Currency transformation. | Money parsing errors can silently change financial data. | Valid strings become exact integer cents; malformed or over-precision values are rejected. | `2-transform.test.ts`, Golden positives/negatives |
| **GPDF-007** | Date transformation and calendar validity. | Format or impossible-date errors can store incorrect dates. | Valid `MM/DD/YYYY` becomes ISO; impossible or unsupported dates fail. | `2-transform.test.ts`, `GOLDEN-BAD-203` |
| **GPDF-008** | Missing required field. | Partial records must not be accepted as complete. | Processing fails and no invoice is stored. | `GOLDEN-BAD-202`, Level 4–5 |
| **GPDF-009** | OCR-like ambiguous or invalid characters. | OCR errors such as `O` for `0` must not silently corrupt money or identifiers. | Invalid native OCR-style data is rejected; difficult scanned OCR may reject when explicitly allowed but may never complete with wrong values. | `GOLDEN-BAD-201`; draft `GOLDEN-INV-105` |
| **GPDF-010** | Child rows and audit records. | Correct parent fields do not prove related records were recreated correctly. | Line item count, position, description, amount, and expected audit note match. | Levels 3 and 5 |
| **GPDF-011** | Aggregate line item reconciliation. | Correct-looking individual rows can still produce an incorrect invoice total. | Sum of line items equals stored/expected invoice amount; mismatches are rejected. | `2-transform.test.ts`, `GOLDEN-BAD-205`, Levels 4–5 |
| **GPDF-012** | Submit the exact same PDF twice through the API. | Deduplication must work at the real entry point, not only inside database helper code. | First completes; second is `DUPLICATE`; exactly one invoice remains and the first row is unchanged. | `5-golden-system.test.ts`, Level 3 uniqueness tests |
| **GPDF-013** | Corrupt non-PDF input. | Bad files must fail safely rather than create partial data. | Extraction/processing fails and no invoice is written. | `GOLDEN-BAD-206`, Levels 1 and 4–5 |
| **GPDF-014** | Image-only scanned PDF. | Native text extraction does not test OCR. | Direct text extraction does not find the invoice; OCR recovers required data and the system stores the Golden values. | `GOLDEN-INV-101`–`104`, Levels 1 and 5 |
| **GPDF-015** | Physically rotated scanned image. | PDF page metadata rotation is not equivalent to OCRing rotated pixels. | Orientation handling produces correct stored values. | `GOLDEN-INV-103` |
| **GPDF-016** | Multipage field assembly. | Data may be split across pages and must be associated with one document correctly. | Required fields and child rows from all pages are assembled correctly. | `GOLDEN-INV-004`; draft scanned multipage `GOLDEN-INV-106` |
| **GPDF-017** | Current processing fails after old data existed. | This directly proves stale data cannot hide a current regression. | Reset removes old data; forced current failure leaves no completed invoice. Cache reuse is separately proven unsafe and prevented. | `6-stale-data-defense.test.ts` |

## Supporting controls in the test files

These tests support the GPDF cases rather than needing separate business IDs:

| Control | Why it matters | Coverage |
|---|---|---|
| Environment/remote target refusal | Prevents accidental destructive access to production or a non-test database. | `0-env-guard.test.ts` |
| Restricted database access check | String naming alone is not enough; credentials must also be constrained. | `system-under-test.ts`, `GoldenDb.verifyRestrictedAccess()` |
| Extraction remains raw | Transformation defects are easier to locate when extraction does not normalize data. | `1-extract.test.ts` |
| DB UNIQUE, CHECK, foreign key, transaction rollback | Application checks can be bypassed; database integrity must still hold. | `3-db.test.ts` |
| Batch reconciliation | Finds dropped, duplicated, rejected, or financially inconsistent documents across a run. | `4-integration.test.ts` |
| Lookup by `document_id` | Account numbers are not unique enough to prove which row came from this run. | `6-stale-data-defense.test.ts` |
| Evidence survives early failure | A submission or timeout must appear in the report rather than disappearing from attempted totals. | `5-golden-system.test.ts`, `report.ts` |

## Test data

Default verified coverage includes:

- six valid native PDFs covering canonical data, names/status, large money/leap day, multipage, rotated native text, and zero amount
- four verified scanned PDFs covering clean OCR, low resolution, physical rotation, and noisy/skewed OCR
- six expected failures covering malformed money, missing amount, impossible date, invalid status, line item total mismatch, and corrupt bytes

Three additional fixtures are draft-only until manually verified: leading-zero end-to-end, ambiguous OCR glyphs, and scanned multipage.

## Evidence and pass criteria

A Golden run passes only when every attempted fixture reaches its expected terminal outcome and all required evidence agrees.

For successful fixtures, evidence must prove:

- reset completed and zero matching stale data remained
- the PDF was submitted during the run
- the extraction job is new, belongs to the new document, and matches the source hash
- the extraction engine matches the fixture type and is not stale cache reuse
- the database row was created during the run
- every expected field, line item, audit row, and total matches

For expected failures, no completed invoice data may remain.

The report must record run/environment/git identity, API/database target, timestamps, fixture/hash/document/job identity, cleanup counts, final status/error, comparisons, failure step, and final PASS/FAIL totals.

## Entry and exit criteria

**Entry:** safe test environment confirmed; dependencies available; verified fixtures loaded; API/database reachable; cleanup and verification permissions working.

**Exit:** all scheduled fixtures have report entries; no unexplained stale data or cache reuse occurred; all comparisons match expected outcomes; any draft fixtures are excluded unless deliberately requested.

## Recommended execution

```text
Pull request: selected fast/native smoke coverage
Nightly: full verified Golden suite
Pre-release: full verified Golden suite against the deployed test environment
Draft fixtures: manual/targeted runs until promoted
```

Run commands and environment configuration are documented in `README_GOLDEN_PDF_VALIDATION.md`.
