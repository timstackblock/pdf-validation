/**
 * WHAT THIS FILE DOES
 * This is the shared "vocabulary" for the whole PDF-to-database pipeline. It defines the shapes of data
 * that move between the stages: what an invoice looks like straight off the page (still messy text), and
 * what it looks like once it has been checked and cleaned (ready for the database). It also defines the
 * two kinds of failure the pipeline can report: "we could not read the PDF at all" versus "we read it, but
 * the values on it do not pass our business checks". Nothing here does any work; it only describes the
 * data so every other file agrees on the same field names and rules.
 */

// One line of an invoice as it appears on the page: text description plus the amount as written (e.g. "$1,250.75").
export interface RawLineItem { description: string; amount: string; }
// An invoice as first pulled off the PDF. Every field is optional because the page may be missing it or
// the text-reading step may have failed to find it. Values are untrimmed, unchecked strings.
export interface RawInvoice {
  customerName?: string; accountNumber?: string; invoiceDate?: string; amount?: string; status?: string;
  lineItems: RawLineItem[];
}
// A cleaned line item: money is stored as whole cents (integer) so totals add up exactly, never as decimals.
export interface LineItem { position: number; description: string; amountCents: number; }
// A fully validated invoice. Every field is required, the date is standardised, money is in cents and the
// status can only be one of the three business-approved words. Only this shape is allowed into the database.
export interface Invoice {
  customerName: string; accountNumber: string; invoiceDate: string; amountCents: number;
  status: 'Paid' | 'Unpaid' | 'Overdue'; lineItems: LineItem[];
}
// Which method produced the text: 'native' (PDF already contained real text), 'tesseract' (OCR - software
// that "reads" a picture of text), or 'cache' (we had already read this exact file before and reused the result).
export type Engine = 'native' | 'tesseract' | 'cache';
// Output of the text-reading stage: the text, how it was obtained, and how confident the OCR was (0-1).
// Confidence is null when there was no OCR, because native text has no guesswork in it.
export interface ExtractionResult { text: string; engine: Engine; meanConfidence: number | null; }

// Raised when the PDF itself cannot be read (corrupt file, OCR tools missing, etc.). The document fails as a whole.
export class ExtractionError extends Error {}
// Raised when we read the page fine but a value breaks a business rule (bad date, wrong account format...).
// It records WHICH field failed so the reason can be shown against the document.
export class ValidationError extends Error {
  constructor(public field: string, msg: string) { super(`${field}: ${msg}`); }
}
