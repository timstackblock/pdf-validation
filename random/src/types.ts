/**
 * WHAT THIS FILE DOES
 *
 * This file is the shared vocabulary of the Random PDF validator: it defines the shapes of the data every other
 * file passes around, and contains no logic of its own. The validator takes any customer PDF, reads it with QA's own
 * independent reader, finds the matching database record, and compares field by field. The results are always one
 * of a fixed set of outcomes (PASS, FAIL, REVIEW, MISSING_PDF, MISSING_DATABASE) so that a report reads the same way
 * for every document. Keeping the types here means a change to, say, what a "field comparison" contains is made in
 * exactly one place. The QA data model is deliberately NOT the production database schema: it holds raw text as read
 * from the PDF, and turning that text into comparable values happens later, in the comparison step.
 */

/** How bad a mismatch on a field is. CRITICAL means money or account identity; LOW is cosmetic. Drives the "critical failures" count in the report. */
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
/** How a field is compared: 'exact' (identifiers, character for character), 'text' (names, ignoring case and spacing), 'money' (whole cents), 'date' (calendar date), 'enum' (a fixed list of allowed words such as an invoice status). */
export type ComparisonType = 'exact' | 'text' | 'money' | 'date' | 'enum';
/** Outcome of one check. REVIEW means "a human must look"; MISSING_PDF means QA's reader found nothing but the database has a value; MISSING_DATABASE is the reverse. */
export type Status = 'PASS' | 'FAIL' | 'REVIEW' | 'MISSING_PDF' | 'MISSING_DATABASE';

/** One line of the invoice as QA read it. Amount stays as raw text (e.g. "$1,250.00"); confidence is 0..1 and only present when OCR was used. */
export interface ExtractedLineItem { description: string; amount: string; confidence?: number; }
/** Everything QA's independent reader pulled out of one PDF. All header values are optional raw strings because the reader may fail to find some of them. */
export interface ExtractedDocument {
  customerName?: string; accountNumber?: string; invoiceDate?: string; amount?: string; status?: string;
  lineItems: ExtractedLineItem[];
  // sourceHash is the SHA-256 fingerprint of the file bytes, used to find the production record; readerUsed says which reading method produced these values.
  sourceFile: string; sourceHash: string; readerUsed: string;
  // "OCR confidence" is the reader's own estimate of how sure it is about each value. Text copied straight from a digital PDF has no entry here and is treated as fully trusted.
  extractionConfidence: Record<string, number>;   // 0..1 per field; absent = native text (treated as 1)
}
/** The plug-in contract for any reader (Poppler/Tesseract today; Textract, Document AI or a vision model tomorrow). The rest of the validator never changes when the reader does. */
export interface DocumentReader { name: string; extract(filePath: string): Promise<ExtractedDocument>; }

/** One row of the field-rules table: which PDF field maps to which database column, how it is compared, whether it must be present, and how serious a miss is. */
export interface FieldRule {
  pdfField: keyof ExtractedDocument; dbField: string; type: ComparisonType; required: boolean; severity: Severity;
  /** Masked in every report output (text AND json) when masking is requested. */
  sensitive?: boolean;
}

/** The five verdicts a human reviewer may record for a REVIEW item. Only DATABASE_INCORRECT turns into a FAIL; the two "database was right after all" verdicts become PASS; the rest stay REVIEW. */
export type ReviewDecision = 'DATABASE_CORRECT' | 'DATABASE_INCORRECT' | 'QA_EXTRACTION_INCORRECT' | 'PDF_AMBIGUOUS' | 'UNABLE_TO_DETERMINE';
/** A stored human decision: which field (or line-item review key), what was decided, by whom, when, and optionally the value the reviewer confirmed by eye. */
export interface ReviewRecord { field: string; decision: ReviewDecision; verifiedValue?: unknown; reviewer: string; timestamp: string; reason?: string; }
/** The same decision as attached to a comparison in the report, so a reader can see that a human overrode the automatic result. */
export interface ReviewedMark { decision: ReviewDecision; verifiedValue?: unknown; reviewer: string; timestamp: string; reason?: string; }

/** The result of checking one field: what the PDF said, what the database holds, both after normalization, how confident QA's reader was, and the verdict with a plain-English reason. */
export interface FieldComparison {
  field: string; severity: Severity; pdfValue: unknown; databaseValue: unknown;
  normalizedPdfValue: unknown; normalizedDatabaseValue: unknown; confidence?: number; status: Status; reason?: string;
  reviewed?: ReviewedMark;
}

/** One line-item discrepancy, addressable by `reviewKey` in a human review (see reconcile.ts). */
export interface LineItemIssue {
  // side says where the orphan row lives: 'pdf' = QA saw a line the database lacks; 'db' = the database has a line the PDF lacks.
  reviewKey: string; side: 'pdf' | 'db'; description: string; amount: string | null; amountCents: number | null;
  confidence?: number; status: Status; reason: string; reviewed?: ReviewedMark;
}

/** The "four-way totals" check: line items are summed on each side and compared with each side's stated total, so a bad total can be traced to the PDF, the database, or the row set. Amounts are whole cents. */
export interface TotalsReconciliation {
  pdfLineSumCents: number | null; pdfStatedAmountCents: number | null; dbLineSumCents: number; dbAmountCents: number;
  /** PDF line items == PDF stated amount (PDF-internal; null when the PDF side could not be read). */
  pdfLinesVsPdfAmount: boolean | null;
  /** PDF stated amount == DB amount (null when the PDF amount could not be read). */
  pdfAmountVsDbAmount: boolean | null;
  /** DB line items == DB amount (DB-internal — false is always a database defect). */
  dbLinesVsDbAmount: boolean;
  /** PDF line items == DB line items. */
  pdfLinesVsDbLines: boolean | null;
}

/** The full line-item section of a report: counts, which rows matched, which did not on each side, the totals check, each unmatched row as an issue, and an overall status for the section. */
export interface LineItemReconciliation {
  pdfCount: number; dbCount: number; pdfTotalCents: number | null; dbTotalCents: number;
  matched: { description: string; amountCents: number }[]; unmatchedPdf: ExtractedLineItem[]; unmatchedDb: { description: string; amount_cents: number }[];
  /** Kept for backward compatibility; equals totals.dbLinesVsDbAmount. */
  totalsAgreeWithAmount: boolean;
  totals: TotalsReconciliation;
  issues: LineItemIssue[];
  status: Status;
  reason?: string;
}

/** The complete output of one validation run. It is written as JSON (everything) and rendered as text (for people); both carry the same facts. */
export interface ValidationReport {
  // Which file, its fingerprint, which record was matched (absent when none), which environment/database, which reader, when, and which date convention was assumed.
  document: { filename: string; hash: string; documentId?: string; environment: string; readerUsed: string; validatedAt: string; locale?: 'US' | 'EU' | 'unknown' };
  // Every record that could be the match and why (hash = strong, filename = weak). More than one is itself a defect.
  candidates: { document_id: string; matchedBy: string }[];
  comparisons: FieldComparison[];
  lineItems?: LineItemReconciliation;
  summary: { fieldsChecked: number; passed: number; failed: number; review: number; missingPdf: number; missingDatabase: number; criticalFailures: number };
  // Any FAIL or MISSING_DATABASE anywhere -> FAIL; otherwise any REVIEW or MISSING_PDF -> REVIEW; otherwise PASS.
  overallResult: 'PASS' | 'FAIL' | 'REVIEW';
  reason?: string;
  // True when sensitive values (names, account numbers) have been replaced with asterisks so the report is safe to share.
  masked?: boolean;
}
