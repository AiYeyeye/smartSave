import { afterEach, expect, it, vi } from 'vitest';
import { SAVE_PORT, startSaveEntrypoints } from '../background/save-entrypoints';
function event<T extends (...args: never[]) => unknown>() { const listeners: T[] = []; return { addListener: (listener: T) => listeners.push(listener), emit: (...args: Parameters<T>) => listeners.forEach(listener => listener(...args)) }; }
afterEach(() => vi.unstubAllGlobals());
function harness(onInvalidated: () => void = () => {}) {
  const action = event<(tab: chrome.tabs.Tab) => void>(); const connect = event<(port: chrome.runtime.Port) => void>();
  const command = event<(name: string, tab?: chrome.tabs.Tab) => void>();
  const menu = event<(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void>();
  const update = event<(id: number, change: { status: string }) => void>();
  const show = vi.fn();
  vi.stubGlobal('chrome', { action: { onClicked: action }, commands: { onCommand: command }, contextMenus: { onClicked: menu, create: vi.fn() }, runtime: { id: 'i', getURL: (path: string) => `chrome-extension://i/${path}`, onInstalled: event(), onConnect: connect }, tabs: { onUpdated: update, onRemoved: event() } });
  const { validateSaveContext: validate, livePageForSender } = startSaveEntrypoints(onInvalidated, show);
  function panel(tabId = 4, delayed = false) {
    const messages: unknown[] = []; const incoming = event<(value: unknown) => void>(); const disconnected = event<() => void>();
    const port = { name: SAVE_PORT, sender: { id: 'i', url: 'chrome-extension://i/options/index.html', tab: { id: tabId, windowId: 1, url: 'https://page.test/' } }, postMessage: (message: unknown) => messages.push(message), onMessage: incoming, onDisconnect: disconnected, disconnect: () => { if (!delayed) disconnected.emit(); } };
    connect.emit(port as unknown as chrome.runtime.Port); incoming.emit({ type: 'register' });
    return { messages, send: incoming.emit, deliverDisconnect: disconnected.emit };
  }
  const page = (id: number, windowId: number, url: string, title = 'Page') => ({ id, windowId, url, title } as chrome.tabs.Tab);
  return { action, command, menu, update, show, panel, validate, livePageForSender, page, save: (tab: chrome.tabs.Tab) => command.emit('save-current-page', tab) };
}
it('toolbar click shows host without capturing a page', () => {
  const h = harness(); const panel = h.panel(4);
  h.action.emit(h.page(4, 1, 'https://example.test/'));
  expect(h.show).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }), undefined);
  expect(panel.messages).not.toContainEqual(expect.objectContaining({ type: 'page' }));
  expect(panel.messages).toContainEqual({ type: 'invalidated' });
});
it('toolbar click does not replay a leftover capture on a later register', () => {
  const h = harness();
  h.save(h.page(4, 1, 'https://stale.test/'));
  h.action.emit(h.page(4, 1, 'https://stale.test/'));
  expect(h.panel(4).messages).not.toContainEqual(expect.objectContaining({ type: 'page' }));
});
it('toolbar browse-open uses invalidate so leftover assisted-save previews are purged', () => {
  const onInvalidated = vi.fn();
  const h = harness(onInvalidated);
  const panel = h.panel(4);
  h.save(h.page(4, 1, 'https://stale.test/'));
  const page = panel.messages.find((message): message is { type: 'page'; page: { token: string } } => !!message && typeof message === 'object' && 'type' in message && message.type === 'page');
  const token = page?.page.token;
  expect(token).toEqual(expect.any(String));
  expect(h.validate({ saveContext: token } as import('../schemas/messages').ConfirmMutation)).toBe(true);
  onInvalidated.mockClear();
  h.action.emit(h.page(4, 1, 'https://stale.test/'));
  expect(onInvalidated).toHaveBeenCalled();
  expect(panel.messages.at(-1)).toEqual({ type: 'invalidated' });
  expect(h.validate({ saveContext: token } as import('../schemas/messages').ConfirmMutation)).toBe(false);
});
it('named shortcut and page context menu remain opt-in capture', () => {
  const h = harness(); const panel = h.panel(4);
  h.save(h.page(4, 1, 'https://example.test/', 'Page'));
  expect(panel.messages).toContainEqual(expect.objectContaining({ type: 'page', page: expect.objectContaining({ url: 'https://example.test/' }) }));
  h.menu.emit({ menuItemId: 'zhilan-save-page' } as chrome.contextMenus.OnClickData, h.page(5, 1, 'https://menu.test/', 'Menu'));
  const second = h.panel(5);
  expect(second.messages.at(-1)).toMatchObject({ type: 'page', page: { url: 'https://menu.test/' } });
});
it('two tabs do not steal save ports', () => {
  const h = harness();
  const first = h.panel(4);
  h.save(h.page(4, 1, 'https://one.test/'));
  const count = first.messages.length;
  h.save(h.page(5, 1, 'https://two.test/'));
  expect(first.messages).toHaveLength(count);
  const second = h.panel(5);
  expect(second.messages.at(-1)).toMatchObject({ type: 'page', page: { tabId: 5, url: 'https://two.test/' } });
  expect(first.messages.at(-1)).toMatchObject({ type: 'page', page: { tabId: 4 } });
});
it('unbound panel sender is ignored', () => {
  harness();
  const connect = (chrome.runtime.onConnect as unknown as { emit: (port: chrome.runtime.Port) => void });
  const messages: unknown[] = [];
  const incoming = event<(value: unknown) => void>();
  connect.emit({ name: SAVE_PORT, sender: { id: 'i', url: 'chrome-extension://i/panel/index.html' }, postMessage: (m: unknown) => messages.push(m), onMessage: incoming, onDisconnect: event() } as unknown as chrome.runtime.Port);
  incoming.emit({ type: 'register' });
  expect(messages).toEqual([]);
});
it('browse toggles host without capture; explicit save reuses show with capture', () => {
  const h = harness();
  h.action.emit(h.page(4, 1, 'https://example.test/'));
  expect(h.show).toHaveBeenLastCalledWith(expect.objectContaining({ id: 4 }), undefined);
  h.save(h.page(4, 1, 'https://example.test/'));
  expect(h.show.mock.calls.at(-1)?.[1]).toMatchObject({ tabId: 4, url: 'https://example.test/' });
});
it('live extract page is owned session only, not client tab', () => {
  const h = harness();
  const panel = h.panel(4);
  h.save(h.page(4, 1, 'https://example.test/'));
  const owner = { tab: { id: 4, url: 'https://page.test/' } } as chrome.runtime.MessageSender;
  expect(h.livePageForSender(owner)?.tabId).toBe(4);
  expect(h.livePageForSender({ tab: { id: 99, url: 'chrome-extension://i/options/index.html' } } as chrome.runtime.MessageSender)).toBeUndefined();
  expect(panel.messages.some(m => m && typeof m === 'object' && 'type' in m && m.type === 'page')).toBe(true);
});
