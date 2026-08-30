/**
 * WHAT THIS TEST FILE PROVES
 *
 * Level covered: Level 2 — "raw text in, clean typed record out". Level 1 gave us the values exactly as
 * printed ("$1,250.75", "08/15/2026"). This step converts them into the strict form the database stores:
 * money as whole cents (125075), dates in ISO form (2026-08-15), and identifiers kept letter-for-letter.
 * Anything that cannot be converted with certainty is REJECTED with a named reason — the pipeline never guesses.
 *
 * What "pass" means in business terms: amounts and dates are converted correctly every time, look-alike
 * characters from OCR (letter O for zero, S for 5, B for 8) are caught rather than turned into wrong numbers,
 * line items must add up to the invoice total, and a missing required field is a clear error naming that field.
 *
 * Production bug this would catch: a rounding error that stores $1,250.75 as 125074 cents, a date parser
 * that accepts 30 February, a "helpful" cleanup that drops a leading zero from an account number, or an
 * invoice that is saved with a blank amount.
 *
 * Test-plan cases referenced: GPDF 005 (exact identifiers), GPDF 006 (currency), GPDF 007 (dates),
 * GPDF 008 (missing required field), GPDF 009 (incorrect OCR character), GPDF 011 (totals reconcile).
 */
import { parseCurrency, parseDate, parseAccountNumber, parseStatus, transform } from '../../app/transform';
import { ValidationError } from '../../app/types';

describe('Level 2: raw strings -> typed record', () => {
  // GPDF-006 (Currency Transformation).
  // Scenario: a table of printed money values and the whole-cents number each must become.
  // Expected: "$1,250.75" -> 125075, "$5" -> 500, negatives and zero handled.
  // Why: we store cents as whole numbers so totals never suffer floating-point rounding drift.
  test.each([['$1,250.75', 125075], ['$99.00', 9900], ['$1,245,983.25', 124598325], ['$0.00', 0], ['-$12.50', -1250], ['$5', 500]])(
    'parseCurrency %s -> %i', (s, c) => expect(parseCurrency(s)).toBe(c));
  // GPDF-006 / GPDF-009.
  // Scenario: values that are NOT valid money — a letter O for zero, three decimal places, plain text, blank, letter S for 5.
  // Expected: each is rejected with a ValidationError rather than being coerced into some number.
  // Why: "$1,25O.75" is an OCR misread; silently storing 12575 cents (or 125075) would be a wrong amount with no trace.
  test.each(['$1,25O.75', '$1,250.755', 'abc', '', '$12S.00'])('rejects %s', s => expect(() => parseCurrency(s)).toThrow(ValidationError));

  // GPDF-007 (Date Transformation).
  // Scenario: printed US-style dates (MM/DD/YYYY), including a real leap day.
  // Expected: converted to ISO form (YYYY-MM-DD) that sorts and compares correctly in the database.
  test.each([['08/15/2026', '2026-08-15'], ['02/29/2028', '2028-02-29']])('parseDate %s', (s, iso) => expect(parseDate(s)).toBe(iso));
  // GPDF-007 / GPDF-009.
  // Scenario: impossible or wrongly-formatted dates — 30 February, month 13, already-ISO input, a letter O in the month.
  // Expected: all rejected. Why: an "auto-corrected" date would put an invoice in the wrong period.
  test.each(['02/30/2026', '13/01/2026', '2026-08-15', 'O8/15/2026'])('rejects date %s', s => expect(() => parseDate(s)).toThrow(ValidationError));

  // GPDF-005 / GPDF-009 (exact identifiers; OCR look-alike characters).
  // Scenario: account numbers with a leading zero, with a letter B (OCR for 8), and one digit short.
  // Expected: "012345" is kept exactly; the other two are rejected.
  // Why: an account number is a label — "012345" and "12345" are different customers, and "12345B" is a misread, not a guess to fix.
  test('identifiers are exact — no leading-zero or O/0 forgiveness', () => {
    expect(parseAccountNumber('012345')).toBe('012345');
    expect(() => parseAccountNumber('12345B')).toThrow(ValidationError);
    expect(() => parseAccountNumber('12345')).toThrow(ValidationError);
  });

  // Scenario: the invoice status field.
  // Expected: only values on the approved list (e.g. "Paid") are accepted; "Pending" is refused.
  // Why: reports and dashboards group by status, so an unexpected value would fall through every filter.
  test('status allow-list', () => {
    expect(parseStatus('Paid')).toBe('Paid');
    expect(() => parseStatus('Pending')).toThrow(ValidationError);
  });

  // A realistic Level 1 output (note the untrimmed spaces around the name) used by the three tests below.
  const raw = { customerName: ' John Smith ', accountNumber: '123456', invoiceDate: '08/15/2026', amount: '$1,250.75', status: 'Paid',
    lineItems: [{ description: 'Consulting', amount: '$1,000.00' }, { description: 'Travel', amount: '$250.75' }] };

  // GPDF-004 / GPDF-010 (all fields, including line items).
  // Scenario: the whole raw record is converted at once.
  // Expected: name trimmed, date and amounts converted, and each line item numbered by its position on the page (1, 2, ...).
  // Why: this is the exact shape that gets written to the database; position lets us later prove no line was lost or reordered.
  test('golden record from raw, with positioned line items', () => {
    expect(transform(raw)).toEqual({ customerName: 'John Smith', accountNumber: '123456', invoiceDate: '2026-08-15', amountCents: 125075, status: 'Paid',
      lineItems: [{ position: 1, description: 'Consulting', amountCents: 100000 }, { position: 2, description: 'Travel', amountCents: 25075 }] });
  });
  // GPDF-011 (Aggregate Reconciliation).
  // Scenario: the line items add up to $1,250.75 but the invoice total says $1,300.00.
  // Expected: rejected, with the error stating both numbers.
  // Why: a mismatch means a line was misread or missed; storing it would make the books not balance.
  test('line items that do not sum to Amount are rejected', () => {
    expect(() => transform({ ...raw, amount: '$1,300.00' })).toThrow(/lineItems: sum 125075 != amount 130000/);
  });
  // GPDF-008 (Missing Required Field).
  // Scenario: the amount is absent altogether.
  // Expected: rejected, and the error message starts with the field name ("amount: missing").
  // Why: a missing required value must never become an empty column; and naming the field makes triage immediate.
  test('names the missing field', () => {
    expect(() => transform({ ...raw, amount: undefined })).toThrow(/^amount: missing/);
  });
});
