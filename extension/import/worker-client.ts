import { IMPORT_RESOURCE_BUDGET, ImportParseError, type ImportFormat, type ImportResult, type ParseRequest, type ParseResponse } from './contracts';
/** One isolated worker per parse. Cancellation terminates computation; no native/model/storage side effects. */
export function parseImportInWorker(bytes: Uint8Array, format: ImportFormat, signal?: AbortSignal, deadlineMs = 30_000): Promise<ImportResult> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return Promise.reject(new ImportParseError('resource', 'Invalid execution budget'));
  if (bytes.byteLength > IMPORT_RESOURCE_BUDGET.bytes) return Promise.reject(new ImportParseError('resource', 'File exceeds tested parser byte budget'));
  if (signal?.aborted) return Promise.reject(new DOMException('Parsing cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parse-worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { cleanup(); reject(new ImportParseError('resource', 'Parse execution deadline exceeded; no partial result accepted')); }, deadlineMs);
    const cleanup = () => { clearTimeout(timer); worker.terminate(); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new DOMException('Parsing cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<ParseResponse>) => {
      cleanup();
      if (event.data.ok) resolve(event.data.result);
      else reject(new ImportParseError(event.data.code, event.data.message));
    };
    worker.onerror = () => { cleanup(); reject(new ImportParseError('resource', 'Parse worker failed; no partial result accepted')); };
    worker.onmessageerror = () => { cleanup(); reject(new ImportParseError('malformed', 'Invalid worker response')); };
    const buffer = bytes.slice().buffer;
    const request: ParseRequest = { bytes: buffer, format };
    try { worker.postMessage(request, [buffer]); } catch (error) { cleanup(); reject(error); }
  });
}
