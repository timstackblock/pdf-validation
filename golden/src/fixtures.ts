/**
 * WHAT THIS FILE DOES
 *
 * This file loads the "golden" test cases: each one is a known PDF plus a hand-verified JSON file
 * describing exactly what the database should contain after that PDF is processed (customer name,
 * account number, amounts in whole cents, line items, and so on). Inputs: the fixtures/pdf and
 * fixtures/expected folders on disk. Output: a list of fixture objects, each carrying the PDF bytes,
 * the expected values, who verified them and when, and the PDF's SHA-256 hash (a fingerprint computed
 * from the file's bytes, unique to that exact file). Risk protected against: an unverified or draft
 * expectation quietly making the whole run look green. Files without verification details are refused
 * outright, and files marked DRAFT are skipped unless a person explicitly opts in.
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

// Where the golden PDFs live, and where their matching expected-values JSON files live.
export const PDF_DIR = join(__dirname, '..', '..', 'fixtures', 'pdf');
export const EXPECTED_DIR = join(__dirname, '..', '..', 'fixtures', 'expected');

// Computes the SHA-256 fingerprint of a file's bytes. The ingestion system stores the same fingerprint,
// which is how the suite links "this exact PDF" to its database rows and detects duplicates.
export const hashBuffer = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

// One expected line item on the invoice: its order on the page, wording and amount in cents.
export interface ExpectedLineItem { position: number; description: string; amountCents: number; }
// One complete golden test case as loaded into memory.
export interface GoldenFixture {
  // Unique id such as GOLDEN-INV-001; whether the PDF has real text ("native") or is an image scan needing
  // OCR ("scanned"); and whether the system is expected to accept (COMPLETED) or reject (FAILED) it.
  fixtureId: string; kind: 'native' | 'scanned'; expectedOutcome: 'COMPLETED' | 'FAILED';
  /**
   * For deliberately hard OCR fixtures (ambiguous glyphs): the system may refuse the document (FAILED) instead
   * of reading it — what it may NOT do is COMPLETE with values that differ from `expected`.
   */
  allowRejection?: boolean;
  // Who checked the expected values by hand and on what date; both are mandatory. Free-text notes are optional.
  verifiedBy: string; verifiedOn: string; notes?: string;
  // The exact database values a correct run must produce. Money is in whole cents (integers), never decimals,
  // so comparisons are exact. Absent for fixtures that are expected to be rejected.
  expected?: { customerName: string; accountNumber: string; invoiceDate: string; amountCents: number; status: string; lineItems: ExpectedLineItem[] };
  // Where the PDF is on disk, its raw bytes, and its SHA-256 fingerprint.
  pdfPath: string; pdf: Buffer; sourceHash: string;
}

/**
 * A golden whose `verifiedBy` starts with "DRAFT" has NOT been hand-verified. It is excluded from every level
 * unless GOLDEN_INCLUDE_DRAFTS=true, so an unverified expectation can never produce a green run by default.
 */
export const isDraft = (verifiedBy: string) => /^DRAFT/i.test(verifiedBy);

// Reads every expected-values JSON file, validates it, pairs it with its PDF, and returns the usable fixtures.
// Drafts are included only when asked for (option or GOLDEN_INCLUDE_DRAFTS=true).
export function loadGolden(opts: { includeDrafts?: boolean } = {}): GoldenFixture[] {
  const includeDrafts = opts.includeDrafts ?? process.env.GOLDEN_INCLUDE_DRAFTS === 'true';
  const out: GoldenFixture[] = [];
  // Files are processed in alphabetical order so runs are predictable.
  for (const f of readdirSync(EXPECTED_DIR).filter(f => f.endsWith('.json')).sort()) {
    const j = JSON.parse(readFileSync(join(EXPECTED_DIR, f), 'utf8'));
    // The file name and the id inside it must agree, otherwise a copy-paste mistake could pair the wrong PDF.
    if (j.fixtureId !== f.replace('.json', '')) throw new Error(`fixtureId mismatch in ${f}`);
    // No verifier or date means nobody has vouched for the values: refuse rather than trust them.
    if (!j.verifiedBy || !j.verifiedOn) throw new Error(`${f} has no verification metadata — refusing unverified golden`);
    const pdfPath = join(PDF_DIR, `${j.fixtureId}.pdf`);
    // Drafts are skipped by default; even when included, a draft whose PDF has not been generated yet is skipped.
    if (isDraft(j.verifiedBy)) {
      if (!includeDrafts) { console.warn(`[golden] skipping DRAFT fixture ${j.fixtureId} (set GOLDEN_INCLUDE_DRAFTS=true to run it)`); continue; }
      if (!existsSync(pdfPath)) { console.warn(`[golden] skipping DRAFT fixture ${j.fixtureId}: ${pdfPath} not generated yet`); continue; }
    }
    // Load the PDF bytes and fingerprint them now, so every later step uses the same hash.
    const pdf = readFileSync(pdfPath);
    out.push({ ...j, pdfPath, pdf, sourceHash: hashBuffer(pdf) });
  }
  return out;
}
// Convenience filters: the fixtures the system should accept, and the ones it should reject.
export const goldenGood = () => loadGolden().filter(g => g.expectedOutcome === 'COMPLETED');
export const goldenBad = () => loadGolden().filter(g => g.expectedOutcome === 'FAILED');
