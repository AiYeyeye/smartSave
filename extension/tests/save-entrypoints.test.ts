import { afterEach, expect, it, vi } from 'vitest';
import { SAVE_PORT, startSaveEntrypoints } from '../background/save-entrypoints';
function event<T extends (...args: never[]) => unknown>() { const listeners: T[] = []; return { addListener: (listener: T) => listeners.push(listener), emit: (...args: Parameters<T>) => listeners.forEach(listener => listener(...args)) }; }
afterEach(() => vi.unstubAllGlobals());
function harness() {
  const action = event<(tab: chrome.tabs.Tab) => void>(); const connect = event<(port: chrome.runtime.Port) => void>();
  const update = event<(id: number, change: { status: string }, tab: { active: boolean; windowId: number }) => void>();
  const query = vi.fn<() => Promise<chrome.tabs.Tab[]>>();
  const windowRemoved = event<(id: number) => void>();
  const open = vi.fn(async () => {});
  vi.stubGlobal('chrome', { action: { onClicked: action }, commands: { onCommand: event() }, contextMenus: { onClicked: event() }, runtime: { id: 'i', getURL: (path: string) => `chrome-extension://i/${path}`, onInstalled: event(), onConnect: connect }, sidePanel: { open }, windows: { onRemoved: windowRemoved }, tabs: { query, onUpdated: update, onRemoved: event(), onActivated: event() } });
  const validate = startSaveEntrypoints();
  function panel(windowId = 1, delayed = false) {
    const messages: unknown[] = []; const incoming = event<(value: unknown) => void>(); const disconnected = event<() => void>();
    const port = { name: SAVE_PORT, sender: { id: 'i', url: 'chrome-extension://i/panel/index.html' }, postMessage: (message: unknown) => messages.push(message), onMessage: incoming, onDisconnect: disconnected, disconnect: () => { if (!delayed) disconnected.emit(); } };
    connect.emit(port as unknown as chrome.runtime.Port); incoming.emit({ type: 'register', windowId });
    return { messages, send: incoming.emit, deliverDisconnect: disconnected.emit };
  }
  return { action, update, query, open, panel, validate, windowRemoved };
}
it('one panel owns handoff; replacement invalidates prior consumer and close invalidates all live state', () => {
  const h = harness(); const first = h.panel();
  h.action.emit({ id: 4, windowId: 1, url: 'https://example.test/', title: 'Page' } as chrome.tabs.Tab);
  expect(h.open).toHaveBeenCalledWith({ tabId: 4 }); expect(first.messages).toContainEqual(expect.objectContaining({ type: 'page' }));
  const second = h.panel(); expect(first.messages.at(-1)).toEqual({ type: 'invalidated' });
  h.action.emit({ id: 4, windowId: 1, url: 'https://example.test/', title: 'Page' } as chrome.tabs.Tab);
  second.send({ type: 'close' }); h.update.emit(4, { status: 'loading' }, { active: true, windowId: 1 });
  expect(second.messages.at(-1)).toEqual({ type: 'invalidated' });
});
it('navigation or close rejects late sidebar query without recreating an expired handoff', async () => {
  const h = harness(); const panel = h.panel(); let resolve!: (tabs: chrome.tabs.Tab[]) => void;
  h.query.mockImplementation(() => new Promise(done => { resolve = done; }));
  panel.send({ type: 'current' }); h.update.emit(4, { status: 'loading' }, { active: true, windowId: 1 });
  resolve([{ id: 4, windowId: 1, url: 'https://example.test/' } as chrome.tabs.Tab]); await Promise.resolve();
  expect(panel.messages).not.toContainEqual(expect.objectContaining({ type: 'page' }));
  panel.send({ type: 'current' }); panel.send({ type: 'close' });
  resolve([{ id: 4, windowId: 1, url: 'https://example.test/' } as chrome.tabs.Tab]); await Promise.resolve();
  expect(panel.messages).not.toContainEqual(expect.objectContaining({ type: 'page' }));
});
it('missing activeTab metadata reports honest manual activation instructions and never opens or injects', async () => {
  const h = harness(); const panel = h.panel(); h.query.mockResolvedValue([{ id: 4, windowId: 1 } as chrome.tabs.Tab]);
  panel.send({ type: 'current' }); await Promise.resolve();
  expect(panel.messages).toContainEqual(expect.objectContaining({ type: 'error' })); expect(h.open).not.toHaveBeenCalled();
});
it('routes activation to its original window, preserving pending capture until that panel registers', () => {
  const h = harness(); const first = h.panel(1);
  h.action.emit({ id: 4, windowId: 1, url: 'https://one.test/' } as chrome.tabs.Tab);
  const count = first.messages.length;
  h.action.emit({ id: 5, windowId: 2, url: 'https://two.test/' } as chrome.tabs.Tab);
  expect(first.messages).toHaveLength(count);
  const second = h.panel(2);
  expect(second.messages.at(-1)).toMatchObject({ type: 'page', page: { tabId: 5, url: 'https://two.test/' } });
  h.update.emit(99, { status: 'loading' }, { active: false, windowId: 1 });
  expect(first.messages).toHaveLength(count);
  expect(second.messages.at(-1)).toMatchObject({ type: 'page' });
});
it('obsolete query rejection cannot erase a newer handoff', async () => {
  const h = harness(); const panel = h.panel(); let reject!: (error: Error) => void;
  h.query.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  panel.send({ type: 'current' });
  h.action.emit({ id: 4, windowId: 1, url: 'https://new.test/' } as chrome.tabs.Tab);
  reject(Error('late')); await Promise.resolve(); await Promise.resolve();
  expect(panel.messages.at(-1)).toMatchObject({ type: 'page', page: { url: 'https://new.test/' } });
});

it('delayed old disconnect cannot clear successor; window close and restart invalidate authorization', () => {
  const h = harness(); const first = h.panel(1, true);
  h.action.emit({ id: 4, windowId: 1, url: 'https://one.test/' } as chrome.tabs.Tab);
  const second = h.panel();
  h.action.emit({ id: 4, windowId: 1, url: 'https://two.test/' } as chrome.tabs.Tab);
  first.deliverDisconnect(); first.send({ type: 'close' });
  expect(second.messages.at(-1)).toMatchObject({ type: 'page', page: { url: 'https://two.test/' } });
  h.windowRemoved.emit(1); expect(second.messages.at(-1)).toEqual({ type: 'invalidated' });
  const restarted = harness(); const freshPanel = restarted.panel(); expect(freshPanel.messages).toEqual([]);
});
