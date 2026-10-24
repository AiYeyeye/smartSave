import { afterEach, expect, it, vi } from 'vitest';
import { SAVE_CONFIRM_PORT, SaveDialogHost, startSaveDialogService } from '../background/save-dialog';
import { SAVE_CONFIRM_QUEUE_KEY } from '../persistence/save-confirm';

const PAGE = 'save/index.html';
it('dismisses durable state before removing a queued reminder, with strict popup-only authorization', async () => {
  const f = setup();
  await f.host.openAutomatic('gone', 1);
  startSaveDialogService(f.host);
  const message = { type: 'saveConfirmDismiss', receiptId: 'gone' };
  for (const sender of [
    { ...f.popupSender, url: 'chrome-extension://i/panel/index.html' },
    { ...f.popupSender, id: 'foreign' },
  ]) {
    const reply = vi.fn();
    expect(f.messages[0]!(message, sender, reply)).toBe(false);
    expect(reply).toHaveBeenCalledWith({ status: 'error' });
  }
  expect(f.dismiss).not.toHaveBeenCalled();
  f.dismiss.mockRejectedValueOnce(Error('storage'));
  const failed = vi.fn();
  f.messages[0]!(message, f.popupSender, failed);
  await vi.waitFor(() => expect(failed).toHaveBeenCalledWith({ status: 'error' }));
  expect(f.session[SAVE_CONFIRM_QUEUE_KEY]).toEqual(['gone']);
  let resolve!: () => void;
  f.dismiss.mockImplementationOnce(
    () =>
      new Promise<void>(done => {
        resolve = done;
      }),
  );
  const success = vi.fn();
  f.messages[0]!(message, f.popupSender, success);
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  expect(f.session[SAVE_CONFIRM_QUEUE_KEY]).toEqual(['gone']);
  resolve();
  await vi.waitFor(() => expect(success).toHaveBeenCalledWith({ status: 'done', remaining: 0 }));
  expect(f.session[SAVE_CONFIRM_QUEUE_KEY]).toEqual([]);
  f.connect();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Listener<T extends unknown[]> = (...args: T) => void;
function setup({ armedOnStart = [] as number[] } = {}) {
  const session: Record<string, unknown> = {};
  const connects: Listener<[chrome.runtime.Port]>[] = [];
  const focus: Listener<[number]>[] = [];
  const activated: Listener<[{ tabId: number; windowId: number }]>[] = [];
  const messages: Array<
    (raw: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown
  > = [];
  const popups = new Map<number, string>(armedOnStart.map(id => [id, `chrome-extension://i/${PAGE}`]));
  const action = {
    setPopup: vi.fn(async ({ tabId, popup }: { tabId?: number; popup: string }) => {
      popups.set(tabId!, popup);
    }),
    openPopup: vi.fn<(options?: { windowId?: number }) => Promise<void>>(async () => {}),
    getPopup: vi.fn(async ({ tabId }: { tabId?: number }) => popups.get(tabId!) ?? ''),
  };
  let active = 11;
  vi.stubGlobal('chrome', {
    action,
    runtime: {
      id: 'i',
      getURL: (path: string) => `chrome-extension://i/${path}`,
      sendMessage: vi.fn(async () => {}),
      onMessage: { addListener: (fn: (typeof messages)[number]) => messages.push(fn) },
      onConnect: { addListener: (fn: (typeof connects)[number]) => connects.push(fn) },
      getPlatformInfo: vi.fn(async () => ({})),
      // Toolbar popups report the browser window they are shown in.
      // Like Chromium: a popup context may report windowId -1; with a document id it reports its own window.
      getContexts: vi.fn(async ({ documentIds }: { documentIds?: string[] }) =>
        documentIds
          ? documentIds.map(documentId => ({ documentId, windowId: documentId === 'popup-doc-2' ? 2 : 1 }))
          : [{ documentUrl: 'chrome-extension://i/save/index.html', windowId: -1 }],
      ),
    },
    windows: {
      create: vi.fn(),
      update: vi.fn(),
      getLastFocused: vi.fn(async () => ({ id: 1, type: 'normal' })),
      onFocusChanged: { addListener: (fn: (typeof focus)[number]) => focus.push(fn) },
      onRemoved: { addListener: vi.fn() },
    },
    tabs: {
      create: vi.fn(),
      get: vi.fn(async (id: number) => ({ id, windowId: id === 50 ? 2 : 1 })),
      query: vi.fn(async (query: chrome.tabs.QueryInfo) =>
        query.active
          ? [{ id: query.windowId === 2 ? 51 : active, windowId: query.windowId ?? 1 }]
          : [{ id: 11 }, { id: 12 }],
      ),
      onActivated: { addListener: (fn: (typeof activated)[number]) => activated.push(fn) },
      onRemoved: { addListener: vi.fn() },
    },
    storage: {
      session: {
        get: async (key: string) => (key in session ? { [key]: structuredClone(session[key]) } : {}),
        set: async (items: Record<string, unknown>) => Object.assign(session, structuredClone(items)),
        remove: async (key: string) => void delete session[key],
      },
    },
  });
  const hint = vi.fn();
  const pending = vi.fn(async () => ['older', 'newer']);
  const dismiss = vi.fn<(id: string) => Promise<void>>(async () => {});
  const host = new SaveDialogHost({ hint, pending, dismiss });
  const popupSender = {
    id: 'i',
    url: `chrome-extension://i/${PAGE}`,
    origin: 'chrome-extension://i',
  } as chrome.runtime.MessageSender;
  /** A popup document connecting its presence port; returns a disconnect trigger. */
  function connect(sender: chrome.runtime.MessageSender = popupSender) {
    const closed: Array<() => void> = [];
    const port = {
      name: SAVE_CONFIRM_PORT,
      sender,
      disconnect: vi.fn(),
      onDisconnect: { addListener: (fn: () => void) => closed.push(fn) },
    } as unknown as chrome.runtime.Port;
    connects.forEach(fn => fn(port));
    return { port, close: () => closed.forEach(fn => fn()) };
  }
  return {
    host,
    action,
    hint,
    pending,
    dismiss,
    session,
    popups,
    messages,
    popupSender,
    connect,
    focus: (id: number) => focus.forEach(fn => fn(id)),
    activate: (tabId: number, windowId: number) => {
      active = tabId;
      activated.forEach(fn => fn({ tabId, windowId }));
    },
    queue: () => session[SAVE_CONFIRM_QUEUE_KEY],
  };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
const inactive = Error('Cannot show popup for an inactive window.');

it('automatic presentation arms the active tab and opens the toolbar popup once per receipt; no window is created', async () => {
  const h = setup();
  await h.host.openAutomatic('first', 1);
  expect(h.action.setPopup).toHaveBeenCalledWith({ tabId: 11, popup: PAGE });
  expect(h.action.openPopup).toHaveBeenCalledExactlyOnceWith({ windowId: 1 });
  expect(h.queue()).toEqual(['first']);
  await h.host.openAutomatic('first', 1);
  expect(h.action.openPopup).toHaveBeenCalledOnce();
  expect(chrome.windows.create).not.toHaveBeenCalled();
  expect(chrome.windows.update).not.toHaveBeenCalled();
  expect(chrome.tabs.create).not.toHaveBeenCalled();
});

it('an open popup only queues later saves and returns the toolbar click when it closes', async () => {
  const h = setup();
  await h.host.openAutomatic('first', 1);
  const popup = h.connect();
  expect(h.host.showing).toBe(true);
  await h.host.openAutomatic('second', 1);
  await h.host.openAutomatic('third', 2);
  expect(h.action.openPopup).toHaveBeenCalledOnce();
  expect(h.queue()).toEqual(['first', 'second', 'third']);
  popup.close();
  await vi.waitFor(() => expect(h.action.setPopup).toHaveBeenLastCalledWith({ tabId: 11, popup: '' }));
  expect(h.host.showing).toBe(false);
  await h.host.done('first');
  expect(h.queue()).toEqual(['second', 'third']);
});

it('an inactive window is retried without stealing focus and presents once the window is active again', async () => {
  vi.useFakeTimers();
  const h = setup();
  h.action.openPopup.mockRejectedValueOnce(inactive).mockRejectedValueOnce(inactive);
  await h.host.openAutomatic('first', 1);
  // A failed attempt never leaves the toolbar click replaced.
  expect(h.popups.get(11)).toBe('');
  await vi.advanceTimersByTimeAsync(400);
  expect(h.action.openPopup).toHaveBeenCalledTimes(2);
  h.focus(1);
  await flush();
  expect(h.action.openPopup).toHaveBeenCalledTimes(3);
  expect(h.popups.get(11)).toBe(PAGE);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.action.openPopup).toHaveBeenCalledTimes(3);
  expect(chrome.windows.update).not.toHaveBeenCalled();
  expect(chrome.windows.create).not.toHaveBeenCalled();
});

it('switching tabs retries on the newly active tab', async () => {
  vi.useFakeTimers();
  const h = setup();
  h.action.openPopup.mockRejectedValueOnce(inactive);
  await h.host.openAutomatic('first', 1);
  h.activate(12, 1);
  await flush();
  expect(h.action.setPopup).toHaveBeenCalledWith({ tabId: 12, popup: PAGE });
  expect(h.action.openPopup).toHaveBeenCalledTimes(2);
});

it('after the quick retries the tab keeps the popup armed with a hint, and a later focus return presents it', async () => {
  vi.useFakeTimers();
  const h = setup();
  h.action.openPopup.mockRejectedValue(inactive);
  await h.host.openAutomatic('first', 1);
  await vi.advanceTimersByTimeAsync(120_000);
  const attempts = h.action.openPopup.mock.calls.length;
  expect(attempts).toBe(12);
  expect(h.popups.get(11)).toBe(PAGE);
  expect(h.hint).toHaveBeenCalledExactlyOnceWith(11, true);
  h.action.openPopup.mockResolvedValue();
  h.focus(1);
  await flush();
  expect(h.action.openPopup).toHaveBeenCalledTimes(attempts + 1);
  h.connect();
  expect(h.hint).toHaveBeenLastCalledWith(11, false);
  expect(chrome.windows.update).not.toHaveBeenCalled();
});

it('an arm whose popup never connects returns the toolbar click', async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.host.openAutomatic('first', 1);
  expect(h.popups.get(11)).toBe(PAGE);
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.popups.get(11)).toBe('');
});

it('only the tab-less top-level save document can hold the popup port', async () => {
  const h = setup();
  for (const sender of [
    { ...h.popupSender, tab: { id: 3, windowId: 1, url: 'https://evil.test/' } },
    { ...h.popupSender, frameId: 2 },
    { ...h.popupSender, url: 'chrome-extension://i/panel/index.html' },
    { ...h.popupSender, id: 'other', url: `chrome-extension://other/${PAGE}` },
  ] as chrome.runtime.MessageSender[]) {
    const { port } = h.connect(sender);
    expect(port.disconnect).toHaveBeenCalled();
  }
  expect(h.host.showing).toBe(false);
});

it('captures queue frozen source tabs for the toolbar popup only', async () => {
  const h = setup();
  await Promise.all([h.host.openCapture(4), h.host.openCapture(5)]);
  expect(h.action.openPopup).toHaveBeenCalledOnce();
  expect(await h.host.sourceForSender(h.popupSender)).toBe(4);
  expect(await h.host.sourceForSender({ ...h.popupSender, frameId: 3 })).toBeUndefined();
  expect(
    await h.host.sourceForSender({ ...h.popupSender, tab: { id: 9, windowId: 1 } as chrome.tabs.Tab }),
  ).toBeUndefined();
  await h.host.finishCapture(h.popupSender, 4);
  expect(await h.host.sourceForSender(h.popupSender)).toBe(5);
  // Each window has its own toolbar popup: a shown popup is woken, another window gets its own.
  h.connect();
  await h.host.openCapture(7);
  expect(h.action.openPopup).toHaveBeenCalledOnce();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'saveDialogUpdated' });
  await h.host.openCapture(50);
  expect(h.action.openPopup).toHaveBeenLastCalledWith({ windowId: 2 });
  const other = { ...h.popupSender, documentId: 'popup-doc-2' };
  expect(await h.host.sourceForSender(other)).toBe(50);
  expect(await h.host.sourceForSender(h.popupSender)).toBe(5);
});

it('explicit open requests are sender validated, queue pending receipts and do not retry after failing', async () => {
  vi.useFakeTimers();
  const h = setup();
  startSaveDialogService(h.host);
  const reply = vi.fn();
  h.messages[0]!({ type: 'openSaveDialog' }, { id: 'other', url: 'https://evil.test/' }, reply);
  h.messages[0]!({ type: 'openSaveDialog', tabId: 7 }, h.popupSender, reply);
  expect(reply).toHaveBeenCalledWith({ status: 'error' });
  expect(h.action.openPopup).not.toHaveBeenCalled();
  const panel = { id: 'i', url: 'chrome-extension://i/panel/index.html', documentId: 'panel-doc', frameId: 0 };
  h.messages[0]!({ type: 'openSaveDialog' }, panel, reply);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ status: 'opened' }));
  expect(h.queue()).toEqual(['older', 'newer']);
  h.action.openPopup.mockRejectedValue(inactive);
  const failed = vi.fn();
  h.messages[0]!({ type: 'openSaveDialog' }, panel, failed);
  await vi.waitFor(() => expect(failed).toHaveBeenCalledWith({ status: 'error' }));
  const attempts = h.action.openPopup.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.action.openPopup).toHaveBeenCalledTimes(attempts);
});

it('only a save document may take an entry out of the queue', async () => {
  const h = setup();
  startSaveDialogService(h.host);
  await h.host.openAutomatic('first', 1);
  const reply = vi.fn();
  h.messages[0]!(
    { type: 'saveConfirmDone', receiptId: 'first' },
    { id: 'i', url: 'chrome-extension://i/panel/index.html' },
    reply,
  );
  h.messages[0]!({ type: 'saveConfirmDone', receiptId: 'first', extra: 1 }, h.popupSender, reply);
  expect(reply).toHaveBeenCalledTimes(2);
  expect(reply).toHaveBeenNthCalledWith(1, { status: 'error' });
  expect(h.queue()).toEqual(['first']);
  h.messages[0]!({ type: 'saveConfirmDone', receiptId: 'first' }, h.popupSender, reply);
  await vi.waitFor(() => expect(reply).toHaveBeenLastCalledWith({ status: 'done', remaining: 0 }));
  expect(h.queue()).toEqual([]);
});

it('a fresh worker returns toolbar clicks armed by an earlier worker', async () => {
  const h = setup({ armedOnStart: [12] });
  await vi.waitFor(() => expect(h.action.setPopup).toHaveBeenCalledWith({ tabId: 12, popup: '' }));
  expect(h.action.setPopup).not.toHaveBeenCalledWith({ tabId: 11, popup: '' });
});

it('no product code hosts the save confirmation in a browser window or tab', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { extname, join } = await import('node:path');
  // Tests run from the extension package root, like the other source-reading tests.
  const root = process.cwd();
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (['.ts', '.tsx'].includes(extname(name))) sources.push(path);
    }
  };
  for (const dir of ['adapters', 'background', 'content', 'domain', 'options', 'panel', 'persistence', 'save', 'ui'])
    walk(join(root, dir));
  expect(sources.length).toBeGreaterThan(50);
  for (const path of sources) expect(readFileSync(path, 'utf8'), path).not.toMatch(/type:\s*['"]popup['"]/);
  const host = readFileSync(join(root, 'background', 'save-dialog.ts'), 'utf8');
  expect(host).not.toMatch(/windows\.(create|update)|tabs\.create/);
  expect(host).toMatch(/action\.openPopup|openPopup\(/);
});
