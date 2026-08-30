/**
 * WHAT THIS FILE DOES
 *
 * This is the rulebook for the Random PDF validator: one small table that lists every invoice field we check, which
 * database column it lives in, how it is compared, whether it must be present, how serious a mismatch is, and whether
 * it is sensitive customer data. Nothing else in the validator decides those things; the comparison, report and
 * masking code all read this table. That means a product decision such as "account numbers must match character for
 * character" or "customer names are private" is changed in one line here and takes effect everywhere. It also sets the
 * OCR confidence threshold (0.90): below it, a disagreement between the PDF and the database is sent to a human as
 * REVIEW rather than declared a FAIL, because QA's own reading may be the thing that is wrong.
 */
import { FieldRule } from './types';
/**
 * The single place that says which field is exact vs normalized, how severe a miss is, and what is sensitive.
 * `sensitive: true` masks the value in text AND json reports when `--mask` / `mask: true` is used.
 */
export const INVOICE_RULES: FieldRule[] = [
  // Names may differ in case or spacing without being wrong, so 'text' comparison; but a wrong name is a HIGH-severity miss and the value is private.
  { pdfField: 'customerName',  dbField: 'customer_name',  type: 'text',  required: true, severity: 'HIGH',     sensitive: true },
  // Account numbers are identifiers: "001234" and "1234" are different accounts, so 'exact'. A mismatch is CRITICAL and the value is private.
  { pdfField: 'accountNumber', dbField: 'account_number', type: 'exact', required: true, severity: 'CRITICAL', sensitive: true },
  // Dates are converted to one standard form before comparing; an ambiguous day/month order is sent to REVIEW rather than guessed.
  { pdfField: 'invoiceDate',   dbField: 'invoice_date',   type: 'date',  required: true, severity: 'HIGH' },
  // Money is compared as whole cents so "$48,392.17" and 4839217 are the same value. A wrong amount is CRITICAL.
  { pdfField: 'amount',        dbField: 'amount_cents',   type: 'money', required: true, severity: 'CRITICAL' },
  // Status is one word from a fixed list; case does not matter. A miss is MEDIUM: wrong but not a financial error.
  { pdfField: 'status',        dbField: 'status',         type: 'enum',  required: true, severity: 'MEDIUM' },
];
/** When QA's reader is less than 90% sure of a value, a mismatch is REVIEW (human decides), not FAIL. Tune per document type and reader technology. */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.90;
/** The set of database column names flagged sensitive, used by the report masker. Derived from the rules so it can never drift out of step with them. */
export const sensitiveFields = (rules: FieldRule[] = INVOICE_RULES) => new Set(rules.filter(r => r.sensitive).map(r => r.dbField));
