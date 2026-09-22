import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { SAVE_BADGE, SAVE_PORT } from '../background/save-entrypoints';

function event<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    addListener: (listener: T) => {
      listeners.add(listener);
    },
    removeListener: (listener: T) => {
      listeners.delete(listener);
    },
    emit: (...args: Parameters<T>) => {
      listeners.forEach(listener => listener(...args));
    },
    count: () => listeners.size,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function worker(withOpenPopup = false) {
  vi.resetModules();
  const messages =
    event<(message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown>();
  const installed = event<() => void>();
  const startup = event<() => void>();
  const clicked = event<(tab: chrome.tabs.Tab) => void>();
  const connected = event<(port: chrome.runtime.Port) => void>();
  const commanded = event<(name: string, tab?: chrome.tabs.Tab) => void>();
  const executeScript = vi.fn<(injection: { files?: string[] }) => Promise<{ frameId: number; documentId?: string }[]>>(
    async () => [],
  );
  const sendTabMessage = vi.fn<
    (tabId: number, message: unknown, options?: { documentId?: string }) => Promise<unknown>
  >(async () => undefined);
  const createTab = vi.fn(async () => ({ id: 99 }));
  const openPopup = vi.fn(async () => {});
  const setBadgeText = vi.fn(async () => {});
  const setBadgeBackgroundColor = vi.fn(async () => {});
  const nativeWrite = vi.fn();
  let active = gestureTab(1);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', {
    action: withOpenPopup
      ? { onClicked: clicked, openPopup, setBadgeText, setBadgeBackgroundColor }
      : { onClicked: clicked, setBadgeText, setBadgeBackgroundColor },
    commands: { onCommand: commanded },
    contextMenus: { onClicked: event(), create: vi.fn((_options, done: () => void) => done()) },
    runtime: {
      id: 'i',
      getURL: (path: string) => `chrome-extension://i/${path}`,
      onInstalled: installed,
      onStartup: startup,
      onConnect: connected,
      onMessage: messages,
    },
    tabs: {
      query: vi.fn(async () => [active]),
      get: vi.fn(async () => ({ url: 'https://page1.test/' })),
      sendMessage: sendTabMessage,
      onUpdated: event(),
      onRemoved: event(),
      onActivated: event(),
      create: createTab,
    },
    scripting: { executeScript },
    storage: {
      local: {
        setAccessLevel: async () => {},
        get: async () => ({ installationId: 'test-install' }),
        set: async () => {},
      },
    },
    bookmarks: {
      getTree: async () => [],
      create: nativeWrite,
      update: nativeWrite,
      move: nativeWrite,
      remove: nativeWrite,
      onCreated: event(),
      onChanged: event(),
      onMoved: event(),
      onRemoved: event(),
      onChildrenReordered: event(),
      onImportBegan: event(),
      onImportEnded: event(),
    },
  });
  await import('../background/service-worker');
  function gestureTab(windowId: number) {
    return {
      id: windowId + 3,
      windowId,
      url: `https://page${windowId}.test/`,
      title: `Page ${windowId}`,
    } as chrome.tabs.Tab;
  }
  function save(windowId = 1) {
    active = gestureTab(windowId);
    commanded.emit('save-current-page', gestureTab(windowId));
  }
  /** The toolbar popup: an extension document without a hosting tab, identified by its document id. */
  function popup(documentId = 'popup-doc') {
    const sender = { id: 'i', url: 'chrome-extension://i/panel/index.html', documentId };
    const received: unknown[] = [];
    const incoming = event<(message: unknown) => void>();
    const disconnected = event<() => void>();
    const port = {
      name: SAVE_PORT,
      sender,
      postMessage: (message: unknown) => received.push(message),
      onMessage: incoming,
      onDisconnect: disconnected,
      disconnect: () => disconnected.emit(),
    };
    connected.emit(port as unknown as chrome.runtime.Port);
    incoming.emit({ type: 'register' });
    return { sender: sender as chrome.runtime.MessageSender, received, ready: flush };
  }
  return {
    messages,
    clicked,
    save,
    popup,
    executeScript,
    sendTabMessage,
    createTab,
    openPopup,
    setBadgeText,
    nativeWrite,
    setActive: (tab: chrome.tabs.Tab) => {
      active = tab;
    },
  };
}

it('cold worker registers no toolbar click listener and never injects into pages', async () => {
  const h = await worker();
  expect(h.clicked.count()).toBe(0);
  const ui = h.popup();
  await ui.ready();
  expect(h.executeScript).not.toHaveBeenCalled();
  expect(h.createTab).not.toHaveBeenCalled();
  expect(ui.received).not.toContainEqual(expect.objectContaining({ type: 'page' }));
  expect(h.nativeWrite).not.toHaveBeenCalled();
});
it('cold worker shortcut sets the badge on Chrome 114-126 and opens the popup on Chrome 127+', async () => {
  const badge = await worker(false);
  badge.save();
  await flush();
  expect(badge.setBadgeText).toHaveBeenCalledWith({ tabId: 4, text: SAVE_BADGE });
  expect(badge.openPopup).not.toHaveBeenCalled();
  const native = await worker(true);
  native.save();
  await flush();
  expect(native.openPopup).toHaveBeenCalledOnce();
  expect(native.setBadgeText).not.toHaveBeenCalledWith({ tabId: 4, text: SAVE_BADGE });
  expect(native.executeScript).not.toHaveBeenCalled();
  expect(native.createTab).not.toHaveBeenCalled();
});
it('named save command captures before UI registration and the popup retrieves it', async () => {
  const h = await worker();
  h.save();
  const ui = h.popup();
  await ui.ready();
  expect(ui.received).toContainEqual({
    type: 'page',
    page: { tabId: 4, token: expect.any(String), url: 'https://page1.test/', title: 'Page 1' },
  });
  expect(h.setBadgeText).toHaveBeenLastCalledWith({ tabId: 4, text: '' });
  expect(h.nativeWrite).not.toHaveBeenCalled();
});
it('two windows do not steal save ports through the production worker', async () => {
  const h = await worker();
  h.save(1);
  const first = h.popup('doc-a');
  await first.ready();
  h.save(2);
  const second = h.popup('doc-b');
  await second.ready();
  expect(first.received.at(-1)).toMatchObject({ type: 'page', page: { tabId: 4 } });
  expect(second.received.at(-1)).toMatchObject({ type: 'page', page: { tabId: 5 } });
});
it('production worker routes exact trusted metadata-only file output control', async () => {
  const h = await worker();
  const reply = vi.fn();
  const message = { version: 1, type: 'fileOutput', action: 'status' };
  h.messages.emit(message, { id: 'foreign', url: 'chrome-extension://i/options/index.html' }, reply);
  h.messages.emit({ ...message, handle: {} }, { id: 'i', url: 'chrome-extension://i/options/index.html' }, reply);
  expect(reply).not.toHaveBeenCalled();
  h.messages.emit(message, { id: 'i', url: 'chrome-extension://i/options/index.html' }, reply);
  expect(reply).toHaveBeenCalledWith({ status: 'stopped' });
  expect(h.nativeWrite).not.toHaveBeenCalled();
});
it('production worker replies a body only to the live popup when it matches the page and the 1500-code-point bound', async () => {
  const h = await worker();
  h.save();
  const ui = h.popup();
  await ui.ready();
  h.executeScript.mockImplementation(async injection =>
    injection.files?.includes('content-script.js') ? [{ frameId: 0, documentId: 'doc' }] : [],
  );
  async function extract(response: unknown) {
    h.sendTabMessage.mockImplementation(async (_tabId, message) =>
      (message as { type: string }).type === 'zhilan-extract-current-page' ? response : { status: 'cancelled' },
    );
    const reply = vi.fn();
    h.messages.emit({ type: 'extractSaveBody' }, ui.sender, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    return reply.mock.calls[0]![0];
  }
  expect(await extract({ status: 'ready', url: 'https://page1.test/', snippet: 'a'.repeat(1501) })).toMatchObject({
    status: 'error',
  });
  expect(await extract({ status: 'ready', url: 'https://other.test/', snippet: 'body' })).toMatchObject({
    status: 'error',
  });
  expect(await extract({ status: 'ready', url: 'https://page1.test/', snippet: '😀'.repeat(1500) })).toEqual({
    status: 'ready',
    url: 'https://page1.test/',
    snippet: '😀'.repeat(1500),
  });
  expect(h.sendTabMessage).toHaveBeenLastCalledWith(4, { type: 'zhilan-cancel-extraction' }, { documentId: 'doc' });
  // A foreign extension id with the popup's own URL and document id gets no reply and no extraction at all.
  const injections = h.executeScript.mock.calls.length;
  const silent = vi.fn();
  h.messages.emit(
    { type: 'extractSaveBody' },
    { id: 'other', url: 'chrome-extension://i/panel/index.html', documentId: 'popup-doc' },
    silent,
  );
  await flush();
  expect(silent).not.toHaveBeenCalled();
  expect(h.executeScript).toHaveBeenCalledTimes(injections);
  expect(h.nativeWrite).not.toHaveBeenCalled();
});
