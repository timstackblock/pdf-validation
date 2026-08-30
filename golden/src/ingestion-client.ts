/**
 * WHAT THIS FILE DOES
 *
 * This file is how the golden suite hands a PDF to the ingestion system and waits for the answer,
 * using exactly the same web API a real customer application would use. It never reaches into the
 * system's internal code, so a pass here means the real front door works. Inputs: the API address,
 * the PDF bytes, a file name, and optionally the fixture id (which the system must stamp on the stored
 * rows so cleanup can find them later). Outputs: the document id the system assigned, and later the
 * document's final status (COMPLETED, FAILED or DUPLICATE) with its timestamps. Risk protected
 * against: tests that "pass" by calling the parser directly and skipping the upload, queue and worker;
 * and fixed waits that either time out on slow systems or mistake a rejected document for a hang.
 *
 * Talks to the app the way a real client would: HTTP only. No imports from app/ pipeline internals.
 */
// Uploads one PDF and returns the document id the system assigned to it. Throws if the system does not
// answer "202 Accepted" (the standard "received, processing in the background" response). The optional
// forceFail flag is a test-only switch that makes the system fail this document on purpose (used by
// level 6 to prove a failed run leaves zero rows behind).
export async function submitPdf(apiUrl: string, pdf: Buffer, filename: string, opts: { fixtureId?: string; forceFail?: boolean } = {}) {
  // Headers tell the system what the file is, what to call it, and which golden fixture it belongs to.
  const headers: Record<string, string> = { 'content-type': 'application/pdf', 'x-filename': filename };
  if (opts.fixtureId) headers['x-fixture-id'] = opts.fixtureId;
  if (opts.forceFail) headers['x-test-force-fail'] = 'true';
  const res = await fetch(`${apiUrl}/documents`, { method: 'POST', headers, body: new Uint8Array(pdf) });
  if (res.status !== 202) throw new Error(`submit failed: ${res.status} ${await res.text()}`);
  return (await res.json() as { documentId: string }).documentId;
}

// What the status endpoint reports for one document: its id, current state, any error message, and
// when it was submitted and finished (ISO timestamps, i.e. "2026-08-30T14:05:00Z"). These become evidence.
export interface DocumentStatus { document_id: string; status: string; error: string | null; submitted_at: string; completed_at: string | null; }

/** Poll — never a fixed sleep. Resolves on COMPLETED/FAILED/DUPLICATE, throws on timeout. */
// Asks "is it done yet?" every `intervalMs` milliseconds until the document reaches a final state or
// `timeoutMs` passes. All three final states count as done, so a rejected document is reported as
// FAILED rather than looking like a system that never answered.
export async function waitForDocument(apiUrl: string, documentId: string, timeoutMs = 60_000, intervalMs = 200): Promise<DocumentStatus> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${apiUrl}/documents/${documentId}`);
    // A non-OK reply (e.g. the row is not visible yet) is simply retried on the next tick.
    if (res.ok) {
      const d = await res.json() as DocumentStatus;
      if (['COMPLETED', 'FAILED', 'DUPLICATE'].includes(d.status)) return d;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`document ${documentId} did not finish within ${timeoutMs}ms`);
}
