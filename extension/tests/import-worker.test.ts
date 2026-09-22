import { afterEach, expect, it, vi } from 'vitest';
import { parseImportInWorker } from '../import/worker-client';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('terminates a hung parser at injected execution budget with whole-result resource error', async () => {
  vi.useFakeTimers();
  const terminate = vi.fn();
  const postMessage = vi.fn();
  vi.stubGlobal(
    'Worker',
    class {
      terminate = terminate;
      postMessage = postMessage;
    },
  );
  const pending = parseImportInWorker(new TextEncoder().encode('<div>'.repeat(5000)), 'html', undefined, 25);
  const assertion = expect(pending).rejects.toMatchObject({ code: 'resource' });
  await vi.advanceTimersByTimeAsync(25);
  await assertion;
  expect(terminate).toHaveBeenCalledOnce();
  expect(postMessage).toHaveBeenCalledOnce();
});
it('cancellation terminates an expansive markdown worker and releases deadline', async () => {
  vi.useFakeTimers();
  const terminate = vi.fn();
  vi.stubGlobal(
    'Worker',
    class {
      terminate = terminate;
      postMessage = vi.fn();
    },
  );
  const abort = new AbortController();
  const p = parseImportInWorker(
    new TextEncoder().encode('[x](https://e.test)\n'.repeat(5000)),
    'markdown',
    abort.signal,
    25,
  );
  const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort();
  await assertion;
  expect(terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
