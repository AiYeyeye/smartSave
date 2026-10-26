import { saveRetryResponseSchema } from '../domain/save-retry';

/** Starts read-only advice; progress and results arrive through the live receipt subscription. */
export async function retrySave(receiptId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = saveRetryResponseSchema.safeParse(
      await Promise.race([
        chrome.runtime.sendMessage({ type: 'nativeSaveRetry', receiptId, requestId: crypto.randomUUID() }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error('retry-unavailable')), 10_000);
        }),
      ]),
    );
    if (!response.success || response.data.status !== 'started') throw Error('retry-unavailable');
  } finally {
    clearTimeout(timer);
  }
}
