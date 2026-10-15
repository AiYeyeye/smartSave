import { afterEach, expect, it, vi } from 'vitest';
import { claimOverlay } from '../panel/claim-overlay';

afterEach(() => vi.useRealTimers());

it('requires an explicit positive claim reply, rather than just a resolved message', async () => {
  for (const reply of [undefined, null, {}, { ok: false }, { ok: 'true' }])
    expect(await claimOverlay('token', async () => reply)).toBe(false);
  const send = vi.fn(async () => ({ ok: true }));
  expect(await claimOverlay('token', send)).toBe(true);
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'zhilan-overlay-claim', token: 'token' });
});

it('fails closed on transport failure, timeout and a late positive reply', async () => {
  expect(
    await claimOverlay('token', async () => {
      throw new Error('disconnected');
    }),
  ).toBe(false);
  vi.useFakeTimers();
  let resolve!: (reply: unknown) => void;
  const send = vi.fn(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const result = claimOverlay('token', send);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toBe(false);
  resolve({ ok: true });
  expect(await result).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
