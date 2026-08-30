/**
 * WHAT THIS FILE DOES
 *
 * Checks the invoice's line items and totals, the part of the document the header comparison does not cover.
 * Each line QA read from the PDF is matched to a stored database line by content (same description, same amount in
 * cents), never by row order, because the order rows are stored in can legitimately change. Any line left over on
 * either side becomes an "issue" the report lists with a stable review key so a human can rule on it. The same
 * fairness rule as for header fields applies: an unmatched PDF line that OCR read with low confidence is REVIEW, not
 * FAIL, and a database extra that such a misread could explain is also REVIEW. Separately, four totals are compared
 * (PDF lines vs PDF stated total, PDF total vs database total, database lines vs database total, PDF lines vs
 * database lines) so a discrepancy can be pinned on the right side. If the database's own lines do not add up to its
 * own stored total, that is a database defect and is always FAIL, no matter how the PDF was read.
 */
import { ExtractedDocument, ExtractedLineItem, LineItemReconciliation, LineItemIssue, ReviewRecord, Status, TotalsReconciliation } from './types';
import { moneyToCents, text } from './normalize';
import { REVIEW_CONFIDENCE_THRESHOLD } from './rules';

/**
 * Stable id for a line item so a human review can target it: `lineItems:<normalized description>:<cents>`.
 * Uses the raw amount string when it cannot be parsed as money, so an OCR-mangled amount is still addressable.
 */
export const lineItemReviewKey = (description: string, amount: string | number | null) => {
  const cents = typeof amount === 'number' ? amount : moneyToCents(amount);
  return `lineItems:${text(description)}:${cents ?? String(amount ?? '').trim()}`;
};

/** Options: the total amount as printed on the PDF (for the totals check), a threshold override, and any saved human reviews for this document's line items. */
export interface ReconcileOpts { pdfAmount?: string; threshold?: number; reviews?: ReviewRecord[]; }

/**
 * Match line items by (normalized description, cents) — never by row position alone.
 * Status logic mirrors the field comparator: a discrepancy on an item the QA reader read with LOW confidence is
 * REVIEW, not FAIL; a database-internal inconsistency (children don't sum to the stored amount) is always FAIL.
 * Human reviews keyed by `lineItemReviewKey` resolve individual items.
 */
export function reconcileLineItems(doc: ExtractedDocument, dbItems: { description: string; amount_cents: number }[], dbAmountCents: number,
  opts: ReconcileOpts = {}): LineItemReconciliation {
  const th = opts.threshold ?? REVIEW_CONFIDENCE_THRESHOLD;
  const reviews = opts.reviews ?? [];
  // Build a "pool" of database rows keyed by content. Each PDF line claims at most one pool row, so two identical PDF lines need two identical database rows.
  const pool = dbItems.map(i => ({ ...i, key: `${text(i.description)}|${i.amount_cents}` }));
  const matched: LineItemReconciliation['matched'] = [], unmatchedPdf: ExtractedLineItem[] = [];
  for (const li of doc.lineItems) {
    const key = `${text(li.description)}|${moneyToCents(li.amount)}`;
    const idx = pool.findIndex(p => p.key === key);
    if (idx >= 0) { matched.push({ description: li.description, amountCents: pool[idx].amount_cents }); pool.splice(idx, 1); }
    else unmatchedPdf.push(li);
  }
  // Whatever is left in the pool is a database row no PDF line accounted for.
  const unmatchedDb = pool.map(({ description, amount_cents }) => ({ description, amount_cents }));

  // ---- four-way totals ------------------------------------------------------------------------
  const pdfCents = doc.lineItems.map(l => moneyToCents(l.amount));
  // The PDF-side sum is only meaningful if every PDF amount could be read as money; otherwise it is null ("unknown"). No lines at all sums to 0.
  const pdfLineSumCents = doc.lineItems.length && pdfCents.every(c => c !== null) ? pdfCents.reduce((s, c) => s + (c as number), 0) : (doc.lineItems.length ? null : 0);
  const pdfStatedAmountCents = opts.pdfAmount === undefined ? null : moneyToCents(opts.pdfAmount);
  const dbLineSumCents = dbItems.reduce((s, i) => s + i.amount_cents, 0);
  // Each check is null ("cannot say") when the PDF side is unknown; the database-internal check is never null because the database is always readable.
  const totals: TotalsReconciliation = {
    pdfLineSumCents, pdfStatedAmountCents, dbLineSumCents, dbAmountCents,
    pdfLinesVsPdfAmount: pdfLineSumCents === null || pdfStatedAmountCents === null || doc.lineItems.length === 0 ? null : pdfLineSumCents === pdfStatedAmountCents,
    pdfAmountVsDbAmount: pdfStatedAmountCents === null ? null : pdfStatedAmountCents === dbAmountCents,
    dbLinesVsDbAmount: dbItems.length === 0 || dbLineSumCents === dbAmountCents,
    pdfLinesVsDbLines: pdfLineSumCents === null ? null : pdfLineSumCents === dbLineSumCents,
  };

  // ---- per-item issues, with confidence and human review applied -----------------------------
  const issues: LineItemIssue[] = [];
  // If a human has already ruled on this issue (matched by review key), replace the automatic status with their decision and record who decided.
  const mark = (issue: LineItemIssue): LineItemIssue => {
    const r = reviews.find(x => x.field === issue.reviewKey);
    if (!r) return issue;
    const reviewed = { decision: r.decision, verifiedValue: r.verifiedValue, reviewer: r.reviewer, timestamp: r.timestamp, reason: r.reason };
    switch (r.decision) {
      // "The database was right" or "QA misread it": the item passes.
      case 'DATABASE_CORRECT': case 'QA_EXTRACTION_INCORRECT': return { ...issue, status: 'PASS', reviewed, reason: `human-verified: ${r.decision}` };
      // A person confirmed the database is wrong: a definite FAIL.
      case 'DATABASE_INCORRECT': return { ...issue, status: 'FAIL', reviewed, reason: `human-verified: database wrong (PDF says ${JSON.stringify(r.verifiedValue ?? issue.amount)})` };
      // PDF_AMBIGUOUS / UNABLE_TO_DETERMINE: still unresolved, stays REVIEW.
      default: return { ...issue, status: 'REVIEW', reviewed, reason: `human: ${r.decision}` };
    }
  };
  // PDF lines the database lacks: FAIL when QA was sure of the reading, REVIEW when it was a low-confidence OCR line that may simply have been misread.
  for (const li of unmatchedPdf) {
    const lowConf = li.confidence !== undefined && li.confidence < th;
    issues.push(mark({ reviewKey: lineItemReviewKey(li.description, li.amount), side: 'pdf', description: li.description, amount: li.amount, amountCents: moneyToCents(li.amount),
      confidence: li.confidence, status: lowConf ? 'REVIEW' : 'FAIL',
      reason: lowConf ? `PDF item not found in database, but read with ${(li.confidence! * 100).toFixed(0)}% confidence — possible OCR error` : 'PDF item not found in database' }));
  }
  // Unmatched DB rows may be the true counterparts of low-confidence PDF misreads: treat as REVIEW while there
  // are at least as many unresolved low-confidence PDF items as DB extras; otherwise the DB has rows the PDF lacks.
  const openLowConfPdf = issues.filter(i => i.side === 'pdf' && i.status === 'REVIEW' && !i.reviewed).length;
  unmatchedDb.forEach((d, n) => {
    // The n-th database extra is "explainable" only while there is an n-th doubtful PDF line to pair it with.
    const explainable = n < openLowConfPdf;
    issues.push(mark({ reviewKey: lineItemReviewKey(d.description, d.amount_cents), side: 'db', description: d.description, amount: null, amountCents: d.amount_cents,
      status: explainable ? 'REVIEW' : 'FAIL',
      reason: explainable ? 'database row has no PDF match, but a low-confidence PDF item may be its misread counterpart' : 'database row has no matching PDF item' }));
  });

  // ---- status -------------------------------------------------------------------------------
  // Priority order: database-internal defect (always FAIL) > any item FAIL > any item REVIEW > PDF-internal inconsistency (REVIEW) > PASS.
  const statuses = new Set(issues.map(i => i.status));
  let status: Status = 'PASS', reason: string | undefined;
  if (!totals.dbLinesVsDbAmount) { status = 'FAIL'; reason = `database line items sum to ${dbLineSumCents} but stored amount is ${dbAmountCents}`; }
  else if (statuses.has('FAIL')) status = 'FAIL';
  else if (statuses.has('REVIEW')) status = 'REVIEW';
  else if (totals.pdfLinesVsPdfAmount === false && !issues.some(i => i.reviewed?.decision === 'QA_EXTRACTION_INCORRECT')) {
    // PDF-internal inconsistency: cannot be blamed on the database -> REVIEW. Skipped once a human has confirmed the
    // QA reading of an item was wrong, because then the PDF-side sum is known to be unreliable.
    status = 'REVIEW'; reason = `PDF line items sum to ${pdfLineSumCents} but the PDF states ${pdfStatedAmountCents}`;
  }

  return { pdfCount: doc.lineItems.length, dbCount: dbItems.length, pdfTotalCents: pdfLineSumCents, dbTotalCents: dbLineSumCents,
    matched, unmatchedPdf, unmatchedDb, totalsAgreeWithAmount: totals.dbLinesVsDbAmount, totals, issues, status, reason };
}
