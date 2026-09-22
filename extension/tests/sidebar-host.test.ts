import { afterEach, expect, it, vi } from 'vitest';
import { startSidebarHost } from '../background/sidebar-host';
import { resetUiRegistry } from '../background/ui-identity';

function event<T extends (...args: never[]) => unknown>() {
  const listeners: T[] = [];
  return { addListener: (listener: T) => listeners.push(listener), emit: (...args: Parameters<T>) => listeners.forEach(listener => listener(...args)) };
}

afterEach(() => { vi.unstubAllGlobals(); resetUiRegistry(); });

function harness() {
  const executeScript = vi.fn(async () => [{ result: { created: true } }]);
  const createTab = vi.fn(async () => ({ id: 77 }));
  vi.stubGlobal('chrome', {
    runtime: { id: 'i', getURL: (path: string) => `chrome-extension://i/${path}`, onConnect: event(), onMessage: event() },
    tabs: { onRemoved: event(), create: createTab },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    scripting: { executeScript },
  });
  const host = startSidebarHost();
  const tab = { id: 4, windowId: 1, url: 'https://example.test/' } as chrome.tabs.Tab;
  return { host, executeScript, createTab, tab };
}

it('browse toggles inject without capture; explicit save reuses keep=true', () => {
  const h = harness();
  h.host.show(h.tab, undefined);
  expect(h.executeScript).toHaveBeenCalled();
  expect((h.executeScript.mock.calls[0] as unknown as [{ args: unknown[] }])[0].args[4]).toBe(false);
  h.host.show(h.tab, { tabId: 4, windowId: 1, url: 'https://example.test/', title: 'T' });
  expect((h.executeScript.mock.calls[1] as unknown as [{ args: unknown[] }])[0].args[4]).toBe(true);
});

it('async executeScript rejection falls back without permissions.request', async () => {
  const h = harness();
  h.executeScript.mockRejectedValueOnce(Error('csp'));
  h.host.show(h.tab, { tabId: 4, windowId: 1, url: 'https://example.test/', title: 'T' });
  await Promise.resolve();
  await Promise.resolve();
  expect(h.createTab).toHaveBeenCalledWith({ url: 'chrome-extension://i/options/index.html' });
  expect(chrome.permissions).toBeUndefined();
});
