import { afterEach, expect, it, vi } from 'vitest';
import { createWorkerTaskLifetime } from '../background/worker-task-lifetime';

afterEach(() => vi.useRealTimers());

it('keeps concurrent work alive, releases independently and stops when idle', async () => {
  vi.useFakeTimers();
  const pulse = vi.fn(async () => {});
  const lifetime = createWorkerTaskLifetime(pulse);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(pulse).not.toHaveBeenCalled();
  const first = lifetime.acquire();
  const second = lifetime.acquire();
  await vi.advanceTimersByTimeAsync(40_000);
  expect(pulse).toHaveBeenCalledTimes(3);
  first();
  first();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(pulse).toHaveBeenCalledTimes(4);
  second();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(pulse).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
  const third = lifetime.acquire();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(pulse).toHaveBeenCalledTimes(6);
  lifetime.dispose();
  third();
  lifetime.acquire();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(pulse).toHaveBeenCalledTimes(6);
  expect(vi.getTimerCount()).toBe(0);
});

it('contains API rejection without breaking operation cleanup', async () => {
  vi.useFakeTimers();
  const pulse = vi.fn(async () => {
    throw Error('extension unavailable');
  });
  const lifetime = createWorkerTaskLifetime(pulse);
  const release = lifetime.acquire();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(pulse).toHaveBeenCalledTimes(2);
  release();
  expect(vi.getTimerCount()).toBe(0);
});
