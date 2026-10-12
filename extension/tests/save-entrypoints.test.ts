import { afterEach, expect, it, vi } from 'vitest';
import { SAVE_BADGE, SAVE_PORT, openSaveUi, startSaveEntrypoints } from '../background/save-entrypoints';
function event<T extends (...args: never[]) => unknown>() {
  const listeners: T[] = [];
  return {
    addListener: (listener: T) => listeners.push(listener),
    emit: (...args: Parameters<T>) => listeners.forEach(listener => listener(...args)),
  };
}
afterEach(() => vi.unstubAllGlobals());
type Message = { type: string; page?: { tabId: number; token: string; url: string; title: string }; reason?: string };
const page = (id: number, windowId: number, url: string, title = 'Page') =>
  ({ id, windowId, url, title }) as chrome.tabs.Tab;
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function harness(onInvalidated: () => void = () => {}, withOpenPopup = false) {
  const connect = event<(port: chrome.runtime.Port) => void>();
  const command = event<(name: string, tab?: chrome.tabs.Tab) => void>();
  const menu = event<(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void>();
  const update = event<(id: number, change: { status?: string; url?: string }) => void>();
  const removed = event<(id: number) => void>();
  const open = vi.fn(async () => {});
  const setBadgeText = vi.fn(async () => {});
  const setBadgeBackgroundColor = vi.fn(async () => {});
  const openPopup = vi.fn(async () => {});
  let active: chrome.tabs.Tab | undefined = page(4, 1, 'https://example.test/');
  const query = vi.fn(async () => (active ? [active] : []));
  vi.stubGlobal('chrome', {
    action: withOpenPopup ? { setBadgeText, setBadgeBackgroundColor, openPopup } : { setBadgeText },
    commands: { onCommand: command },
    contextMenus: { onClicked: menu, create: vi.fn() },
    runtime: {
      id: 'i',
      getURL: (path: string) => `chrome-extension://i/${path}`,
      onInstalled: event(),
      onConnect: connect,
    },
    tabs: { onUpdated: update, onRemoved: removed, query },
  });
  const { validateSaveContext: validate, livePageForSender } = startSaveEntrypoints(onInvalidated, open);
  const senders = {
    popup: (documentId = 'popup-doc') => ({ id: 'i', url: 'chrome-extension://i/panel/index.html', documentId }),
    options: (tabId = 99) => ({
      id: 'i',
      url: 'chrome-extension://i/options/index.html',
      documentId: `options-${tabId}`,
      tab: { id: tabId, windowId: 1, url: 'chrome-extension://i/options/index.html' },
    }),
  };
  async function ui(sender: Record<string, unknown> = senders.popup()) {
    const messages: Message[] = [];
    const incoming = event<(value: unknown) => void>();
    const disconnected = event<() => void>();
    const port = {
      name: SAVE_PORT,
      sender,
      postMessage: (message: unknown) => messages.push(message as Message),
      onMessage: incoming,
      onDisconnect: disconnected,
      disconnect: () => disconnected.emit(),
    };
    connect.emit(port as unknown as chrome.runtime.Port);
    incoming.emit({ type: 'register' });
    await flush();
    return {
      messages,
      sender,
      send: async (value: unknown) => {
        incoming.emit(value);
        await flush();
      },
      disconnect: () => disconnected.emit(),
    };
  }
  return {
    command,
    menu,
    update,
    removed,
    open,
    openPopup,
    setBadgeText,
    setBadgeBackgroundColor,
    query,
    ui,
    senders,
    validate,
    livePageForSender,
    setActive: (tab: chrome.tabs.Tab | undefined) => {
      active = tab;
    },
    save: (tab: chrome.tabs.Tab) => command.emit('save-current-page', tab),
  };
}
const pages = (messages: Message[]) => messages.filter(m => m.type === 'page');

it('shortcut captures the gesture tab, opens the UI, and a registering popup receives the page with the badge cleared', async () => {
  const h = harness();
  h.save(page(4, 1, 'https://example.test/', 'Example'));
  expect(h.open).toHaveBeenCalledWith(4);
  const popup = await h.ui();
  expect(popup.messages.at(-1)).toMatchObject({
    type: 'page',
    page: { tabId: 4, url: 'https://example.test/', title: 'Example', token: expect.any(String) },
  });
  expect(h.setBadgeText).toHaveBeenLastCalledWith({ tabId: 4, text: '' });
  expect(h.validate({ saveContext: popup.messages.at(-1)!.page!.token } as never)).toBe(true);
});
it('page context menu remains an explicit capture entry', async () => {
  const h = harness();
  h.setActive(page(5, 1, 'https://menu.test/'));
  h.menu.emit({ menuItemId: 'zhilan-save-page' } as chrome.contextMenus.OnClickData, page(5, 1, 'https://menu.test/'));
  expect(h.open).toHaveBeenCalledWith(5);
  const popup = await h.ui();
  expect(popup.messages.at(-1)).toMatchObject({ type: 'page', page: { tabId: 5, url: 'https://menu.test/' } });
});
it('shortcut on a non-http tab captures nothing and does not open the UI', async () => {
  const h = harness();
  h.save(page(4, 1, 'chrome://extensions/'));
  h.save({ id: 4, windowId: 1 } as chrome.tabs.Tab);
  expect(h.open).not.toHaveBeenCalled();
  const popup = await h.ui();
  expect(pages(popup.messages)).toEqual([]);
});
it('shortcut while a popup already owns the tab delivers the page in place without reopening', async () => {
  const h = harness();
  const popup = await h.ui();
  h.save(page(4, 1, 'https://example.test/'));
  expect(h.open).not.toHaveBeenCalled();
  expect(popup.messages.at(-1)).toMatchObject({ type: 'page', page: { tabId: 4 } });
  h.save(page(4, 1, 'chrome://extensions/'));
  expect(popup.messages.at(-1)).toMatchObject({ type: 'error', reason: expect.stringContaining('http(s)') });
});
it('default open prefers action.openPopup and falls back to a per-tab badge when it is missing or rejects', async () => {
  vi.stubGlobal('chrome', {
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
  });
  await openSaveUi(4);
  expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 4, text: SAVE_BADGE });
  expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith(expect.objectContaining({ tabId: 4 }));
  const openPopup = vi.fn(async () => {});
  const setBadgeText = vi.fn(async () => {});
  vi.stubGlobal('chrome', { action: { openPopup, setBadgeText } });
  await openSaveUi(4);
  expect(openPopup).toHaveBeenCalledOnce();
  expect(setBadgeText).not.toHaveBeenCalled();
  openPopup.mockRejectedValueOnce(Error('no active browser window'));
  await openSaveUi(4);
  expect(setBadgeText).toHaveBeenCalledWith({ tabId: 4, text: SAVE_BADGE });
  vi.stubGlobal('chrome', { action: { setBadgeText: vi.fn(async () => Promise.reject(Error('gone'))) } });
  await expect(openSaveUi(4)).resolves.toBeUndefined();
});
it('default open prefers the side panel for the captured tab, then popup, then badge', async () => {
  const open = vi.fn(async () => {});
  const setBadgeText = vi.fn(async () => {});
  vi.stubGlobal('chrome', { sidePanel: { open }, action: { setBadgeText } });
  await openSaveUi(7);
  expect(open).toHaveBeenCalledWith({ tabId: 7 });
  expect(setBadgeText).not.toHaveBeenCalled();
  open.mockRejectedValueOnce(Error('may only be called in response to a user gesture'));
  await openSaveUi(7);
  expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: SAVE_BADGE });
});
it('capture message captures the active tab of the popup window and reports unusable tabs', async () => {
  const h = harness();
  const popup = await h.ui();
  expect(pages(popup.messages)).toEqual([]);
  await popup.send({ type: 'capture' });
  expect(h.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
  expect(popup.messages.at(-1)).toMatchObject({ type: 'page', page: { tabId: 4, url: 'https://example.test/' } });
  h.setActive(page(4, 1, 'chrome://newtab/'));
  await popup.send({ type: 'capture' });
  expect(popup.messages.at(-1)).toMatchObject({ type: 'error', reason: expect.stringContaining('http(s)') });
  h.setActive(undefined);
  await popup.send({ type: 'capture' });
  expect(popup.messages.at(-1)).toMatchObject({ type: 'error', reason: expect.stringContaining('标签页') });
  expect(h.open).not.toHaveBeenCalled();
});
it('a popup registering on another tab does not steal a captured session, and close invalidates', async () => {
  const onInvalidated = vi.fn();
  const h = harness(onInvalidated);
  h.save(page(4, 1, 'https://one.test/'));
  const first = await h.ui(h.senders.popup('doc-a'));
  expect(first.messages.at(-1)).toMatchObject({ type: 'page', page: { tabId: 4, url: 'https://one.test/' } });
  const count = first.messages.length;
  h.setActive(page(5, 2, 'https://two.test/'));
  h.save(page(5, 2, 'https://two.test/'));
  const second = await h.ui(h.senders.popup('doc-b'));
  expect(second.messages.at(-1)).toMatchObject({ type: 'page', page: { tabId: 5, url: 'https://two.test/' } });
  expect(first.messages).toHaveLength(count);
  const token = second.messages.at(-1)!.page!.token;
  onInvalidated.mockClear();
  await second.send({ type: 'close' });
  expect(onInvalidated).toHaveBeenCalled();
  expect(second.messages.at(-1)).toEqual({ type: 'invalidated' });
  expect(h.validate({ saveContext: token } as never)).toBe(false);
  expect(h.validate({ saveContext: first.messages.at(-1)!.page!.token } as never)).toBe(true);
});
it('a second popup for the same tab replaces the first, which is invalidated and disconnected', async () => {
  const h = harness();
  h.save(page(4, 1, 'https://example.test/'));
  const first = await h.ui(h.senders.popup('doc-a'));
  const second = await h.ui(h.senders.popup('doc-b'));
  expect(first.messages.at(-1)).toEqual({ type: 'invalidated' });
  expect(second.messages.at(-1)).toMatchObject({ type: 'page', page: { tabId: 4 } });
  expect(h.livePageForSender(second.sender as chrome.runtime.MessageSender)?.tabId).toBe(4);
});
it('untrusted senders and content scripts are ignored', async () => {
  const h = harness();
  h.save(page(4, 1, 'https://example.test/'));
  const foreign = await h.ui({ id: 'other', url: 'chrome-extension://i/panel/index.html' });
  const forged = await h.ui({ id: 'i', url: 'chrome-extension://i/panel/index.html?x=1' });
  const content = await h.ui({
    id: 'i',
    url: 'https://page.test/',
    tab: { id: 4, windowId: 1, url: 'https://page.test/' },
  });
  expect(foreign.messages).toEqual([]);
  expect(forged.messages).toEqual([]);
  expect(content.messages).toEqual([]);
  expect(h.query).not.toHaveBeenCalled();
});
it('the options page registers against the active web tab, never against itself', async () => {
  const h = harness();
  h.save(page(4, 1, 'https://example.test/'));
  const options = await h.ui(h.senders.options(99));
  expect(options.messages.at(-1)).toMatchObject({ type: 'page', page: { tabId: 4, url: 'https://example.test/' } });
  expect(h.livePageForSender(options.sender as chrome.runtime.MessageSender)?.tabId).toBe(4);
});
it('livePageForSender resolves by exact ui document and only falls back for a lone tab-less popup', async () => {
  const h = harness();
  h.save(page(4, 1, 'https://example.test/'));
  const popup = await h.ui(h.senders.popup('doc-a'));
  expect(h.livePageForSender(popup.sender as chrome.runtime.MessageSender)?.tabId).toBe(4);
  expect(h.livePageForSender({ id: 'i', url: 'chrome-extension://i/panel/index.html' })?.tabId).toBe(4);
  expect(
    h.livePageForSender({
      tab: { id: 99, url: 'chrome-extension://i/options/index.html' },
    } as chrome.runtime.MessageSender),
  ).toBeUndefined();
  h.setActive(page(5, 2, 'https://two.test/'));
  h.save(page(5, 2, 'https://two.test/'));
  await h.ui(h.senders.popup('doc-b'));
  expect(h.livePageForSender({ id: 'i', url: 'chrome-extension://i/panel/index.html' })).toBeUndefined();
  expect(h.livePageForSender({ documentId: 'doc-a' } as chrome.runtime.MessageSender)?.tabId).toBe(4);
  expect(h.livePageForSender({ documentId: 'doc-b' } as chrome.runtime.MessageSender)?.tabId).toBe(5);
  popup.disconnect();
  // Only one live popup remains: a tab-less sender resolves to it, a tab-hosted sender still needs an exact match.
  expect(h.livePageForSender({ id: 'i', url: 'chrome-extension://i/panel/index.html' })?.tabId).toBe(5);
  expect(h.livePageForSender({ documentId: 'doc-a', tab: { id: 99 } } as chrome.runtime.MessageSender)).toBeUndefined();
});
it('navigation and tab removal invalidate the live capture and clear the badge', async () => {
  const onInvalidated = vi.fn();
  const h = harness(onInvalidated);
  h.save(page(4, 1, 'https://example.test/'));
  const popup = await h.ui();
  const token = popup.messages.at(-1)!.page!.token;
  onInvalidated.mockClear();
  h.update.emit(4, { status: 'complete' });
  expect(onInvalidated).not.toHaveBeenCalled();
  h.update.emit(4, { status: 'loading' });
  expect(onInvalidated).toHaveBeenCalledOnce();
  expect(popup.messages.at(-1)).toEqual({ type: 'invalidated' });
  expect(h.setBadgeText).toHaveBeenLastCalledWith({ tabId: 4, text: '' });
  expect(h.validate({ saveContext: token } as never)).toBe(false);
  expect(h.validate({} as never)).toBe(true);
  expect(h.livePageForSender(popup.sender as chrome.runtime.MessageSender)).toBeUndefined();
  await popup.send({ type: 'capture' });
  expect(popup.messages.at(-1)).toMatchObject({ type: 'page', page: { tabId: 4 } });
  h.removed.emit(4);
  expect(popup.messages.at(-1)).toEqual({ type: 'invalidated' });
});
it('popup disconnect releases the session so a later shortcut opens the UI again', async () => {
  const h = harness();
  const popup = await h.ui();
  h.save(page(4, 1, 'https://example.test/'));
  expect(h.open).not.toHaveBeenCalled();
  popup.disconnect();
  expect(h.validate({ saveContext: popup.messages.at(-1)!.page!.token } as never)).toBe(false);
  h.save(page(4, 1, 'https://example.test/'));
  expect(h.open).toHaveBeenCalledWith(4);
});
