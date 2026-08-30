/**
 * WHAT THIS FILE DOES
 * This is the gatekeeper between "text we found on a page" and "data we are willing to put in the database".
 * It takes the raw, unchecked strings from the reading stage and either converts them into clean, standard
 * values or rejects the whole document with a message naming the field that failed. The guiding business rule
 * is: never store a guess. A wrong invoice total, a mis-typed account number or an impossible date is worse than
 * no record at all, because a bad record looks trustworthy. So money must be a real currency string (converted
 * to whole cents), dates must be real calendar dates in MM/DD/YYYY, account numbers must be exactly six digits,
 * status must be one of Paid / Unpaid / Overdue, and if line items are present they must add up to the total.
 */
import { RawInvoice, Invoice, ValidationError, LineItem } from './types';

/** "$1,250.75" -> 125075. Rejects OCR-style garbage like "$1,25O.75". */
// Convert a printed amount into whole cents. Strips "$", commas and spaces, then insists on digits with at most
// two decimals. If the OCR read a letter "O" as a zero, or anything else odd, we REJECT rather than guess -
// a wrong invoice total is worse than no invoice. Storing cents as a whole number avoids rounding errors.
export function parseCurrency(s: string, field = 'amount'): number {
  const cleaned = s.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) throw new ValidationError(field, `not a currency value: "${s}"`);
  const neg = cleaned.startsWith('-');
  const [whole, frac = ''] = cleaned.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return neg ? -cents : cents;
}

// Convert a date printed as MM/DD/YYYY into the standard YYYY-MM-DD form used in the database. It must be a
// date that really exists (02/30/2025 is rejected), otherwise reports and ageing calculations would be wrong.
export function parseDate(s: string): string {
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) throw new ValidationError('invoiceDate', `expected MM/DD/YYYY, got "${s}"`);
  const [, mm, dd, yyyy] = m;
  // Build the date and check it did not "roll over" (e.g. day 31 in a 30-day month becomes the 1st of the next month).
  const d = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
  if (d.getUTCMonth() !== +mm - 1 || d.getUTCDate() !== +dd) throw new ValidationError('invoiceDate', `invalid date "${s}"`);
  return `${yyyy}-${mm}-${dd}`;
}

// Account numbers are exactly six digits in this business. Anything else (OCR noise, letters, wrong length)
// means the invoice could be matched to the wrong customer, so it is rejected.
export function parseAccountNumber(s: string): string {
  const t = s.trim();
  if (!/^\d{6}$/.test(t)) throw new ValidationError('accountNumber', `expected 6 digits, got "${s}"`);
  return t;
}

// Status must be one of the three agreed words, spelled exactly. Downstream reports group by these values, so
// a variant like "PAID" or "Payed" would silently disappear from the totals - reject it instead.
export function parseStatus(s: string): Invoice['status'] {
  const t = s.trim();
  if (t === 'Paid' || t === 'Unpaid' || t === 'Overdue') return t;
  throw new ValidationError('status', `unknown status "${s}"`);
}

// The main check: turn a RawInvoice into a validated Invoice, or throw a ValidationError naming the first
// problem found. This is the single place where all invoice business rules are applied.
export function transform(raw: RawInvoice): Invoice {
  // Rule 1: every header field must be present. A missing total or account number is not something we can fill in.
  for (const f of ['customerName', 'accountNumber', 'invoiceDate', 'amount', 'status'] as const)
    if (!raw[f]) throw new ValidationError(f, 'missing');
  // Rule 2: every line item amount must be valid currency; numbered 1, 2, 3... in page order.
  const lineItems: LineItem[] = raw.lineItems.map((li, i) => ({
    position: i + 1, description: li.description.trim(), amountCents: parseCurrency(li.amount, `lineItems[${i}].amount`),
  }));
  const amountCents = parseCurrency(raw.amount!);
  // Rule 3: if there are line items, they must add up exactly to the invoice total. A mismatch means either the
  // OCR misread a number or the invoice is wrong - either way we do not want it in the books.
  if (lineItems.length) {
    const sum = lineItems.reduce((s, l) => s + l.amountCents, 0);
    if (sum !== amountCents) throw new ValidationError('lineItems', `sum ${sum} != amount ${amountCents}`);
  }
  // Rules 4-6: account number, date and status each pass their own strict check above.
  return {
    customerName: raw.customerName!.trim(), accountNumber: parseAccountNumber(raw.accountNumber!),
    invoiceDate: parseDate(raw.invoiceDate!), amountCents, status: parseStatus(raw.status!), lineItems,
  };
}
