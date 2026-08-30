/**
 * WHAT THIS FILE DOES
 *
 * Produces the 19 "golden" test invoices - the PDFs whose correct answers a person has checked by hand. Each entry
 * in the SPECS list below describes one invoice; this script turns it into a real PDF file in fixtures/pdf/.
 * Some are "native" PDFs (real text a computer can select and copy, like an invoice emailed from accounting
 * software); others are "scanned" (a picture of a page with no text layer, like a paper invoice put through a
 * scanner), which forces the application to use OCR - software that recognises text in an image.
 * Native pages are drawn directly; scanned pages are painted as images by the helper script render_image.py.
 *
 * Generates fixture PDFs ONLY. It never writes fixtures/expected/*.json -
 * those are hand-verified and committed separately (see fixtures/expected/README.md).
 * Re-run only when intentionally changing a fixture, then re-verify the expected JSON by hand.
 */
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Output folder: fixtures/pdf/ next to this script.
const OUT = join(__dirname, '..', 'pdf');
mkdirSync(OUT, { recursive: true });

// The recipe for one fixture. "dpi" (dots per inch) is scan resolution: 200 is a typical office scanner,
// 110-120 is a poor fax-quality scan. "rotate" is degrees the page was turned; "noise" adds blur, speckle and skew.
type Spec = {
  id: string;
  lines: string[];
  pages?: string[][];
  native?: { rotate?: boolean };
  scanned?: { dpi: number; rotate?: number; noise?: boolean };
};

// Builds the lines of text for a simple invoice: customer, account number, date, status, line items and total.
const inv = (name: string, acct: string, date: string, status: string, items: [string, string][], total: string) => [
  'INVOICE', `Customer Name: ${name}`, `Account Number: ${acct}`, `Invoice Date: ${date}`, `Status: ${status}`,
  'Line Items:', ...items.map(([d, a]) => `${d}    ${a}`), `Amount: ${total}`,
];

export const SPECS: Spec[] = [
  // ---- GOLDEN-INV-001..007: native (text) PDFs that must be ingested correctly ----
  // 001: the canonical invoice - a plain two-row invoice from any accounting package. The baseline; if this fails, everything is broken.
  { id: 'GOLDEN-INV-001', native: {}, lines: inv('John Smith', '123456', '08/15/2026', 'Paid', [['Consulting', '$1,000.00'], ['Travel', '$250.75']], '$1,250.75') },
  // 002: a hyphenated customer name and a single-row, unpaid invoice. Catches name handling that splits or mangles on the hyphen.
  { id: 'GOLDEN-INV-002', native: {}, lines: inv('Maria Garcia-Lopez', '654321', '12/01/2026', 'Unpaid', [['Support plan', '$99.00']], '$99.00') },
  // 003: a seven-figure amount and a leap-day date (29 Feb 2028). Catches thousands-separator mistakes, rounding on large
  // numbers, and date logic that wrongly rejects a valid leap day.
  { id: 'GOLDEN-INV-003', native: {}, lines: inv('Acme Corp', '100200', '02/29/2028', 'Overdue', [['Hardware', '$1,200,000.00'], ['Install', '$45,983.25']], '$1,245,983.25') },
  // 004: a two-page invoice - header on page 1, line items and total on page 2. Catches readers that only look at the first page.
  { id: 'GOLDEN-INV-004', native: {}, lines: [], pages: [
      ['INVOICE', 'Customer Name: Multi Page Inc', 'Account Number: 777777', 'Invoice Date: 03/03/2026', 'Status: Paid'],
      ['Line Items:', 'Widget A    $5.05', 'Widget B    $5.05', 'Amount: $10.10']] },
  // 005: the page carries a "display rotated 90 degrees" instruction, as some print-to-PDF tools produce. The text is still
  // real text; catches readers that get confused by the rotation flag.
  { id: 'GOLDEN-INV-005', native: { rotate: true }, lines: inv('Rotated Native', '424242', '07/04/2026', 'Paid', [['Service', '$500.00']], '$500.00') },
  // 006: a zero-amount invoice with no line items at all (e.g. a credit that nets to nothing). Catches code that treats
  // "no rows" or "$0.00" as missing data.
  { id: 'GOLDEN-INV-006', native: {}, lines: inv('Zero Balance LLC', '505050', '01/01/2026', 'Paid', [], '$0.00') },
  // 007: leading zero end to end: the PDF says 012345 and the database must say "012345", never 12345.
  // Catches the classic bug of storing an account number as a number instead of text. Also has a 50-cent line item.
  { id: 'GOLDEN-INV-007', native: {}, lines: inv('Leading Zero Ltd', '012345', '10/10/2026', 'Unpaid', [['Onboarding', '$0.50'], ['Licence', '$1,000.00']], '$1,000.50') },
  // ---- GOLDEN-INV-101..106: scanned = image only, no text layer. Production OCR must read these. ----
  // 101: a clean 200 dpi scan - what a good office scanner produces. The OCR baseline.
  { id: 'GOLDEN-INV-101', scanned: { dpi: 200 }, lines: inv('Scan Clean Co', '808080', '08/20/2026', 'Paid', [['Inspection', '$300.00'], ['Repair', '$1,200.50']], '$1,500.50') },
  // 102: a low-resolution 120 dpi scan, like a fax or a phone photo. Catches OCR that misreads small text.
  { id: 'GOLDEN-INV-102', scanned: { dpi: 120 }, lines: inv('Low Res Ltd', '909090', '05/05/2026', 'Unpaid', [['Retainer', '$2,500.00']], '$2,500.00') },
  // 103: the page was fed into the scanner sideways, so the picture itself is turned 90 degrees (unlike 005, there is no
  // flag to tell the software). Catches OCR that does not detect and correct orientation.
  { id: 'GOLDEN-INV-103', scanned: { dpi: 200, rotate: 90 }, lines: inv('Rotated Scan Inc', '616161', '06/06/2026', 'Overdue', [['Audit', '$750.00']], '$750.00') },
  // 104: a blurred, speckled and slightly skewed scan - a photocopy of a photocopy. Catches OCR that breaks on dirty input.
  { id: 'GOLDEN-INV-104', scanned: { dpi: 200, noise: true }, lines: inv('Noisy Scan Co', '717171', '09/09/2026', 'Paid', [['Cleaning', '$80.00']], '$80.00') },
  // 105: OCR-ambiguous glyphs (0/O, 1/I/l, 5/S, 8/B) in a small, blurred scan. The system may REJECT this one
  // (allowRejection in the expected JSON) but must never COMPLETE with a misread identifier or amount.
  // Real-world: a faded receipt where "S5B8" and "I1l0" are genuinely hard to tell apart. Catches OCR that guesses and stores the guess.
  { id: 'GOLDEN-INV-105', scanned: { dpi: 110, noise: true }, lines: inv('Ambiguous Glyphs Co', '100110', '10/01/2026', 'Overdue', [['Item S5B8', '$1,000.80'], ['Item I1l0', '$505.85']], '$1,506.65') },
  // 106: scanned AND multipage: header on page 1, line items on page 2, total on page 3.
  // Catches OCR pipelines that only process the first page of a scanned document, or that lose the total on its own page.
  { id: 'GOLDEN-INV-106', scanned: { dpi: 200 }, lines: [], pages: [
      ['INVOICE', 'Customer Name: Scanned Pages Inc', 'Account Number: 303303', 'Invoice Date: 11/11/2026', 'Status: Paid'],
      ['Line Items:', 'Survey    $150.00', 'Drafting    $850.00', 'Filing    $75.25'],
      ['Amount: $1,075.25']] },
  // ---- GOLDEN-BAD-201..205: must be rejected. The app must refuse these rather than store bad data. ----
  // 201: the total reads "$1,25O.75" with a letter O - the kind of typo an OCR pass leaves behind. Must be rejected, not stored as $125.75 or similar.
  { id: 'GOLDEN-BAD-201', native: {}, lines: inv('OCR Victim', '111111', '08/15/2026', 'Paid', [['X', '$1,250.75']], '$1,25O.75') },
  // 202: no Amount line at all. An invoice without a total is incomplete and must not be stored with a made-up or zero amount.
  { id: 'GOLDEN-BAD-202', native: {}, lines: ['INVOICE', 'Customer Name: No Amount', 'Account Number: 222222', 'Invoice Date: 08/15/2026', 'Status: Paid'] },
  // 203: the impossible date 30 February. Must be rejected, not quietly rolled forward to 1 or 2 March.
  { id: 'GOLDEN-BAD-203', native: {}, lines: inv('Bad Date', '333333', '02/30/2026', 'Paid', [['X', '$5.00']], '$5.00') },
  // 204: a status ("Pending") that is not one of the allowed values (Paid / Unpaid / Overdue). Catches code that accepts any text as a status.
  { id: 'GOLDEN-BAD-204', native: {}, lines: inv('Weird Status', '444444', '08/15/2026', 'Pending', [['X', '$5.00']], '$5.00') },
  // 205: two $10.00 rows but a stated total of $25.00 - the invoice does not add up. Catches ingestion that never cross-checks rows against the total.
  { id: 'GOLDEN-BAD-205', native: {}, lines: inv('Sum Mismatch', '555555', '08/15/2026', 'Paid', [['A', '$10.00'], ['B', '$10.00']], '$25.00') },
  // (GOLDEN-BAD-206, a file that is not a PDF at all, is written directly at the bottom of this script.)
];

// Builds a "native" PDF: real text drawn onto US-Letter pages (612 x 792 points), one line every 24 points.
async function nativePdf(s: Spec) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of s.pages ?? [s.lines]) {
    const page = doc.addPage([612, 792]);
    if (s.native?.rotate) page.setRotation(degrees(90));
    lines.forEach((l, i) => page.drawText(l, { x: 72, y: 720 - i * 24, size: 12, font }));
  }
  return doc.save();
}

// Builds a "scanned" PDF: asks render_image.py to paint each page as a picture, then embeds that picture as the whole
// page. No text is stored, so the only way to read it is OCR. Landscape pages are used for 90/270 degree rotations.
async function scannedPdf(s: Spec) {
  const o = s.scanned!;
  const doc = await PDFDocument.create();
  for (const [i, lines] of (s.pages ?? [s.lines]).entries()) {
    const png = join(tmpdir(), `${s.id}-${i}.png`);
    execFileSync('python3', [join(__dirname, 'render_image.py'), png, String(o.dpi), String(o.rotate ?? 0), o.noise ? '1' : '0', lines.join('|')]);
    const img = await doc.embedPng(readFileSync(png));
    const page = doc.addPage(o.rotate === 90 || o.rotate === 270 ? [792, 612] : [612, 792]);
    page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    rmSync(png);
  }
  return doc.save();
}

// Turns one spec into PDF bytes. Also used by the random-PDF tests to create never-before-seen invoices on the fly.
export async function buildSpec(s: Spec): Promise<Uint8Array> {
  return s.scanned ? scannedPdf(s) : nativePdf(s);
}

/**
 * `npm run fixtures -- GOLDEN-INV-007 GOLDEN-INV-105`  writes only those fixtures.
 * `npm run fixtures`                                   rewrites ALL of them — every scanned PDF's bytes (and so its
 * hash) depend on the machine's fonts and PIL version, so a full regeneration invalidates every hand verification.
 * ("hash" = the SHA-256 fingerprint of the file's bytes, which the app uses to recognise a document; a regenerated
 * scan is a different picture, so it gets a different fingerprint and no longer matches its hand-checked answers.)
 */
if (require.main === module) {
  (async () => {
    const only = process.argv.slice(2);
    const chosen = only.length ? SPECS.filter(s => only.includes(s.id)) : SPECS;
    const unknown = only.filter(id => !SPECS.some(s => s.id === id) && id !== 'GOLDEN-BAD-206');
    if (unknown.length) { console.error(`unknown fixture id(s): ${unknown.join(', ')}`); process.exit(2); }
    if (!only.length) console.warn('regenerating ALL fixtures — re-verify every fixtures/expected/*.json by hand afterwards');
    for (const s of chosen) writeFileSync(join(OUT, `${s.id}.pdf`), await buildSpec(s));
    // GOLDEN-BAD-206: a file with a .pdf name that is not a PDF (corrupt bytes). The app must reject it cleanly, not crash.
    if (!only.length || only.includes('GOLDEN-BAD-206')) writeFileSync(join(OUT, 'GOLDEN-BAD-206.pdf'), Buffer.from('%PDF-1.4 this is not really a pdf'));
    console.log(`wrote ${chosen.length + (!only.length || only.includes('GOLDEN-BAD-206') ? 1 : 0)} PDFs to ${OUT} (expected JSON untouched)`);
  })();
}
