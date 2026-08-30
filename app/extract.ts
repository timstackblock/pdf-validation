/**
 * WHAT THIS FILE DOES
 * This is the "reading" stage for PDFs that already contain real text (as opposed to a scanned picture).
 * It pulls the text layer out of the PDF, decides whether that text actually looks like one of our invoices
 * (if not, the pipeline falls back to OCR - software that reads a picture of text), and then finds the
 * labelled fields on the page: customer name, account number, invoice date, total amount, status, and the
 * list of line items. Everything it returns is still raw text exactly as printed; it deliberately does NOT
 * judge whether the values are valid. That judgement happens in transform.ts, so that one place holds all the
 * business rules.
 */
import { PDFParse } from 'pdf-parse';
import { RawInvoice, ExtractionError } from './types';

/** Native text layer via pdf.js. Returns '' for image-only PDFs. */
// Ask the PDF for its built-in text. A scanned PDF has none and yields an empty string (that is normal, not an
// error). A file that cannot be opened at all raises ExtractionError, which fails the whole document.
export async function extractNativeText(buf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try { return (await parser.getText()).text; }
  catch (e) { throw new ExtractionError(`Unreadable PDF: ${(e as Error).message}`); }
  finally { await parser.destroy(); }
}

/** Does the text contain enough of an invoice to skip OCR? */
// Cheap sanity check: if the built-in text does not even mention "Account Number" and "Amount", we assume the
// PDF is a scan (or garbage) and send it to the slower OCR route instead of trusting empty/useless text.
export const looksLikeInvoice = (text: string) => /Account Number/i.test(text) && /Amount/i.test(text);

// Where each field lives on the page: the label we look for and the text that follows it on the same line.
const FIELD: Record<Exclude<keyof RawInvoice, 'lineItems'>, RegExp> = {
  customerName:  /Customer Name:\s*(.+)/i,
  accountNumber: /Account Number:\s*(.+)/i,
  invoiceDate:   /Invoice Date:\s*(.+)/i,
  amount:        /^\W*Amount:\s*(.+)/im,   // must be at the start of a line so "Amount" inside a line item is not mistaken for the total
  status:        /Status:\s*([A-Za-z]+)/i,   // enum token only; OCR noise after it is ignored
};

/** Text -> raw strings. Tolerates OCR artefacts (stray quotes, dashes) but does NOT normalize values. */
// Turn the page text into a RawInvoice. Any field that cannot be found is simply left empty; the validation
// stage later decides that a missing field means the document is rejected.
export function parseFields(text: string): RawInvoice {
  const raw: RawInvoice = { lineItems: [] };
  // Header fields: find each label, keep what follows it, strip trailing dashes/quotes that OCR often adds.
  for (const [k, re] of Object.entries(FIELD) as [keyof typeof FIELD, RegExp][]) {
    const m = text.match(re);
    if (m) raw[k] = m[1].replace(/[—\-“”"]+\s*$/, '').trim();
  }
  // Line items live between the "Line Items:" heading and the final "Amount:" total line.
  const block = text.split(/Line Items:/i)[1]?.split(/^\W*Amount:/im)[0] ?? '';
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  const AMT = /^\$?[\d,]+\.\d{2}$/;
  for (let i = 0; i < lines.length; i++) {
    // Usual layout: "Description    $123.45" on one line.
    const m = lines[i].match(/^[^A-Za-z0-9]*(.+?)\s+(\$?[\d,]+\.\d{2})\s*$/);
    if (m) { raw.lineItems.push({ description: m[1].trim(), amount: m[2] }); continue; }
    // some extractors emit "description" and "amount" on separate lines
    if (!AMT.test(lines[i]) && i + 1 < lines.length && AMT.test(lines[i + 1])) {
      raw.lineItems.push({ description: lines[i].replace(/^[^A-Za-z0-9]+/, '').trim(), amount: lines[++i] });
    }
  }
  return raw;
}
