/**
 * WHAT THIS FILE DOES
 *
 * This is the judge for header fields. For each rule in the rulebook it takes the value QA read from the PDF, the
 * value production stored in the database, normalizes both into the same form, and issues one verdict: PASS, FAIL,
 * REVIEW, MISSING_PDF or MISSING_DATABASE, always with a plain-English reason. The most important business rule is
 * that QA's reader can be wrong too: when a value came from OCR with confidence below the threshold (90%), a
 * disagreement is REVIEW for a human to settle, never an automatic FAIL against the database. Values that cannot be
 * normalized (unreadable money, a date whose day/month order is unknown) are likewise REVIEW. For money mismatches
 * the numeric difference is included so a tester can see at a glance whether it is a typo or a missing line.
 */
import { FieldRule, FieldComparison, Status, ExtractedDocument } from './types';
import * as N from './normalize';
import { REVIEW_CONFIDENCE_THRESHOLD } from './rules';

/** Options for a comparison: the date convention if known, and an override of the confidence threshold (mainly for tests). */
export interface CompareOpts { locale?: 'US' | 'EU'; threshold?: number; }

/** Pick the right normalizer for a rule's comparison type and apply it. Used on the PDF value and the database value alike. */
export function normalizeBy(type: FieldRule['type'], v: unknown, opts: CompareOpts): unknown {
  switch (type) {
    case 'money': return N.moneyToCents(v);
    case 'text': return N.text(v);
    case 'date': return N.date(v, opts.locale);
    case 'enum': return N.enumToken(v);
    // 'exact' (identifiers): trim only.
    default: return N.exact(v);
  }
}

/** The status logic from the test plan: PASS / FAIL / REVIEW / MISSING_*. A low-confidence mismatch is REVIEW, never FAIL. */
export function compareField(rule: FieldRule, pdfValue: unknown, dbValue: unknown, confidence: number | undefined, opts: CompareOpts = {}): FieldComparison {
  const th = opts.threshold ?? REVIEW_CONFIDENCE_THRESHOLD;
  // "Low confidence" only applies to OCR'd values; native digital text has no confidence figure and is fully trusted.
  const lowConf = confidence !== undefined && confidence < th;
  const base = { field: rule.dbField, severity: rule.severity, pdfValue, databaseValue: dbValue, confidence } as FieldComparison;
  const missing = (v: unknown) => v === undefined || v === null || v === '';

  // QA's reader found nothing. If the database is also empty: REVIEW when the field is required (someone should confirm the PDF truly lacks it), else PASS.
  // If the database has a value: MISSING_PDF, which may just mean our reader missed it, so it is not counted as a database failure.
  if (missing(pdfValue)) return { ...base, normalizedPdfValue: null, normalizedDatabaseValue: normalizeBy(rule.type, dbValue, opts),
    status: missing(dbValue) ? (rule.required ? 'REVIEW' : 'PASS') : 'MISSING_PDF', reason: 'QA reader found no value; may be a reader limitation' };
  // The PDF has a value the database lacks: MISSING_DATABASE (counts as a failure), unless QA read it with low confidence, in which case a human should check.
  if (missing(dbValue)) return { ...base, normalizedPdfValue: normalizeBy(rule.type, pdfValue, opts), normalizedDatabaseValue: null,
    status: lowConf ? 'REVIEW' : 'MISSING_DATABASE', reason: lowConf ? 'PDF value read with low confidence' : 'PDF has a value the database lacks' };

  const np = normalizeBy(rule.type, pdfValue, opts), nd = normalizeBy(rule.type, dbValue, opts);
  // A slash date with no known locale: we refuse to guess month-vs-day, so a human decides.
  if (np && typeof np === 'object' && 'ambiguous' in np) return { ...base, normalizedPdfValue: pdfValue, normalizedDatabaseValue: nd, status: 'REVIEW', reason: 'ambiguous day/month order; locale unknown' };
  // The PDF value could not be read as this type (e.g. "$1,25O.75" with a letter O): not the database's fault, so REVIEW.
  if (np === null) return { ...base, normalizedPdfValue: null, normalizedDatabaseValue: nd, status: 'REVIEW', reason: `PDF value "${pdfValue}" could not be normalized as ${rule.type}` };

  // The core rule: equal -> PASS; different but QA was not sure -> REVIEW; different and QA was sure -> FAIL.
  let status: Status = np === nd ? 'PASS' : lowConf ? 'REVIEW' : 'FAIL';
  let reason: string | undefined;
  if (status !== 'PASS') {
    // For money, show the difference in dollars so the size of the error is obvious.
    if (rule.type === 'money') reason = `difference ${((np as number) - (nd as number)) / 100}`;
    // Characters that OCR commonly confuses (zero/letter O, one/I/l, five/S, eight/B) plus low confidence: point the reviewer at the likely cause.
    if (/[0O1Il5S8B]/.test(String(pdfValue)) && lowConf) reason = 'possible OCR ambiguity (0/O, 1/I, 5/S, 8/B)';
  }
  return { ...base, normalizedPdfValue: np, normalizedDatabaseValue: nd, status, reason };
}

/** Run compareField for every rule in the rulebook against one extracted document and its database row, passing along the reader's confidence for each field. */
export function compareDocument(rules: FieldRule[], doc: ExtractedDocument, row: Record<string, unknown>, opts: CompareOpts = {}) {
  return rules.map(r => compareField(r, (doc as any)[r.pdfField], row[r.dbField], doc.extractionConfidence[r.pdfField], opts));
}
