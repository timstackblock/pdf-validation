/**
 * WHAT THIS FILE DOES
 *
 * Turns a finished validation result into the two files a tester actually uses: a complete JSON report (every
 * value, for tooling and audit) and a human-readable text report that lists only what needs attention, the
 * line-item reconciliation, the four totals, and the overall result. Both are written to reports/random-<file>-<hash8>.
 * Because random PDFs contain real customer data, this file also does masking: when asked, every value of a field the
 * rulebook marks as sensitive (names, account numbers) is replaced with asterisks except the last two characters, in
 * BOTH the text and the JSON, so a report can be shared or attached to a ticket without leaking identifiers. Which
 * fields are masked comes from rules.ts, so masking cannot drift out of step with the rules. Line-item descriptions
 * are not masked because they describe goods and services, not people.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ValidationReport, FieldRule } from './types';
import { INVOICE_RULES, sensitiveFields } from './rules';

/** Report options: whether to mask sensitive values, and which rulebook says what is sensitive (defaults to the invoice rules). */
export interface ReportOpts { maskIdentifiers?: boolean; rules?: FieldRule[]; }

// Keep the last two characters so a reviewer can still tell two masked values apart; very short values are fully starred.
const maskValue = (v: unknown) => { if (v === null || v === undefined) return v; const s = String(v); return s.length > 4 ? `${'*'.repeat(s.length - 2)}${s.slice(-2)}` : '*'.repeat(s.length); };
// Format whole cents as dollars for the text report (4839217 -> $48392.17).
const cents = (c: unknown) => typeof c === 'number' ? `$${(c / 100).toFixed(2)}` : String(c);

/**
 * Returns a copy of the report with every value of a `sensitive` rule masked — pdf, db, normalized, and any
 * human-verified value. Applied to BOTH the json and the text output so a report of real customer documents can be
 * shared without leaking identifiers. Line-item descriptions are not masked (they are not identifiers).
 */
export function maskReport(r: ValidationReport, rules: FieldRule[] = INVOICE_RULES): ValidationReport {
  const sensitive = sensitiveFields(rules);
  return {
    ...r, masked: true,
    comparisons: r.comparisons.map(c => sensitive.has(c.field)
      ? { ...c, pdfValue: maskValue(c.pdfValue), databaseValue: maskValue(c.databaseValue), normalizedPdfValue: maskValue(c.normalizedPdfValue),
          normalizedDatabaseValue: maskValue(c.normalizedDatabaseValue), reviewed: c.reviewed && { ...c.reviewed, verifiedValue: maskValue(c.reviewed.verifiedValue) } }
      : c),
  };
}

/** Build the human-readable text report. Passing fields are omitted from the field list so the eye goes straight to problems; line items and totals are always shown. */
export function renderText(input: ValidationReport, opts: ReportOpts = {}) {
  // Mask on demand, but never mask twice (a report already masked is used as-is).
  const r = opts.maskIdentifiers && !input.masked ? maskReport(input, opts.rules) : input;
  const L = ['RANDOM PDF VALIDATION', '', `PDF:       ${r.document.filename}`, `SHA256:    ${r.document.hash}`, `Record:    ${r.document.documentId ?? '(none)'}`,
    `Env:       ${r.document.environment}`, `Reader:    ${r.document.readerUsed}`, `Locale:    ${r.document.locale ?? 'unknown'}`, `Validated: ${r.document.validatedAt}${r.masked ? '   (identifiers masked)' : ''}`, ''];
  // A whole-document reason (unreadable PDF, no record found, duplicates) is printed up front.
  if (r.reason) L.push(`NOTE: ${r.reason}`, '');
  // Several candidate records is itself a finding, so list them all with how each matched.
  if (r.candidates.length > 1) { L.push('Candidates:'); r.candidates.forEach(c => L.push(`  ${c.document_id}  (${c.matchedBy})`)); L.push(''); }
  const s = r.summary;
  L.push(`Fields checked: ${s.fieldsChecked}   PASS: ${s.passed}   FAIL: ${s.failed}   REVIEW: ${s.review}   MISSING_PDF: ${s.missingPdf}   MISSING_DB: ${s.missingDatabase}`, '');
  // One block per non-passing field: raw values, normalized values, QA confidence, reason, and any human decision.
  for (const c of r.comparisons.filter(c => c.status !== 'PASS')) {
    L.push(`${c.status}${c.severity === 'CRITICAL' && c.status === 'FAIL' ? ' — CRITICAL' : ''}  ${c.field}`);
    L.push(`  PDF: ${c.pdfValue}   DB: ${c.databaseValue}`);
    L.push(`  normalized: ${c.normalizedPdfValue} vs ${c.normalizedDatabaseValue}${c.confidence !== undefined ? `   QA confidence: ${(c.confidence * 100).toFixed(0)}%` : ''}`);
    if (c.reason) L.push(`  ${c.reason}`);
    if (c.reviewed) L.push(`  reviewed by ${c.reviewed.reviewer} @ ${c.reviewed.timestamp}: ${c.reviewed.decision}`);
    L.push('');
  }
  // Line-item section: counts, the four totals ("n/a" when the PDF side could not be read), each issue with its review key, and the section status.
  if (r.lineItems) {
    const li = r.lineItems, t = li.totals;
    const yn = (b: boolean | null) => b === null ? 'n/a' : b ? 'ok' : 'MISMATCH';
    L.push('Line item reconciliation', `  PDF count: ${li.pdfCount}   DB count: ${li.dbCount}   matched: ${li.matched.length}`,
      `  Totals:  PDF items ${t.pdfLineSumCents === null ? 'n/a' : cents(t.pdfLineSumCents)}  PDF amount ${t.pdfStatedAmountCents === null ? 'n/a' : cents(t.pdfStatedAmountCents)}  DB items ${cents(t.dbLineSumCents)}  DB amount ${cents(t.dbAmountCents)}`,
      `           PDF items == PDF amount: ${yn(t.pdfLinesVsPdfAmount)}   PDF amount == DB amount: ${yn(t.pdfAmountVsDbAmount)}   DB items == DB amount: ${yn(t.dbLinesVsDbAmount)}   PDF items == DB items: ${yn(t.pdfLinesVsDbLines)}`);
    for (const i of li.issues) {
      L.push(`  ${i.status}  ${i.side === 'pdf' ? 'unmatched in DB' : 'extra in DB'}:  ${i.description}  ${i.amount ?? cents(i.amountCents)}${i.confidence !== undefined ? `   QA confidence: ${(i.confidence * 100).toFixed(0)}%` : ''}`);
      L.push(`         ${i.reason}`);
      // The review key is what a tester passes to `npm run review` to rule on this exact item.
      L.push(`         review key: ${i.reviewKey}`);
      if (i.reviewed) L.push(`         reviewed by ${i.reviewed.reviewer} @ ${i.reviewed.timestamp}: ${i.reviewed.decision}`);
    }
    if (li.reason) L.push(`  ${li.reason}`);
    L.push(`  status: ${li.status}`, '');
  }
  L.push(`OVERALL RESULT: ${r.overallResult}`);
  return L.join('\n');
}

/** Write the JSON and text reports side by side, named after the PDF and the first 8 characters of its hash so reports for different files never collide. Returns the text file's path. */
export function writeReport(dir: string, input: ValidationReport, opts: ReportOpts = {}) {
  // Masking is applied once here, so the JSON on disk is masked too, not only the text.
  const r = opts.maskIdentifiers && !input.masked ? maskReport(input, opts.rules) : input;
  mkdirSync(dir, { recursive: true });
  const stem = `random-${r.document.filename.replace(/\.pdf$/i, '')}-${r.document.hash.slice(0, 8)}`;
  writeFileSync(join(dir, `${stem}.json`), JSON.stringify(r, null, 2));
  writeFileSync(join(dir, `${stem}.txt`), renderText(r));
  return join(dir, `${stem}.txt`);
}
