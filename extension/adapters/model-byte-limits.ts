export const MODEL_BYTE_LIMITS = { requestBytes: 1024 * 1024, responseBytes: 1024 * 1024 };
export async function readModelResponse(response: Response, limit: number, signal?: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error('schema');
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (Number(response.headers.get('content-length')) > limit) throw Error('response-too-large');
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw Error('response-too-large');
      chunks.push(chunk.value);
    }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
