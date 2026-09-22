import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});
it('real extractor reads body only for trusted explicit request, limits Unicode and removes listener', async () => {
  const addListener = vi.fn();
  const removeListener = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'i',
      getURL: (path: string) => `chrome-extension://i/${path}`,
      onMessage: { addListener, removeListener },
    },
  });
  const read = vi.fn(() => '😀'.repeat(2000));
  Object.defineProperty(document.body, 'innerText', { configurable: true, get: read });
  await import('../content/extract-current-page');
  expect(read).not.toHaveBeenCalled();
  const listener = addListener.mock.calls[0]![0];
  const respond = vi.fn();
  listener(
    { type: 'zhilan-extract-current-page', url: location.href },
    { id: 'i', url: 'https://page.test/' },
    respond,
  );
  expect(read).not.toHaveBeenCalled();
  expect(respond).not.toHaveBeenCalled();
  listener(
    { type: 'zhilan-extract-current-page', url: location.href },
    { id: 'i', url: 'chrome-extension://i/service-worker.js' },
    respond,
  );
  expect(read).toHaveBeenCalledOnce();
  expect(Array.from(respond.mock.calls[0]![0].snippet)).toHaveLength(1500);
  expect(removeListener).toHaveBeenCalledWith(listener);
});
it('cancel and stale URL remove dormant extractor without reading body', async () => {
  const addListener = vi.fn();
  const removeListener = vi.fn();
  const read = vi.fn(() => 'private');
  Object.defineProperty(document.body, 'innerText', { configurable: true, get: read });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'i',
      getURL: (path: string) => `chrome-extension://i/${path}`,
      onMessage: { addListener, removeListener },
    },
  });
  await import('../content/extract-current-page');
  const listener = addListener.mock.calls[0]![0];
  const sender = { id: 'i', url: 'chrome-extension://i/service-worker.js' };
  listener({ type: 'zhilan-cancel-extraction' }, sender, vi.fn());
  expect(read).not.toHaveBeenCalled();
  expect(removeListener).toHaveBeenCalledWith(listener);
  listener({ type: 'zhilan-extract-current-page', url: 'https://stale.test/' }, sender, vi.fn());
  expect(read).not.toHaveBeenCalled();
});
