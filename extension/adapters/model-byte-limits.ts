export const MODEL_BYTE_LIMITS = { requestBytes: 1024 * 1024, responseBytes: 1024 * 1024 };
// SSE carries event metadata, reasoning and full snapshots in addition to the bounded answer.
export const MODEL_STREAM_LIMITS = { wireBytes: 16 * 1024 * 1024, frameBytes: 2 * 1024 * 1024 };
export type ModelBodyObserver = (text: string, bytes: number, complete?: boolean) => void;
/** A rejected body read is transport failure, distinct from malformed UTF-8/JSON/SSE. */
export class ModelResponseReadError extends Error {
  constructor(cause: unknown) {
    super('network-error', { cause });
    this.name = 'ModelResponseReadError';
  }
}
export async function readModelText(
  response: Response,
  limit: number,
  signal?: AbortSignal,
  onBody?: ModelBodyObserver,
): Promise<string> {
  return readModelChunks(response, limit, signal, undefined, onBody);
}

/** Byte budget and fatal UTF-8 decoding are shared by JSON and SSE. */
export async function readModelChunks(
  response: Response,
  limit: number,
  signal?: AbortSignal,
  onChunk?: (text: string) => void,
  onBody?: ModelBodyObserver,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw Error('schema');
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let bytes = 0;
  let text = '';
  let complete = false;
  let tooLarge = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    if (Number(response.headers.get('content-length')) > limit) {
      tooLarge = true;
      throw Error('response-too-large');
    }
    while (true) {
      if (signal?.aborted) throw Error('aborted');
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal?.aborted) throw Error('aborted', { cause: error });
        throw new ModelResponseReadError(error);
      }
      if (signal?.aborted) throw Error('aborted');
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        tooLarge = true;
        throw Error('response-too-large');
      }
      const decoded = decoder.decode(chunk.value, { stream: true });
      text += decoded;
      onChunk?.(decoded);
    }
    const tail = decoder.decode();
    text += tail;
    onChunk?.(tail);
    complete = true;
    return text;
  } catch (error) {
    // A broken underlying source may never settle cancellation. Do not hold the
    // original read/protocol failure (or its diagnostic cleanup) behind it.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    if (!tooLarge) {
      try {
        onBody?.(text, bytes, complete);
      } catch {
        /* Diagnostics never fail calls. */
      }
    }
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export async function readModelResponse(
  response: Response,
  limit: number,
  signal?: AbortSignal,
  onBody?: ModelBodyObserver,
): Promise<unknown> {
  return JSON.parse(await readModelText(response, limit, signal, onBody));
}
