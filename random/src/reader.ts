/**
 * WHAT THIS FILE DOES
 *
 * This is QA's own, independent way of reading a PDF. The whole point of the Random PDF validator is to compare
 * what production stored against a second, separate reading of the same document; if QA reused production's reader,
 * a bug shared by both would make a wrong value look correct on both sides and pass silently. So this file
 * deliberately uses different tools and different parsing code from the production app. It first tries to copy the
 * text directly out of a digital PDF (fast, fully trusted); if the PDF is a scan with no text layer it falls back to
 * OCR (optical character recognition: turning a picture of text into text), cleaning the image first and recording
 * how confident the OCR engine was for each line. That confidence (0..1) travels with every value so the comparison
 * step can send doubtful mismatches to a human instead of failing the database. Output: an ExtractedDocument of raw
 * strings; nothing is normalized here.
 *
 * QA's independent reader. Deliberately shares NO code with app/extract.ts:
 *  - native text via Poppler `pdftotext -layout` (the app uses pdf.js)
 *  - OCR via tesseract at 300 dpi after despeckle+threshold cleanup, per-line confidence
 *    (the app OCRs the raw 200 dpi render with no preprocessing)
 * Swap in Textract / Document AI / a vision model by implementing DocumentReader.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { DocumentReader, ExtractedDocument } from './types';
import { fileHash } from './hash';
import { imageMagick } from '../../app/ocr';   // binary resolution only (magick vs convert); no extraction logic is shared
let IM: string | undefined;

/** One line of text as read, with the reader's confidence (1 = native digital text, fully trusted). */
interface Line { text: string; conf: number; }

/** Digital PDFs: copy the text layer out with Poppler, keeping the page layout so labels and values stay on the same line. Every line gets confidence 1. */
function popplerLines(path: string): Line[] {
  const out = execFileSync('pdftotext', ['-layout', path, '-'], { stdio: 'pipe' }).toString();
  return out.split('\n').map(t => t.trim()).filter(Boolean).map(text => ({ text, conf: 1 }));
}

/** Scanned PDFs: render each page to an image, straighten and clean it, then OCR it with Tesseract, keeping the lowest word confidence on each line as that line's confidence. Temporary images are always deleted. */
function tesseractLines(path: string): Line[] {
  const dir = mkdtempSync(join(tmpdir(), 'qa-ocr-'));
  try {
    // 300 dpi (dots per inch) is a higher resolution than the production app uses, which is one of the deliberate differences.
    execFileSync('pdftoppm', ['-r', '300', '-png', path, join(dir, 'p')], { stdio: 'pipe' });
    const lines: Line[] = [];
    for (const p of readdirSync(dir).sort()) {
      let img = join(dir, p);
      // Ask Tesseract whether the page is rotated (a scan fed in sideways). If that check fails we assume no rotation rather than aborting.
      const osd = (() => { try { return execFileSync('tesseract', [img, '-', '--psm', '0'], { stdio: 'pipe' }).toString(); } catch { return ''; } })();
      const rot = Number(osd.match(/Rotate:\s*(\d+)/)?.[1] ?? 0);
      const clean = join(dir, `c-${p}`);
      // Straighten, remove scanner speckles, and convert to pure black-and-white so the OCR engine sees crisp letters.
      execFileSync(IM ??= imageMagick(), [img, '-rotate', String(rot), '-despeckle', '-despeckle', '-threshold', '55%', clean], { stdio: 'pipe' });
      // Tesseract's TSV output lists every word with its position and a 0-100 confidence score.
      const tsv = execFileSync('tesseract', [clean, '-', 'tsv'], { stdio: 'pipe' }).toString();
      let key = '', words: string[] = [], confs: number[] = [];
      // A line is only as trustworthy as its least certain word, so the line's confidence is the minimum, scaled to 0..1.
      const flush = () => { if (words.length) lines.push({ text: words.join(' '), conf: Math.min(...confs) / 100 }); words = []; confs = []; };
      for (const row of tsv.split('\n').slice(1)) {
        const c = row.split('\t'); if (c.length < 12) continue;
        // Columns 2-4 identify block/paragraph/line; when they change we have moved to a new line of text.
        const k = `${c[2]}-${c[3]}-${c[4]}`;
        if (k !== key) { flush(); key = k; }
        // Keep real words only (non-empty text with a valid confidence; -1 marks layout rows, not words).
        if (c[11].trim() && Number(c[10]) >= 0) { words.push(c[11]); confs.push(Number(c[10])); }
      }
      flush();
    }
    return lines;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The invoice reader QA uses by default. Implements the DocumentReader contract so it can be swapped for another technology without touching the rest of the validator. */
export class IndependentInvoiceReader implements DocumentReader {
  name = 'poppler+tesseract(300dpi,despeckled)';
  /** Read one PDF and return its header fields and line items as raw strings, with OCR confidence where OCR was used. */
  async extract(filePath: string): Promise<ExtractedDocument> {
    // Try the fast, exact digital-text route first; if it did not even find the "Account Number" label the PDF is a scan, so fall back to OCR.
    let lines = popplerLines(filePath), used = 'poppler-pdftotext';
    if (!lines.some(l => /account\s*number/i.test(l.text))) { lines = tesseractLines(filePath); used = this.name; }

    const doc: ExtractedDocument = { lineItems: [], sourceFile: basename(filePath), sourceHash: fileHash(filePath), readerUsed: used, extractionConfidence: {} };
    // Find the first line matching a "Label: value" pattern and keep the value. Confidence is recorded only for OCR'd text; native text has none and is treated as certain.
    const grab = (field: keyof ExtractedDocument, re: RegExp) => {
      for (const l of lines) { const m = l.text.match(re); if (m) { (doc as any)[field] = m[1].trim(); if (used !== 'poppler-pdftotext') doc.extractionConfidence[field] = l.conf; return; } }
    };
    grab('customerName', /customer\s*name\s*[:;]\s*(.+)/i);
    grab('accountNumber', /account\s*number\s*[:;]\s*(\S+)/i);
    grab('invoiceDate', /invoice\s*date\s*[:;]\s*(\S+)/i);
    grab('status', /status\s*[:;]\s*([A-Za-z]+)/i);
    grab('amount', /^\W*amount\s*[:;]\s*(\S+)/i);

    // Line items live between the "Line Items" heading and the "Amount:" total line.
    const start = lines.findIndex(l => /line\s*items/i.test(l.text));
    const end = lines.findIndex((l, i) => i > start && /^\W*amount\s*[:;]/i.test(l.text));
    if (start >= 0) {
      const block = lines.slice(start + 1, end < 0 ? undefined : end);
      for (let i = 0; i < block.length; i++) {
        // Usual case: "description   $1,234.56" on one line. Each item carries its own line confidence when OCR'd.
        const m = block[i].text.match(/^[^A-Za-z0-9]*(.+?)\s{1,}(\$?[\d,]+\.\d{2})$/);
        if (m) doc.lineItems.push({ description: m[1].trim(), amount: m[2], confidence: used === 'poppler-pdftotext' ? undefined : block[i].conf });
        // OCR sometimes splits a row so the amount lands on the next line; pair them up and skip the consumed line.
        else if (i + 1 < block.length && /^\$?[\d,]+\.\d{2}$/.test(block[i + 1].text))
          doc.lineItems.push({ description: block[i].text.replace(/^[^A-Za-z0-9]+/, ''), amount: block[++i].text });
      }
    }
    return doc;
  }
}
