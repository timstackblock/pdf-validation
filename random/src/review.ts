/**
 * WHAT THIS FILE DOES
 *
 * Handles the human side of the process. When the validator cannot decide (REVIEW), a tester looks at the PDF and
 * records a decision; this file saves those decisions and applies them the next time the same PDF is validated, so
 * the report shows the human-settled outcome instead of an open question. Decisions are stored per document in a
 * small file named after the PDF's SHA-256 fingerprint (reviews/<hash>.json), one entry per field or line item, and
 * saving a new decision for a field replaces the old one. Applying a decision follows the business rule from the
 * README: "database was correct" or "QA misread it" turns the item into PASS, "database was wrong" turns it into
 * FAIL, and "ambiguous" or "unable to determine" leaves it as REVIEW. Every applied decision is stamped with the
 * reviewer's name and time so the report shows who overrode the automatic result.
 *
 * Human review overlay: reviews/<hash>.json holds decisions per field; applying them yields the final status.
 * `field` is a top-level db field (account_number, amount_cents, …) OR a line-item key produced by
 * `lineItemReviewKey()` in reconcile.ts, e.g. `lineItems:repair:15388` — printed in every report next to the issue.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { FieldComparison, ReviewRecord } from './types';

export type { ReviewRecord };

/** Load all saved decisions for one document (by hash). No file yet simply means no decisions. */
export function loadReviews(dir: string, hash: string): ReviewRecord[] {
  const p = join(dir, `${hash}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
}
/** Save one decision, replacing any earlier decision for the same field so there is only ever one ruling per field. Creates the reviews folder if needed. */
export function saveReview(dir: string, hash: string, rec: ReviewRecord) {
  mkdirSync(dir, { recursive: true });
  const all = loadReviews(dir, hash).filter(r => r.field !== rec.field);
  writeFileSync(join(dir, `${hash}.json`), JSON.stringify([...all, rec], null, 2));
}

/** Tells a header-field decision apart from a line-item decision, so each is routed to the right part of the validator. */
export const isLineItemReview = (r: ReviewRecord) => r.field.startsWith('lineItems:');

/** Overlay saved decisions onto header-field comparisons. Fields with no decision are returned unchanged. */
export function applyReviews(comparisons: FieldComparison[], reviews: ReviewRecord[]) {
  return comparisons.map(c => {
    const r = reviews.find(x => x.field === c.field);
    if (!r) return c;
    const reviewed = { decision: r.decision, verifiedValue: r.verifiedValue, reviewer: r.reviewer, timestamp: r.timestamp, reason: r.reason };
    switch (r.decision) {
      // The database was right after all, or QA's reader was the one that misread: PASS.
      case 'DATABASE_CORRECT': case 'QA_EXTRACTION_INCORRECT': return { ...c, status: 'PASS' as const, reviewed, reason: `human-verified: ${r.decision}` };
      // A person confirmed the stored value is wrong: FAIL, quoting what the PDF actually says.
      case 'DATABASE_INCORRECT': return { ...c, status: 'FAIL' as const, reviewed, reason: `human-verified: database wrong (PDF says ${JSON.stringify(r.verifiedValue)})` };
      // PDF_AMBIGUOUS / UNABLE_TO_DETERMINE: the question is still open.
      default: return { ...c, status: 'REVIEW' as const, reviewed, reason: `human: ${r.decision}` };
    }
  });
}
