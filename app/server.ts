/**
 * WHAT THIS FILE DOES
 * The production-style entry point: POST a PDF, get 202 + documentId, poll GET /documents/:id.
 * Processing is asynchronous (in-process queue) so the golden test must poll, as it would against a real worker.
 *
 * In plain terms, this is the front door of the system - a small web service (API) that other software talks
 * to. It offers two operations: "here is a PDF" (the caller gets an id back straight away and the file is
 * processed in the background) and "what happened to document X?" (returns its current status and any error).
 * The business reason for answering immediately rather than waiting is that OCR can take many seconds; callers
 * should not be kept hanging, and a slow file must not block other uploads. Test-only shortcuts in this file
 * are switched off unless the service is explicitly running in test mode, so they can never affect live data.
 */
import { createServer, IncomingMessage } from 'http';
import { AddressInfo } from 'net';
import { DB, openDb } from './db';
import { submitDocument, processDocument } from './pipeline';

// Collect the whole uploaded file from the request before doing anything with it.
const readBody = (req: IncomingMessage) => new Promise<Buffer>(res => { const c: Buffer[] = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });

// Start the web service on the given port (0 = let the operating system pick a free one, used by tests).
// Resolves with the service's address and a close() function that shuts down cleanly.
export function startServer(db: DB, port = 0) {
  const queue = new Set<Promise<void>>();       // in-flight workers only; entries are removed when settled
  const server = createServer(async (req, res) => {
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    // Operation 1: upload a PDF. An empty upload is rejected outright (400) - nothing to process.
    if (req.method === 'POST' && req.url === '/documents') {
      const buf = await readBody(req);
      if (!buf.length) return json(400, { error: 'empty body' });
      const filename = String(req.headers['x-filename'] ?? 'upload.pdf');
      // the forced-failure hook exists for the stale-data tests only; it must never be honoured by a served instance
      const forceFail = process.env.NODE_ENV === 'test' && req.headers['x-test-force-fail'] === 'true';
      const opts = { fixtureId: (req.headers['x-fixture-id'] as string) ?? null, forceFail };
      // Register the document as QUEUED right away so the caller has an id to poll.
      const documentId = submitDocument(db, buf, filename, opts);
      // fire-and-forget worker
      // The real processing happens in the background after we have replied. Errors are swallowed here on purpose
      // because processDocument already records the outcome on the document's row; the queue set just lets
      // close() wait for anything still running.
      const job: Promise<void> = setTimeoutP(10).then(() => processDocument(db, documentId, buf, opts)).then(() => {}, () => {}).finally(() => queue.delete(job));
      queue.add(job);
      // 202 = "accepted, still working on it". The caller polls GET /documents/:id for the result.
      return json(202, { documentId });
    }
    // Operation 2: look up a document's status by id. Returns QUEUED / PROCESSING / COMPLETED / DUPLICATE / FAILED
    // plus the error text if it failed. Unknown ids get 404.
    const m = req.url?.match(/^\/documents\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const row = db.prepare('SELECT document_id, status, error, submitted_at, completed_at FROM documents WHERE document_id = ?').get(m[1]);
      return row ? json(200, row) : json(404, { error: 'not found' });
    }
    json(404, { error: 'not found' });
  });
  return new Promise<{ url: string; close: () => Promise<void> }>(resolve => server.listen(port, () => {
    const { port: p } = server.address() as AddressInfo;
    // stop accepting connections FIRST, then drain whatever is in flight; nothing can be queued after this point
    // Business consequence: shutting down never abandons a half-processed upload - every accepted document reaches a final status.
    const close = () => new Promise<void>(r => server.close(() => r())).then(() => Promise.allSettled([...queue])).then(() => {});
    resolve({ url: `http://127.0.0.1:${p}`, close });
  }));
}
// Small "wait this many milliseconds" helper; the 10 ms delay lets the 202 reply go out before heavy work starts.
const setTimeoutP = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// When this file is run directly (not imported by tests), open the real database file and start listening.
// DATABASE_PATH and PORT can be set in the environment; otherwise sensible defaults are used.
if (require.main === module) {
  const db = openDb(process.env.DATABASE_PATH ?? './.data/app.sqlite');
  startServer(db, Number(process.env.PORT ?? 3000)).then(s => console.log(`ingestion API listening at ${s.url}`));
}
