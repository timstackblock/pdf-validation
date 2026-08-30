# Test Plan: Random PDF Reconciliation

## Objective

Validate an individual, previously unknown PDF against the data already stored for that exact document, without creating a Golden expected dataset and without modifying the database under test.

The PDF is the source document. QA uses an independent reader because reusing the production parser could reproduce the same defect and create a false pass.

## Scope

In scope: SHA-256 record matching, independent native/OCR extraction, read-only database access, field normalization, confidence-aware comparison, line-item matching, four-way financial reconciliation, human review, masking, and evidence reporting.

Out of scope: deleting/reprocessing production data, Golden regression testing, and performance testing.

## Preconditions

- QA has the exact PDF that was originally processed.
- The relevant database is reachable with read-only credentials.
- The document schema and comparison rules are defined.
- An approved reader independent of production extraction is available.
- Sensitive-data handling requirements are satisfied.

## Validation flow

```text
PDF → SHA-256 → independent reader → locate database record → compare fields
    → compare child rows → reconcile totals → apply human reviews → report
```

No record is modified during validation.

## Test cases and rationale

| ID | What is tested | Why this test exists | Expected result | Main coverage |
|---|---|---|---|---|
| **RPDF-001** | Locate by exact PDF SHA-256. | Filename/customer metadata can identify the wrong record. | Exactly one hash match is selected. | `reconciliation.test.ts`, `locator.ts` |
| **RPDF-002** | Exact identifier match. | Identifiers are not ordinary numbers. | Same string, including leading zeros, is PASS. | `comparator.test.ts` |
| **RPDF-003** | Identifier mismatch after leading-zero loss. | Numeric coercion can point to a different account. | `00123456` vs `123456` is FAIL. | `comparator.test.ts` |
| **RPDF-004** | Text normalization. | Case and harmless spacing should not create false failures. | Equivalent normalized names are PASS. | `comparator.test.ts` |
| **RPDF-005** | Money normalization. | Display formatting differs from integer database storage. | `$48,392.17` equals `4839217` cents. | `comparator.test.ts` |
| **RPDF-006** | Reliable money mismatch. | Financial differences must be explicit and measurable. | High-confidence mismatch is CRITICAL FAIL with numeric difference. | `comparator.test.ts`, `reconciliation.test.ts` |
| **RPDF-007** | Low-confidence OCR mismatch. | QA's independent OCR can be wrong; uncertainty must not falsely accuse the database. | Below-threshold mismatch is REVIEW with confidence/reason. | Both Random test files |
| **RPDF-008** | PDF contains required value but DB does not. | Missing persisted data is a data-integrity defect. | `MISSING_DATABASE`; overall FAIL when reliable. | `comparator.test.ts`, integration coverage |
| **RPDF-009** | QA reader finds no value but DB has one. | Reader limitations are not proof that production is wrong. | `MISSING_PDF`; overall REVIEW unless resolved. | `comparator.test.ts` |
| **RPDF-010** | Child-row count. | Parent fields can be correct while transactions/line items are lost. | Counts agree when all expected rows are stored. | `comparator.test.ts` |
| **RPDF-011** | Child-row values, independent of order. | Database sorting may differ from document order. | Rows match by content, not position. | `comparator.test.ts` |
| **RPDF-012** | Missing database child row. | Dropped line items change the stored dataset and often totals. | FAIL and identify the unmatched PDF item; low-confidence OCR may first REVIEW. | Both Random test files |
| **RPDF-013** | Extra database child row. | Data not present in the document must not appear in persistence. | FAIL and identify the extra DB row unless a low-confidence PDF misread plausibly explains it. | `comparator.test.ts` |
| **RPDF-014** | Four-way financial reconciliation. | Field equality alone can miss internally inconsistent parent/child data. | PDF rows, PDF amount, DB rows, and DB amount reconcile; DB-internal inconsistency is always FAIL. | `comparator.test.ts`, `reconcile.ts` |
| **RPDF-015** | Known date-format normalization. | Equivalent date representations should compare consistently. | Known US/EU format normalizes to the same ISO date. | `comparator.test.ts` |
| **RPDF-016** | Ambiguous date with unknown locale. | Guessing `01/02/2026` can silently change a date. | REVIEW until locale or human verification resolves it. | Both Random test files |
| **RPDF-017** | No matching database record. | Lookup failure alone does not prove ingestion failed; identity may be incomplete. | REVIEW with a clear reason. | `reconciliation.test.ts` |
| **RPDF-018** | Multiple records share one source hash. | The reference pipeline requires unique hashes; duplicates indicate persistence failure. | FAIL and list every candidate. | `reconciliation.test.ts` |
| **RPDF-019** | Human verifies QA extraction was wrong or DB was correct. | Automated OCR uncertainty needs a controlled resolution path. | Saved decision changes the affected field/line item to PASS. | Both Random test files, `review.ts` |
| **RPDF-020** | Human confirms database is wrong. | Manual verification must be able to turn an uncertain comparison into a definite defect. | Saved decision changes the affected field/line item to FAIL and records verified value/reviewer. | Both Random test files, `review.ts` |

## Supporting controls in the test files

| Control | Why it matters | Coverage |
|---|---|---|
| Independent native reader and independent OCR | Prevents shared production parser defects from creating false passes. | `reader.ts`, `reconciliation.test.ts` |
| Read-only connection | The validator is evidence tooling, not a data repair tool. | `locator.ts`, `reconciliation.test.ts` |
| Reader failure becomes REVIEW | An unreadable source is not automatically a database defect and should still produce a usable report. | `reconciliation.test.ts`, `validate.ts` |
| Low-confidence line-item pairing | OCR uncertainty applies to child rows as well as header fields. | `comparator.test.ts`, `reconcile.ts` |
| Stable line-item review keys | Human decisions must apply to the exact unresolved row on future runs. | `reconcile.ts`, both test files |
| Mask sensitive fields in JSON and text | Reports may contain customer data and must be safe to share when masking is requested. | `report.ts`, `reconciliation.test.ts` |
| Database-internal total mismatch always fails | OCR confidence cannot excuse contradictory values already stored in the database. | `comparator.test.ts` |

## Status and severity rules

- `PASS`: normalized values agree.
- `FAIL`: reliable mismatch or database-internal inconsistency.
- `REVIEW`: OCR/date/identity/source uncertainty requires a person.
- `MISSING_PDF`: QA reader did not find a database value; unresolved, not automatically a database defect.
- `MISSING_DATABASE`: PDF reliably contains a required value that was not stored.

Field severities in the invoice reference implementation are: account and amount `CRITICAL`, name/date `HIGH`, status `MEDIUM`.

Default OCR review threshold is 90%.

## Evidence and pass criteria

The report must capture:

- PDF filename and SHA-256
- environment, independent reader, locale, and validation time
- selected record and all candidates when identity is ambiguous
- raw/normalized PDF and database values, confidence, severity, status, and reason
- line-item counts, matched/unmatched rows, stable review keys, and human decisions
- all four financial total checks
- summary counts and overall result
- masking state when sensitive fields are hidden

A validation is complete when every field and child-row issue has a status. `REVIEW` may remain open for interactive QA; a final business decision requires those items to be resolved or explicitly accepted as unresolved.

## Entry and exit criteria

**Entry:** exact source PDF available; read-only database access works; independent reader available; rules and privacy controls defined.

**Exit:** record identity is documented; all comparisons/totals completed where data is readable; human decisions are applied when supplied; JSON/text evidence is saved; the database remains unchanged.

## Recommended use

Run Random reconciliation on demand for production-like or customer documents that need data-level verification. Promote useful, human-verified edge cases into the Golden suite when they should become permanent regression coverage.

Commands, reader behavior, masking, and review workflow are documented in `README_RANDOM_PDF_RECONCILIATION.md`.
