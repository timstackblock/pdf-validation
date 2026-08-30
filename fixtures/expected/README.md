# Expected JSON — the contract

Each file here is the hand-verified truth for one PDF in `../pdf/`. **Nothing generates these files.**
`fixtures/gen/generate-pdfs.ts` writes PDFs only; if you change a fixture's content you must re-open
the PDF, verify the values by eye, update this JSON, and bump `verifiedOn`.

Fields: `fixtureId` (matches filename and is stored in `invoices.test_fixture_id`), `kind` (`native` |
`scanned` — the golden test asserts the extraction engine used), `expectedOutcome` (`COMPLETED` |
`FAILED`), `verifiedBy`/`verifiedOn`, and `expected` (the exact database values, money as integer cents).

Optional: `allowRejection: true` — for deliberately hard OCR fixtures (ambiguous glyphs). The system may
refuse the document (`FAILED`, zero rows) and still pass; it may **not** `COMPLETE` with any value that
differs from `expected`. Silent corruption is the failure this flag exists to catch.

## Drafts

A `verifiedBy` that starts with `DRAFT` marks an expectation nobody has hand-verified yet. `loadGolden()`
**skips drafts** (with a warning) unless `GOLDEN_INCLUDE_DRAFTS=true`, so an unverified expectation can
never make a default run green. To promote a draft: open the PDF, confirm every value on every page,
replace `verifiedBy` with your name, set `verifiedOn`.

Currently DRAFT: `GOLDEN-INV-007` (leading-zero account number), `GOLDEN-INV-105` (OCR-ambiguous
glyphs, `allowRejection`), `GOLDEN-INV-106` (scanned + multipage). Their PDFs are already committed in
`../pdf/`; run them with `npm run test:golden:drafts`. If you ever need to rebuild one, regenerate that
single id (`npm run fixtures -- GOLDEN-INV-106`) and re-verify its JSON — never `npm run fixtures`
alone, because scanned PDF bytes (and hashes) depend on the local font and Pillow version.
