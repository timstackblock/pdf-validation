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
