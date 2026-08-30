/**
 * WHAT THIS TEST FILE PROVES
 *
 * Level covered: Level 1 — "PDF in, raw text fields out". This is the very first step of the pipeline:
 * reading the PDF and pulling out the labelled values (customer name, account number, date, amount, status,
 * line items) exactly as they appear on the page. NOTHING is cleaned up or converted yet — that is Level 2.
 *
 * Two kinds of PDF are covered:
 *   - "native" PDFs: the text is embedded in the file, so it can be read directly.
 *   - "scanned" PDFs: the file is just a picture of a page. The text has to be recovered with OCR
 *     (Optical Character Recognition — software that "reads" letters out of an image). We use a real
 *     OCR engine called Tesseract, not a stand-in, so these tests prove the real thing works.
 *
 * What "pass" means in business terms: for every approved sample invoice ("golden fixture"), the pipeline
 * finds the right values on the page, keeps them exactly as printed (leading zeros included), refuses to
 * guess at broken files, and does not quietly "fix" bad characters that a later step needs to see.
 *
 * Production bug this would catch: a change to the text reader that drops a leading zero from an account
 * number, loses a line item, accepts a corrupted file, or fails to OCR scanned invoices at all.
 *
 * Test-plan cases referenced: GPDF 005 (exact identifiers), GPDF 013 (corrupted PDF), GPDF 014 (scanned PDF).
 */
import { extractNativeText, parseFields, looksLikeInvoice } from '../../app/extract';
import { ocrPdf } from '../../app/ocr';
import { ExtractionError } from '../../app/types';
import { goldenGood, loadGolden } from '../src/fixtures';
import { buildSpec } from '../../fixtures/gen/generate-pdfs';

// Helpers that pick out the approved sample PDFs by type.
const native = () => goldenGood().filter(g => g.kind === 'native');
const scanned = () => goldenGood().filter(g => g.kind === 'scanned');
// fixtures that are allowed to be rejected (ambiguous glyphs) are exercised at level 5, where "FAILED" is acceptable
const scannedStrict = () => scanned().filter(g => !g.allowRejection);

describe('Level 1: PDF -> raw fields', () => {
  // Scenario: every native (text-embedded) sample invoice is read directly.
  // Expected: each required field is found and has the shape printed on the page — a 6-digit account
  // number, a MM/DD/YYYY date, an amount starting with "$".
  // Why: if the reader cannot even locate the fields, nothing downstream can be right.
  test.each(native())('$fixtureId native text layer parses to raw strings', async ({ pdf }) => {
    const raw = parseFields(await extractNativeText(pdf));
    expect(raw).toMatchObject({ customerName: expect.any(String), accountNumber: expect.stringMatching(/^\d{6}$/),
      invoiceDate: expect.stringMatching(/^\d{2}\/\d{2}\/\d{4}$/), amount: expect.stringMatching(/^\$/), status: expect.any(String) });
  });

  // GPDF-005 (Preserve Exact Identifiers).
  // Scenario: an invoice whose account number starts with a zero ("012345").
  // Expected: the zero is kept — we get the 6-character text "012345", not the number 12345.
  // Why: account numbers are labels, not quantities. Dropping the zero would point money at the wrong account.
  test('GPDF-005: leading zero survives extraction — "012345" stays a 6-character string', async () => {
    // Built on the fly so this runs even while GOLDEN-INV-007 is still a DRAFT fixture.
    const pdf = Buffer.from(await buildSpec({ id: 'LEADING-ZERO', native: {}, lines: ['INVOICE', 'Customer Name: Zero', 'Account Number: 012345', 'Invoice Date: 10/10/2026', 'Status: Paid', 'Line Items:', 'Amount: $0.00'] }));
    expect(parseFields(await extractNativeText(pdf)).accountNumber).toBe('012345');
  });

  // Scenario: our reference invoice GOLDEN-INV-001 is read and compared value-for-value.
  // Expected: every field, including both line items, comes out EXACTLY as printed ("$1,250.75", "08/15/2026").
  // Why: this pins down that Level 1 does no conversion at all — it is a faithful copy of the page.
  test('exact raw values for GOLDEN-INV-001, including line items untransformed', async () => {
    const g = loadGolden().find(x => x.fixtureId === 'GOLDEN-INV-001')!;
    expect(parseFields(await extractNativeText(g.pdf))).toEqual({
      customerName: 'John Smith', accountNumber: '123456', invoiceDate: '08/15/2026', amount: '$1,250.75', status: 'Paid',
      lineItems: [{ description: 'Consulting', amount: '$1,000.00' }, { description: 'Travel', amount: '$250.75' }],
    });
  });

  // Scenario: a scanned (image-only) invoice is passed to the DIRECT text reader, skipping OCR.
  // Expected: it finds no invoice — because there is genuinely no embedded text to find.
  // Why: this proves our scanned samples really are images. If they secretly contained text, the OCR
  // tests below would be passing for the wrong reason.
  test.each(scanned())('$fixtureId has NO text layer — direct extraction must not find an invoice', async ({ pdf }) => {
    expect(looksLikeInvoice(await extractNativeText(pdf))).toBe(false);
  });

  // GPDF-014 (Scanned Image PDF).
  // Scenario: each scanned sample is run through the real Tesseract OCR engine.
  // Expected: the account number matches the approved value, the right number of line items is found,
  // and the OCR engine reports it was reasonably confident (above 70%).
  // Why: a large share of real invoices arrive as scans; if OCR degrades, those customers' data is wrong.
  test.each(scannedStrict())('$fixtureId real OCR (tesseract) recovers the key fields', ({ pdf, expected }) => {
    const o = ocrPdf(pdf);
    const raw = parseFields(o.text);
    expect(raw.accountNumber).toBe(expected!.accountNumber);
    expect(raw.lineItems).toHaveLength(expected!.lineItems.length);
    expect(o.meanConfidence).toBeGreaterThan(0.7);
  });

  // Scenario: a deliberately bad invoice whose amount contains the letter O instead of the digit 0 ("$1,25O.75").
  // Expected: Level 1 hands it on untouched — it does NOT silently "correct" the O to a 0.
  // Why: correcting would hide an OCR misread. The decision to reject belongs to Level 2, which needs to see the real text.
  test('extraction does not transform: OCR-style garbage passes through untouched', async () => {
    const g = loadGolden().find(x => x.fixtureId === 'GOLDEN-BAD-201')!;
    expect(parseFields(await extractNativeText(g.pdf)).amount).toBe('$1,25O.75');
  });

  // GPDF-013 (Corrupted PDF).
  // Scenario: a file that is not a readable PDF at all.
  // Expected: the reader raises a specific "ExtractionError" instead of returning empty or partial data.
  // Why: a broken upload must be reported as broken, never stored as an invoice with blank fields.
  test('corrupt PDF throws ExtractionError', async () => {
    const g = loadGolden().find(x => x.fixtureId === 'GOLDEN-BAD-206')!;
    await expect(extractNativeText(g.pdf)).rejects.toBeInstanceOf(ExtractionError);
  });
});
