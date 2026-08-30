/**
 * WHAT THIS FILE DOES
 * This is the fallback "reading" stage for scanned PDFs - files that are really just pictures of an invoice with
 * no selectable text. It uses OCR (Optical Character Recognition: software that looks at an image and guesses
 * the letters) via three external command-line tools that must be installed on the machine: pdftoppm (turns
 * PDF pages into images), tesseract (the OCR engine) and ImageMagick (rotates pages that were scanned sideways).
 * It returns the recognised text plus a confidence score between 0 and 1 saying how sure the OCR was on
 * average, which is stored against the extraction job for later review. Business rule: if the OCR tools are
 * missing or broken we fail loudly rather than quietly produce a misread invoice.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ExtractionError } from './types';

/** ImageMagick 7 installs may ship only `magick`; IM6 only `convert`. Resolve once. */
// Find whichever name ImageMagick is installed under on this machine. If neither works, OCR cannot fix page
// orientation, so we stop with a clear error instead of misreading a sideways scan.
export function imageMagick(): string {
  for (const bin of ['magick', 'convert']) { try { execFileSync(bin, ['-version'], { stdio: 'pipe' }); return bin; } catch { /* try next */ } }
  throw new ExtractionError('ImageMagick not found (neither `magick` nor `convert` on PATH)');
}
// Remembered answer from imageMagick() so we only probe once per run.
let IM: string | undefined;

/** Real OCR: pdftoppm -> (orientation fix) -> tesseract TSV. Returns text + mean word confidence. */
// Run the full OCR process on one PDF. Works in a temporary folder that is always deleted afterwards, even on
// failure, so no copies of customer invoices are left lying around on disk.
export function ocrPdf(buf: Buffer): { text: string; meanConfidence: number; words: { text: string; conf: number }[] } {
  const dir = mkdtempSync(join(tmpdir(), 'ocr-'));
  try {
    const src = join(dir, 'in.pdf');
    require('fs').writeFileSync(src, buf);
    // Step 1: render every page to a PNG image at 200 dpi (sharp enough for OCR, small enough to be quick).
    try { execFileSync('pdftoppm', ['-r', '200', '-png', src, join(dir, 'p')], { stdio: 'pipe' }); }
    catch (e) { throw new ExtractionError(`pdftoppm failed: ${(e as Error).message}`); }
    const pages = readdirSync(dir).filter(f => f.startsWith('p') && f.endsWith('.png')).sort();
    if (!pages.length) throw new ExtractionError('no pages rendered');

    let text = ''; const words: { text: string; conf: number }[] = [];
    for (const p of pages) {
      let img = join(dir, p);
      // orientation: tesseract OSD tells us how much to rotate
      // Step 2: ask tesseract which way up the page is; if it was scanned rotated, straighten it first, because
      // OCR on a sideways page produces nonsense.
      try {
        const osd = execFileSync('tesseract', [img, '-', '--psm', '0'], { stdio: 'pipe' }).toString();
        const rot = Number(osd.match(/Rotate:\s*(\d+)/)?.[1] ?? 0);
        if (rot) { const r = join(dir, `r-${p}`); execFileSync(IM ??= imageMagick(), [img, '-rotate', String(rot), r], { stdio: 'pipe' }); img = r; }
      } catch (e) {
        // OSD legitimately fails on pages with too little text — continue unrotated. A missing binary or missing
        // osd.traineddata is an environment defect and must surface, not silently degrade into a misread.
        const msg = `${(e as any).stderr ?? ''} ${(e as Error).message}`;
        if (/ENOENT|Error opening data file|Failed loading language|not found/i.test(msg)) throw new ExtractionError(`orientation detection unavailable: ${msg.trim().slice(0, 200)}`);
      }
      // Step 3: run the actual OCR. TSV output gives one row per recognised word with its position and a
      // 0-100 confidence score; we stitch words back into lines using the line number tesseract assigns.
      const tsv = execFileSync('tesseract', [img, '-', 'tsv'], { stdio: 'pipe' }).toString();
      let line = -1, lineText: string[] = [];
      for (const row of tsv.split('\n').slice(1)) {
        const c = row.split('\t'); if (c.length < 12) continue;
        const key = Number(c[4]);
        if (key !== line) { if (lineText.length) text += lineText.join(' ') + '\n'; lineText = []; line = key; }
        if (c[11].trim()) { lineText.push(c[11]); words.push({ text: c[11], conf: Number(c[10]) }); }
      }
      if (lineText.length) text += lineText.join(' ') + '\n';
    }
    // Average confidence across all words, scaled to 0-1 (e.g. 0.92 = OCR was 92% sure on average).
    const conf = words.length ? words.reduce((s, w) => s + w.conf, 0) / words.length / 100 : 0;
    return { text, meanConfidence: Number(conf.toFixed(3)), words };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
