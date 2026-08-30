/**
 * WHAT THIS FILE PROVES
 *
 * When the validator reads a value off a PDF and compares it with the value the application stored in the
 * database, it must reach the right verdict: PASS (they agree), FAIL (the database is wrong), REVIEW (a human
 * needs to look), MISSING_DATABASE (the database has nothing) or MISSING_PDF (our own reader found nothing).
 * These tests exercise that decision logic on hand-picked values, with no real PDFs or database involved, so
 * each rule can be checked in isolation. They cover cosmetic differences that must NOT count as errors
 * (spacing, capitalisation, "$1,000.00" vs 100000 cents, "08/28/2026" vs "2026-08-28"), real differences
 * that MUST count, and the cases where the reader's own uncertainty ("OCR confidence" - how sure the
 * text-recognition software is about what it read, from 0 to 1) means the honest answer is "ask a person".
 * They also prove that line items (the rows of an invoice) are matched by content, not row order, that all
 * the totals are cross-checked, and that a human reviewer's recorded decision overrides the automatic verdict.
 * Case IDs such as RPDF-006 refer to the test plan TEST_PLAN_RANDOM_PDF_RECONCILIATION.md.
 */
import { compareField } from '../src/compare';
import { reconcileLineItems } from '../src/reconcile';
import { applyReviews } from '../src/review';
import { moneyToCents, date } from '../src/normalize';
import { FieldRule, ExtractedDocument } from '../src/types';

// The four kinds of field an invoice has, and how strictly each is compared:
// an identifier (exact characters), free text (forgiving of spacing/case), money and a date.
// "severity" says how serious a mismatch is; CRITICAL fields decide the overall verdict on their own.
const acct: FieldRule = { pdfField: 'accountNumber', dbField: 'account_number', type: 'exact', required: true, severity: 'CRITICAL' };
const name: FieldRule = { pdfField: 'customerName', dbField: 'customer_name', type: 'text', required: true, severity: 'HIGH' };
const amt:  FieldRule = { pdfField: 'amount', dbField: 'amount_cents', type: 'money', required: true, severity: 'CRITICAL' };
const dt:   FieldRule = { pdfField: 'invoiceDate', dbField: 'invoice_date', type: 'date', required: true, severity: 'HIGH' };

describe('Field comparator (RPDF cases)', () => {
  // RPDF-002. The account number on the PDF and in the database are identical -> PASS.
  // The most basic "everything is fine" case; if this fails nothing else can be trusted.
  test('RPDF-002 exact identifier match -> PASS', () => expect(compareField(acct, '00123456', '00123456', undefined).status).toBe('PASS'));
  // RPDF-003. The PDF says 00123456 but the database stored 123456 (leading zeros dropped) -> FAIL.
  // Account numbers are labels, not quantities: dropping zeros is data corruption, not tidying.
  test('RPDF-003 leading zero stripped -> FAIL (no identifier normalization)', () => expect(compareField(acct, '00123456', '123456', undefined).status).toBe('FAIL'));
  // RPDF-004. "JOHN   SMITH" vs "John Smith" -> PASS.
  // Extra spaces and capitalisation are presentation differences, not errors; flagging them would bury real problems in noise.
  test('RPDF-004 whitespace/case text normalization -> PASS', () => expect(compareField(name, 'JOHN   SMITH', 'John Smith', undefined).status).toBe('PASS'));
  // RPDF-005. The PDF shows "$48,392.17" and the database stores 4839217 (whole cents) -> PASS.
  // Money is stored as integer cents to avoid rounding errors, so the comparator must translate before comparing.
  test('RPDF-005 currency normalization -> PASS', () => expect(compareField(amt, '$48,392.17', 4839217, undefined).status).toBe('PASS'));
  // RPDF-006. The PDF clearly says $48,392.17 (reader 99.8% confident) but the database has $48,392.71 -> FAIL,
  // and the report must state the exact difference (-0.54) so an analyst can see the transposed digits at a glance.
  test('RPDF-006 currency mismatch, high confidence -> FAIL with difference', () => {
    const c = compareField(amt, '$48,392.17', 4839271, 0.998);
    expect(c.status).toBe('FAIL'); expect(c.reason).toMatch(/difference -0.54/);
  });
  // RPDF-007. Our reader read "021000O21" (letter O) with only 63% confidence; the database has "021000021".
  // Expected: REVIEW, with a note that this looks like an OCR mix-up. We must not blame the database for our own shaky reading.
  test('RPDF-007 low-confidence OCR mismatch -> REVIEW with ambiguity note', () => {
    const c = compareField(acct, '021000O21', '021000021', 0.63);
    expect(c.status).toBe('REVIEW'); expect(c.reason).toMatch(/OCR ambiguity/);
  });
  // RPDF-008. The PDF plainly shows an account number but the database has nothing (NULL) -> MISSING_DATABASE.
  // A distinct verdict from FAIL so that "the app lost the value" is reported differently from "the app stored the wrong value".
  test('RPDF-008 database NULL for a value the PDF clearly has -> MISSING_DATABASE', () =>
    expect(compareField(acct, '12345678', null, undefined).status).toBe('MISSING_DATABASE'));
  // RPDF-009. Our reader could not find the field, but the database has a value -> MISSING_PDF, not FAIL.
  // The database may well be right; the gap is on our side, and a person should look rather than the app being blamed.
  test('RPDF-009 QA reader found nothing but DB populated -> MISSING_PDF (not FAIL)', () =>
    expect(compareField(acct, undefined, '12345678', undefined).status).toBe('MISSING_PDF'));
  // RPDF-015. The PDF prints "08/28/2026" (US style) and the database stores "2026-08-28" -> PASS when told the locale is US.
  // Different date layouts of the same day are not a defect.
  test('RPDF-015 date format normalization -> PASS', () => expect(compareField(dt, '08/28/2026', '2026-08-28', undefined, { locale: 'US' }).status).toBe('PASS'));
  // RPDF-016. "01/02/2026" could be 2 January (US) or 1 February (Europe). With no locale given -> REVIEW, never a guess.
  // Once a locale is supplied, the same string PASSes against whichever day that convention means.
  test('RPDF-016 ambiguous day/month with unknown locale -> REVIEW, never a guess', () => {
    const c = compareField(dt, '01/02/2026', '2026-01-02', undefined, {});
    expect(c.status).toBe('REVIEW'); expect(c.reason).toMatch(/ambiguous/);
    expect(compareField(dt, '01/02/2026', '2026-01-02', undefined, { locale: 'US' }).status).toBe('PASS');
    expect(compareField(dt, '01/02/2026', '2026-02-01', undefined, { locale: 'EU' }).status).toBe('PASS');
  });
  // The reader produced "$1,25O.75" (letter O instead of zero), which is not a valid amount -> REVIEW.
  // We cannot compare garbage, and garbage from our reader is not evidence the database is wrong.
  test('unparseable PDF money -> REVIEW, not FAIL', () => expect(compareField(amt, '$1,25O.75', 125075, undefined).status).toBe('REVIEW'));
  // The money converter must work in whole cents only. A decimal number like 48392.17 is refused, because
  // computers cannot represent such decimals exactly and a one-cent rounding slip would cause false alarms.
  test('money normalizer is integer-cents, never float', () => {
    expect(moneyToCents('$0.10')).toBe(10); expect(moneyToCents(4839217)).toBe(4839217); expect(moneyToCents(48392.17)).toBeNull();
  });
  // 30 February does not exist; the date converter must say "no date" rather than quietly roll it into March.
  test('date normalizer rejects impossible dates', () => expect(date('02/30/2026', 'US')).toBeNull());
});

// Helper: wraps a list of invoice rows in the minimal "document as read from the PDF" shape the reconciler expects.
const doc = (items: ExtractedDocument['lineItems']): ExtractedDocument =>
  ({ lineItems: items, sourceFile: 'x.pdf', sourceHash: 'h', readerUsed: 't', extractionConfidence: {} });

describe('Line item reconciliation (RPDF-010..014)', () => {
  // The database's version of a two-row invoice: Consulting $1,000.00 and Travel $250.75 (stored as cents).
  const db = [{ description: 'Consulting', amount_cents: 100000 }, { description: 'Travel', amount_cents: 25075 }];
  // RPDF-010 / RPDF-011. Same number of rows, same descriptions (ignoring case) and same amounts -> PASS with both rows matched.
  test('RPDF-010/011 counts and values match -> PASS', () => {
    const r = reconcileLineItems(doc([{ description: 'CONSULTING', amount: '$1,000.00' }, { description: 'Travel', amount: '$250.75' }]), db, 125075);
    expect(r.status).toBe('PASS'); expect(r.matched).toHaveLength(2);
  });
  // RPDF-012. The PDF has two rows but the database only kept one -> FAIL, and the report names the row that is missing (Travel).
  // A silently dropped invoice line is exactly the kind of data loss this whole suite exists to catch.
  test('RPDF-012 missing DB transaction -> FAIL, names the unmatched PDF item', () => {
    const r = reconcileLineItems(doc([{ description: 'Consulting', amount: '$1,000.00' }, { description: 'Travel', amount: '$250.75' }]), db.slice(0, 1), 125075);
    expect(r.status).toBe('FAIL'); expect(r.unmatchedPdf[0].description).toBe('Travel');
  });
  // RPDF-013. The database has a row (Travel) that is not on the PDF at all -> FAIL, naming the extra row.
  // Invented rows are as serious as lost ones.
  test('RPDF-013 extra DB transaction -> FAIL, names the extra row', () => {
    const r = reconcileLineItems(doc([{ description: 'Consulting', amount: '$1,000.00' }]), db, 125075);
    expect(r.status).toBe('FAIL'); expect(r.unmatchedDb[0].description).toBe('Travel');
  });
  // RPDF-014. Rows all match, but the invoice total stored in the database ($1,300.00) is not the sum of its rows ($1,250.75) -> FAIL.
  // The books must balance; a total that disagrees with its own detail is a defect even when every row is right.
  test('RPDF-014 line items must sum to the stored amount', () => {
    expect(reconcileLineItems(doc([{ description: 'Consulting', amount: '$1,000.00' }, { description: 'Travel', amount: '$250.75' }]), db, 130000).status).toBe('FAIL');
  });
  // The PDF lists Travel before Consulting; the database lists them the other way round -> still PASS.
  // Rows are matched by what they say, never by their position, so a reordering is not a false alarm.
  test('order-independent matching (never by row position)', () => {
    expect(reconcileLineItems(doc([{ description: 'Travel', amount: '$250.75' }, { description: 'Consulting', amount: '$1,000.00' }]), db, 125075).status).toBe('PASS');
  });
});

describe('Line item confidence and four-way totals', () => {
  const db = [{ description: 'Service A', amount_cents: 100000 }];
  // Our reader saw "$1,OOO.00" (letters O) with 55% confidence; the database has $1,000.00 -> REVIEW, not FAIL.
  // Both the unmatched PDF row and the unmatched database row are flagged for review, and each is given a stable
  // "review key" - a short label a person can quote when recording their decision later.
  test('low-confidence OCR misread of an amount -> REVIEW, not FAIL (matches the field rule)', () => {
    const r = reconcileLineItems(doc([{ description: 'Service A', amount: '$1,OOO.00', confidence: 0.55 }]), db, 100000);
    expect(r.status).toBe('REVIEW');
    expect(r.issues.map(i => [i.side, i.status])).toEqual([['pdf', 'REVIEW'], ['db', 'REVIEW']]);   // the DB extra is the likely counterpart
    expect(r.issues[0].reviewKey).toBe('lineItems:service a:$1,OOO.00');
    expect(r.issues[1].reviewKey).toBe('lineItems:service a:100000');
  });
  // The PDF clearly (99% confidence) shows a "Service B" row the database does not have -> FAIL.
  // Low confidence on some other row must not soften the verdict on a row we read perfectly well.
  test('high-confidence unmatched PDF item -> FAIL even if another item was low confidence', () => {
    const r = reconcileLineItems(doc([{ description: 'Service A', amount: '$1,000.00', confidence: 0.99 }, { description: 'Service B', amount: '$5.00', confidence: 0.99 }]), db, 100000);
    expect(r.status).toBe('FAIL'); expect(r.issues.find(i => i.description === 'Service B')!.status).toBe('FAIL');
  });
  // One shaky PDF row could explain one unmatched database row, but not two. The first extra database row is
  // REVIEW (possibly our misread); the second ("Ghost") has no possible explanation and is FAIL.
  test('more DB extras than low-confidence PDF items -> the surplus is FAIL', () => {
    const r = reconcileLineItems(doc([{ description: 'Service X', amount: '$1.00', confidence: 0.4 }]), [...db, { description: 'Ghost', amount_cents: 1 }], 100001);
    expect(r.issues.filter(i => i.side === 'db').map(i => i.status)).toEqual(['REVIEW', 'FAIL']);
    expect(r.status).toBe('FAIL');
  });
  // The database's own rows add up to $1,000.00 but its stored total is $9,999.99 -> FAIL, always.
  // This check needs nothing from the PDF, so how well we could read the PDF is irrelevant.
  test('DB children not summing to the stored amount is always FAIL, regardless of OCR confidence', () => {
    const r = reconcileLineItems(doc([{ description: 'Service A', amount: '$1,OOO.00', confidence: 0.3 }]), db, 999999);
    expect(r.status).toBe('FAIL'); expect(r.reason).toMatch(/database line items sum to 100000 but stored amount is 999999/);
  });
  // There are four totals in play: sum of PDF rows, the total printed on the PDF, sum of database rows, and the
  // database's stored total. The report must show all four and every pairwise agreement, so nothing is assumed.
  test('all four totals are reconciled explicitly', () => {
    const r = reconcileLineItems(doc([{ description: 'Service A', amount: '$1,000.00' }]), db, 100000, { pdfAmount: '$1,000.00' });
    expect(r.totals).toEqual({ pdfLineSumCents: 100000, pdfStatedAmountCents: 100000, dbLineSumCents: 100000, dbAmountCents: 100000,
      pdfLinesVsPdfAmount: true, pdfAmountVsDbAmount: true, dbLinesVsDbAmount: true, pdfLinesVsDbLines: true });
    expect(r.status).toBe('PASS');
  });
  // The PDF's own rows ($1,000.00) do not add up to the total printed on the PDF ($1,200.00) -> REVIEW.
  // The document itself is inconsistent (or we misread it); that is not evidence the database did anything wrong.
  test('PDF items not summing to the PDF stated amount is REVIEW (PDF-internal, not a database defect)', () => {
    const r = reconcileLineItems(doc([{ description: 'Service A', amount: '$1,000.00' }]), db, 100000, { pdfAmount: '$1,200.00' });
    expect(r.totals.pdfLinesVsPdfAmount).toBe(false); expect(r.totals.pdfAmountVsDbAmount).toBe(false);
    expect(r.status).toBe('REVIEW');
  });
  // When the PDF's printed total was not captured, the checks that need it are reported as "not available" (null),
  // never as a mismatch. Missing information must not be turned into a false alarm.
  test('unknown PDF amount leaves the PDF-side totals as n/a, never a false mismatch', () => {
    const r = reconcileLineItems(doc([{ description: 'Service A', amount: '$1,000.00' }]), db, 100000);
    expect(r.totals.pdfStatedAmountCents).toBeNull(); expect(r.totals.pdfLinesVsPdfAmount).toBeNull(); expect(r.totals.pdfAmountVsDbAmount).toBeNull();
  });
});

describe('Line item human review', () => {
  // Scenario shared by the tests below: the database has Repair $158.88; our reader saw $153.88 at 61% confidence.
  const db = [{ description: 'Repair', amount_cents: 15888 }];
  const pdf = doc([{ description: 'Repair', amount: '$153.88', confidence: 0.61 }]);
  const review = (decision: any, field = 'lineItems:repair:15388') => [{ field, decision, reviewer: 'tim', timestamp: 't', verifiedValue: '$153.88' }];
  // With no human decision recorded, the disagreement is REVIEW and carries a stable key ("lineItems:repair:15388")
  // that stays the same from run to run, so a reviewer's decision can be attached to it reliably.
  test('unreviewed low-confidence disagreement -> REVIEW with a stable key', () => {
    const r = reconcileLineItems(pdf, db, 15888);
    expect(r.status).toBe('REVIEW'); expect(r.issues[0].reviewKey).toBe('lineItems:repair:15388');
  });
  // RPDF-019 (line-item variant). A person checked the PDF and recorded "our reader misread it" for the PDF row and
  // "the database is right" for the database row -> both flags clear and the invoice PASSes, with the reviewer's name kept.
  test('QA_EXTRACTION_INCORRECT on the PDF item and DATABASE_CORRECT on the DB row -> PASS', () => {
    const r = reconcileLineItems(pdf, db, 15888, { reviews: [...review('QA_EXTRACTION_INCORRECT'), ...review('DATABASE_CORRECT', 'lineItems:repair:15888')] });
    expect(r.issues.map(i => i.status)).toEqual(['PASS', 'PASS']); expect(r.status).toBe('PASS');
    expect(r.issues[0].reviewed?.reviewer).toBe('tim');
  });
  // RPDF-020 (line-item variant). A person confirmed the database really is wrong -> FAIL, even though the automatic
  // verdict had been only REVIEW. A human confirmation of a defect is final.
  test('DATABASE_INCORRECT -> FAIL even though OCR confidence was low', () => {
    const r = reconcileLineItems(pdf, db, 15888, { reviews: review('DATABASE_INCORRECT') });
    expect(r.status).toBe('FAIL'); expect(r.issues[0].reason).toMatch(/database wrong/);
  });
  // A recorded decision about some other row (key ...:99999) must not be applied to this one; the verdict stays REVIEW.
  // Prevents one reviewer's decision from accidentally clearing unrelated problems.
  test('a review for a different key does not apply', () => {
    expect(reconcileLineItems(pdf, db, 15888, { reviews: review('DATABASE_CORRECT', 'lineItems:repair:99999') }).status).toBe('REVIEW');
  });
});

describe('Human review overlay (RPDF-019/020)', () => {
  // The RPDF-007 situation again: a low-confidence reading that disagrees with the database.
  const c = compareField(acct, '021000O21', '021000021', 0.63);
  // RPDF-019. A reviewer records that our reader was the one at fault -> the field becomes PASS.
  test('RPDF-019 QA extraction was wrong -> PASS', () =>
    expect(applyReviews([c], [{ field: 'account_number', decision: 'QA_EXTRACTION_INCORRECT', reviewer: 'tim', timestamp: 't' }])[0].status).toBe('PASS'));
  // RPDF-020. A reviewer confirms the database amount is wrong and records the true value from the PDF -> FAIL,
  // and the report quotes that verified value so the fix is unambiguous.
  test('RPDF-020 database confirmed wrong -> FAIL with verified value', () => {
    const r = applyReviews([compareField(amt, '$48,392.17', 4839271, 0.5)], [{ field: 'amount_cents', decision: 'DATABASE_INCORRECT', verifiedValue: '$48,392.17', reviewer: 'tim', timestamp: 't' }])[0];
    expect(r.status).toBe('FAIL'); expect(r.reason).toMatch(/48,392.17/);
  });
});
