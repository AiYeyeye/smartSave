import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { SAVE_PORT } from '../background/save-entrypoints';

function event<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return { addListener: (listener: T) => { listeners.add(listener); }, removeListener: (listener: T) => { listeners.delete(listener); }, emit: (...args: Parameters<T>) => { listeners.forEach(listener => listener(...args)); }, count: () => listeners.size };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function worker() {
  vi.resetModules();
  let automatic = true; let gesture = false;
  const messages = event<(message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown>();
  const installed = event<() => void>(); const startup = event<() => void>();
  const clicked = event<(tab: chrome.tabs.Tab) => void>(); const connected = event<(port: chrome.runtime.Port) => void>();
  const setPanelBehavior = vi.fn(async (options: { openPanelOnActionClick: boolean }) => { automatic = options.openPanelOnActionClick; });
  const open = vi.fn((options: { tabId: number }) => { expect(gesture).toBe(true); expect(Number.isInteger(options.tabId)).toBe(true); return Promise.resolve(); });
  const query = vi.fn(async () => []);
  const nativeWrite = vi.fn();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', {
    sidePanel: { setPanelBehavior, open }, action: { onClicked: clicked }, commands: { onCommand: event() },
    contextMenus: { onClicked: event(), create: vi.fn((_options, done: () => void) => done()) },
    runtime: { id: 'i', getURL: (path: string) => `chrome-extension://i/${path}`, onInstalled: installed, onStartup: startup, onConnect: connected, onMessage: messages },
    tabs: { query, onUpdated: event(), onRemoved: event(), onActivated: event() }, windows: { onRemoved: event() },
    storage: { local: { setAccessLevel: async () => {}, get: async () => ({ installationId: 'test-install' }), set: async () => {} } },
    bookmarks: { getTree: async () => [], create: nativeWrite, update: nativeWrite, move: nativeWrite, remove: nativeWrite,
      onCreated: event(), onChanged: event(), onMoved: event(), onRemoved: event(), onChildrenReordered: event(), onImportBegan: event(), onImportEnded: event() },
  });
  // Import the production worker, including the real entrypoint, tree and mutation services.
  await import('../background/service-worker');
  function click(windowId = 1) {
    // This is a project ownership invariant, not a simulation of undocumented Chrome suppression.
    expect(automatic && clicked.count() > 0).toBe(false);
    expect(clicked.count()).toBe(1);
    gesture = true;
    try { clicked.emit({ id: windowId + 3, windowId, url: `https://page${windowId}.test/`, title: `Page ${windowId}` } as chrome.tabs.Tab); }
    finally { gesture = false; }
  }
  function panel(windowId = 1) {
    const messages: unknown[] = []; const incoming = event<(message: unknown) => void>(); const disconnected = event<() => void>();
    const port = { name: SAVE_PORT, sender: { id: 'i', url: 'chrome-extension://i/panel/index.html' }, postMessage: (message: unknown) => messages.push(message), onMessage: incoming, onDisconnect: disconnected, disconnect: () => disconnected.emit() };
    connected.emit(port as unknown as chrome.runtime.Port); incoming.emit({ type: 'register', windowId });
    return messages;
  }
  return { messages, click, panel, installed, startup, setPanelBehavior, open, query, nativeWrite, resetPersistedBehavior: () => { automatic = true; } };
}

it('cold worker disables persisted automatic routing and synchronously opens toolbar tab before panel registration', async () => {
  const h = await worker();
  expect(h.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
  h.click();
  expect(h.open).toHaveBeenCalledExactlyOnceWith({ tabId: 4 });
  expect(h.panel()).toContainEqual({ type: 'page', page: { tabId: 4, token: expect.any(String), url: 'https://page1.test/', title: 'Page 1' } });
  expect(h.panel(2)).toEqual([]);
  expect(h.query).not.toHaveBeenCalled(); expect(h.nativeWrite).not.toHaveBeenCalled();
});
it.each(['installed', 'startup'] as const)('%s resets legacy automatic behavior without adding a second click route', async lifecycle => {
  const h = await worker(); h.resetPersistedBehavior(); h[lifecycle].emit();
  expect(h.setPanelBehavior).toHaveBeenLastCalledWith({ openPanelOnActionClick: false });
  const first = h.panel(); const second = h.panel(2); h.click(2);
  expect(first).toEqual([]); expect(second.at(-1)).toMatchObject({ type: 'page', page: { tabId: 5 } });
  expect(h.open).toHaveBeenCalledExactlyOnceWith({ tabId: 5 });
});
it('pending panel opening does not defer capture or require a warm worker', async () => {
  const h = await worker(); let finish!: () => void;
  h.open.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  h.click(); expect(h.panel().at(-1)).toMatchObject({ type: 'page' }); finish();
  const fresh = await worker(); expect(fresh.panel()).toEqual([]); fresh.click();
  expect(fresh.open).toHaveBeenCalledExactlyOnceWith({ tabId: 4 });
});
it('panel open rejection is handled and reported without native writes', async () => {
  const h = await worker(); const messages = h.panel(); h.open.mockRejectedValueOnce(Error('denied'));
  h.click(); await Promise.resolve();
  expect(messages).toContainEqual(expect.objectContaining({ type: 'page' }));
  expect(messages.at(-1)).toMatchObject({ type: 'error', reason: '侧栏打开失败，请检查浏览器支持。' });
  expect(h.nativeWrite).not.toHaveBeenCalled();
});
it('panel configuration rejection is observable and can be retried on startup', async () => {
  const h = await worker(); const error = Error('configuration denied'); const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  h.setPanelBehavior.mockRejectedValueOnce(error); h.installed.emit(); await Promise.resolve();
  expect(log).toHaveBeenCalledWith('智栏侧栏入口配置失败', error);
  h.startup.emit(); h.click(); expect(h.open).toHaveBeenCalledOnce();
});
it('late open rejection from A cannot report failure against newer activation B', async () => {
  const h = await worker(); const messages = h.panel(); let reject!: (error: Error) => void;
  h.open.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  h.click(); h.click(); const latest = messages.at(-1); const count = messages.length;
  reject(Error('late A')); await Promise.resolve();
  expect(messages).toHaveLength(count); expect(messages.at(-1)).toBe(latest);
  expect(latest).toMatchObject({ type: 'page' });
});
it('synchronous panel open throw is contained and reported without losing manual page handoff', async () => {
  const h = await worker(); const messages = h.panel(); h.open.mockImplementationOnce(() => { throw Error('synchronous denial'); });
  expect(() => h.click()).not.toThrow();
  expect(messages).toContainEqual(expect.objectContaining({ type: 'page' }));
  expect(messages.at(-1)).toMatchObject({ type: 'error', reason: '侧栏打开失败，请检查浏览器支持。' });
  expect(h.nativeWrite).not.toHaveBeenCalled();
});

it('production worker routes exact trusted metadata-only file output control', async () => {
  const h = await worker(); const reply = vi.fn();
  const message = { version: 1, type: 'fileOutput', action: 'status' };
  h.messages.emit(message, { id: 'foreign', url: 'chrome-extension://i/options/index.html' }, reply);
  h.messages.emit({ ...message, handle: {} }, { id: 'i', url: 'chrome-extension://i/options/index.html' }, reply);
  expect(reply).not.toHaveBeenCalled();
  h.messages.emit(message, { id: 'i', url: 'chrome-extension://i/options/index.html' }, reply);
  expect(reply).toHaveBeenCalledWith({ status: 'stopped' }); expect(h.nativeWrite).not.toHaveBeenCalled();
});
