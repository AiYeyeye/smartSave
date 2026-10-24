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

async function worker(initialization?: Promise<void>) {
  vi.resetModules();
  if (initialization)
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, run: () => Promise<unknown>) => {
          await initialization;
          return run();
        },
      },
    });
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
  const openPopup = vi.fn<(options?: { windowId?: number }) => Promise<void>>(async () => {});
  const setPopup = vi.fn<(details: { tabId?: number; popup: string }) => Promise<void>>(async () => {});
  const popupWindowsByDoc = new Map<string, number>();
  const openSidePanel = vi.fn(async () => {});
  const setBadgeText = vi.fn(async () => {});
  const setBadgeBackgroundColor = vi.fn(async () => {});
  const nativeWrite = vi.fn();
  let active = gestureTab(1);
  const popupWindows = new Map<number, chrome.windows.Window>();
  const createWindow = vi.fn(async () => {
    const windowId = 100 + active.windowId;
    const win = {
      id: windowId,
      type: 'popup',
      tabs: [{ id: 200 + active.windowId, windowId, url: 'chrome-extension://i/save/index.html' }],
    } as chrome.windows.Window;
    popupWindows.set(windowId, win);
    return win;
  });
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', {
    action: {
      onClicked: clicked,
      openPopup,
      setPopup,
      getPopup: async () => '',
      setBadgeText,
      setBadgeBackgroundColor,
    },
    commands: { onCommand: commanded },
    sidePanel: { open: openSidePanel, setPanelBehavior: vi.fn(async () => {}) },
    windows: {
      create: createWindow,
      get: async (id: number) => popupWindows.get(id) ?? { id, type: 'normal', width: 1200, height: 900 },
      update: async (id: number) => popupWindows.get(id),
      getLastFocused: async () => ({ id: active.windowId, type: 'normal' }),
      onFocusChanged: event(),
      onRemoved: event(),
    },
    contextMenus: { onClicked: event(), create: vi.fn((_options, done: () => void) => done()) },
    runtime: {
      id: 'i',
      getURL: (path: string) => `chrome-extension://i/${path}`,
      // A toolbar popup reports the window it was opened in.
      getContexts: async ({ documentIds = [] }: { documentIds?: string[] }) =>
        documentIds.map(documentId => {
          if (!popupWindowsByDoc.has(documentId)) popupWindowsByDoc.set(documentId, active.windowId);
          return { documentId, windowId: popupWindowsByDoc.get(documentId) };
        }),
      onInstalled: installed,
      onStartup: startup,
      onConnect: connected,
      onMessage: messages,
    },
    tabs: {
      query: vi.fn(async () => [active]),
      get: vi.fn(async (id: number) => gestureTab(id - 3)),
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
        remove: async () => {},
      },
      onChanged: event(),
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
    const sender = {
      id: 'i',
      url: 'chrome-extension://i/save/index.html',
      documentId,
      frameId: 0,
    };
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
    connected,
    clicked,
    save,
    popup,
    executeScript,
    sendTabMessage,
    createTab,
    openPopup,
    setPopup,
    openSidePanel,
    createWindow,
    setBadgeText,
    nativeWrite,
    setActive: (tab: chrome.tabs.Tab) => {
      active = tab;
    },
  };
}

it('registers listeners immediately but waits for first-install settings initialization before issuing a workbench lease', async () => {
  let release!: () => void;
  const initial = new Promise<void>(resolve => {
    release = resolve;
  });
  const h = await worker(initial);
  const received: unknown[] = [];
  const incoming = event<(message: unknown) => void>(),
    disconnected = event<() => void>();
  h.connected.emit({
    name: 'zhilan-organizer-authority-v1',
    sender: { id: 'i', url: 'chrome-extension://i/options/index.html' },
    onMessage: incoming,
    onDisconnect: disconnected,
    disconnect: () => disconnected.emit(),
    postMessage: (message: unknown) => received.push(message),
  } as unknown as chrome.runtime.Port);
  await flush();
  expect(received).toEqual([]);
  expect(h.clicked.count()).toBe(1);
  release();
  await vi.waitFor(() =>
    expect(received).toContainEqual(expect.objectContaining({ version: 1, organizerContext: expect.any(String) })),
  );
  disconnected.emit();
  expect(h.nativeWrite).not.toHaveBeenCalled();
});

it('cold worker injects nothing until the toolbar is clicked', async () => {
  const h = await worker();
  expect(h.clicked.count()).toBe(1);
  const ui = h.popup();
  await ui.ready();
  expect(h.executeScript).not.toHaveBeenCalled();
  expect(h.createTab).not.toHaveBeenCalled();
  expect(ui.received).not.toContainEqual(expect.objectContaining({ type: 'page' }));
  expect(h.nativeWrite).not.toHaveBeenCalled();
});
it('toolbar click slides the overlay sidebar into web pages and opens the side panel on browser pages', async () => {
  const h = await worker();
  h.clicked.emit({ id: 4, windowId: 1, url: 'https://page1.test/' } as chrome.tabs.Tab);
  await vi.waitFor(() => expect(h.executeScript).toHaveBeenCalledTimes(2));
  expect(h.executeScript.mock.calls[1]![0]).toMatchObject({ files: ['overlay-sidebar.js'] });
  expect(h.openSidePanel).not.toHaveBeenCalled();
  h.clicked.emit({ id: 5, windowId: 1, url: 'chrome://newtab/' } as chrome.tabs.Tab);
  expect(h.openSidePanel).toHaveBeenCalledWith({ tabId: 5 });
});
it('save shortcut opens the toolbar popup and leaves a badge if the browser cannot show it', async () => {
  const overlay = await worker();
  overlay.save();
  await vi.waitFor(() => expect(overlay.openPopup).toHaveBeenCalledExactlyOnceWith({ windowId: 1 }));
  expect(overlay.setPopup).toHaveBeenCalledWith({ tabId: 4, popup: 'save/index.html' });
  expect(overlay.createWindow).not.toHaveBeenCalled();
  expect(overlay.executeScript).not.toHaveBeenCalled();
  expect(overlay.openSidePanel).not.toHaveBeenCalled();
  expect(overlay.setBadgeText).not.toHaveBeenCalledWith({ tabId: 4, text: SAVE_BADGE });
  const blocked = await worker();
  blocked.openPopup.mockRejectedValue(Error('Browser window has no toolbar.'));
  blocked.save();
  await vi.waitFor(() => expect(blocked.setBadgeText).toHaveBeenCalledWith({ tabId: 4, text: SAVE_BADGE }));
  expect(blocked.createWindow).not.toHaveBeenCalled();
  expect(blocked.createTab).not.toHaveBeenCalled();
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
  expect(h.setBadgeText).toHaveBeenLastCalledWith({ tabId: 4, text: null });
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
