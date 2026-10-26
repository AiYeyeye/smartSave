import { afterEach, expect, it, vi } from 'vitest';
import { sendBookmarkCheck } from '../panel/bookmark-check-client';
import { emptyBookmarkCheck } from '../domain/bookmark-check';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const message = { type: 'bookmarkCheck', action: 'get' } as const;
function runtime(sendMessage: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
}

it('distinguishes transport failure, outdated context and incompatible responses without exposing raw details', async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(Error('Receiving end does not exist: private details'))
    .mockRejectedValueOnce(Error('Extension context invalidated.'))
    .mockResolvedValueOnce({ unexpected: 'private data' });
  runtime(send);
  await expect(sendBookmarkCheck(message)).rejects.toThrow('check-disconnected');
  await expect(sendBookmarkCheck(message)).rejects.toThrow('extension-updated');
  await expect(sendBookmarkCheck(message)).rejects.toThrow('check-response-invalid');
});

it('retains controlled worker errors and validates successful state', async () => {
  const state = emptyBookmarkCheck();
  runtime(
    vi
      .fn()
      .mockResolvedValueOnce({ status: 'error', reason: 'storage-timeout' })
      .mockResolvedValueOnce({ status: 'ok', state, ownerId: 'new-worker' }),
  );
  await expect(sendBookmarkCheck(message)).rejects.toThrow('storage-timeout');
  await expect(sendBookmarkCheck(message)).resolves.toEqual({ ...state, ownerId: 'new-worker' });
});

it('times out a missing reply and allows the next explicit request', async () => {
  vi.useFakeTimers();
  runtime(
    vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ status: 'ok', state: emptyBookmarkCheck() }),
  );
  const failed = expect(sendBookmarkCheck(message)).rejects.toThrow('check-timeout');
  await vi.advanceTimersByTimeAsync(15_000);
  await failed;
  await expect(sendBookmarkCheck(message)).resolves.toEqual(emptyBookmarkCheck());
  expect(vi.getTimerCount()).toBe(0);
});
