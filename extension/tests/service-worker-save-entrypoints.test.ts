import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { SAVE_PORT } from '../background/save-entrypoints';
import { resetUiRegistry } from '../background/ui-identity';

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
  resetUiRegistry();
});

async function worker() {
  vi.resetModules();
  resetUiRegistry();
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
  const nativeWrite = vi.fn();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', {
    action: { onClicked: clicked },
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
      query: vi.fn(async () => []),
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
  function click(windowId = 1) {
    expect(clicked.count()).toBe(1);
    clicked.emit(gestureTab(windowId));
  }
  function save(windowId = 1) {
    expect(clicked.count()).toBe(1);
    commanded.emit('save-current-page', gestureTab(windowId));
  }
  function panel(tabId = 4) {
    const messages: unknown[] = [];
    const incoming = event<(message: unknown) => void>();
    const disconnected = event<() => void>();
    const port = {
      name: SAVE_PORT,
      sender: {
        id: 'i',
        url: 'chrome-extension://i/options/index.html',
        tab: { id: tabId, windowId: 1, url: 'https://page.test/' },
      },
      postMessage: (message: unknown) => messages.push(message),
      onMessage: incoming,
      onDisconnect: disconnected,
      disconnect: () => disconnected.emit(),
    };
    connected.emit(port as unknown as chrome.runtime.Port);
    incoming.emit({ type: 'register' });
    return messages;
  }
  return { messages, click, save, panel, executeScript, sendTabMessage, createTab, nativeWrite };
}

it('cold worker injects host on toolbar without capture', async () => {
  const h = await worker();
  h.click();
  expect(h.executeScript).toHaveBeenCalled();
  expect(h.panel(4)).not.toContainEqual(expect.objectContaining({ type: 'page' }));
  expect(h.nativeWrite).not.toHaveBeenCalled();
});
it('named save command captures before UI registration', async () => {
  const h = await worker();
  h.save();
  expect(h.executeScript).toHaveBeenCalled();
  expect(h.panel(4)).toContainEqual({
    type: 'page',
    page: { tabId: 4, token: expect.any(String), url: 'https://page1.test/', title: 'Page 1' },
  });
});
it('two tabs do not steal save ports through the production worker', async () => {
  const h = await worker();
  h.save(1);
  const first = h.panel(4);
  h.save(2);
  const second = h.panel(5);
  expect(first.at(-1)).toMatchObject({ type: 'page', page: { tabId: 4 } });
  expect(second.at(-1)).toMatchObject({ type: 'page', page: { tabId: 5 } });
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
it('production worker replies a body only when it matches the live page and the 1500-code-point bound', async () => {
  const h = await worker();
  h.save();
  h.panel(4);
  const sender = {
    id: 'i',
    url: 'chrome-extension://i/options/index.html',
    tab: { id: 4, windowId: 1, url: 'https://page.test/' },
  } as unknown as chrome.runtime.MessageSender;
  h.executeScript.mockImplementation(async injection =>
    injection.files?.includes('content-script.js') ? [{ frameId: 0, documentId: 'doc' }] : [],
  );
  async function extract(response: unknown) {
    h.sendTabMessage.mockImplementation(async (_tabId, message) =>
      (message as { type: string }).type === 'zhilan-extract-current-page' ? response : { status: 'cancelled' },
    );
    const reply = vi.fn();
    h.messages.emit({ type: 'extractSaveBody' }, sender, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(h.sendTabMessage).toHaveBeenLastCalledWith(4, { type: 'zhilan-cancel-extraction' }, { documentId: 'doc' });
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
  expect(h.nativeWrite).not.toHaveBeenCalled();
});
