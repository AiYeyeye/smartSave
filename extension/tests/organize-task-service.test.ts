import { afterEach, expect, it, vi } from 'vitest';
import { startOrganizeTaskService } from '../background/organize-task-service';
import { ORGANIZE_TASK_PORT } from '../domain/organize-task-protocol';
import { setOverlayDocumentTrust, type SenderLite } from '../domain/trusted-sender';
import type { OrganizeTaskView } from '../background/organize-task-owner';

function event<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    addListener: (listener: T) => {
      listeners.add(listener);
    },
    removeListener: (listener: T) => {
      listeners.delete(listener);
    },
    emit: (...args: Parameters<T>) => listeners.forEach(listener => listener(...args)),
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  setOverlayDocumentTrust(undefined);
});
function setup() {
  const messages =
    event<(input: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown>();
  const connected = event<(port: chrome.runtime.Port) => void>();
  vi.stubGlobal('chrome', { runtime: { id: 'extension', onMessage: messages, onConnect: connected } });
  const view: OrganizeTaskView = {
    id: 'task',
    revision: 0,
    needsCredential: false,
    state: {
      tree: { status: 'loading' },
      scopeId: 'bar',
      selected: [],
      targets: {},
      duplicates: [],
      choices: {},
      busy: true,
      invalid: false,
      message: '正在分析',
    },
  };
  const subscribers = new Set<(value: OrganizeTaskView) => void>();
  const owner = {
    start: vi.fn(async () => view),
    get: vi.fn(async () => view),
    list: vi.fn(async () => []),
    command: vi.fn(async () => view),
    reviewContent: vi.fn(async () => view),
    select: vi.fn(async () => view),
    dispose: vi.fn(),
    subscribe: vi.fn((listener: (value: OrganizeTaskView) => void) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    }),
  };
  const badge = { focus: vi.fn(), seen: vi.fn() };
  const stop = startOrganizeTaskService(owner, badge);
  const sender = { id: 'extension', url: 'chrome-extension://extension/options/index.html' };
  return { messages, connected, owner, stop, sender, subscribers, view, badge };
}
function port(sender: SenderLite) {
  const onMessage = event<(message: unknown) => void>(),
    onDisconnect = event<() => void>();
  return {
    name: ORGANIZE_TASK_PORT,
    sender,
    onMessage,
    onDisconnect,
    postMessage: vi.fn(),
    disconnect: vi.fn(() => onDisconnect.emit()),
  };
}
it('never acknowledges automatic reads and binds visible acknowledgements to the watched, delivered task', async () => {
  const h = setup(),
    one = port(h.sender);
  h.messages.emit({ version: 1, type: 'organizeTask', action: 'get', id: 'task' }, h.sender, vi.fn());
  await vi.waitFor(() => expect(h.owner.get).toHaveBeenCalled());
  expect(h.badge.seen).not.toHaveBeenCalled();
  expect(h.badge.focus).not.toHaveBeenCalled();
  h.connected.emit(one as unknown as chrome.runtime.Port);
  one.onMessage.emit({ version: 1, type: 'seen', id: 'task', revision: 0 });
  expect(h.badge.seen).not.toHaveBeenCalled();
  one.onMessage.emit({ version: 1, type: 'subscribe', id: 'task' });
  await vi.waitFor(() => expect(one.postMessage).toHaveBeenCalledWith({ version: 1, task: h.view }));
  one.onMessage.emit({ version: 1, type: 'seen', id: 'other', revision: 0 });
  one.onMessage.emit({ version: 1, type: 'seen', id: 'task', revision: 1 });
  expect(h.badge.seen).not.toHaveBeenCalled();
  one.onMessage.emit({ version: 1, type: 'seen', id: 'task', revision: 0 });
  expect(h.badge.seen).toHaveBeenCalledExactlyOnceWith('task', 0);
  one.disconnect();
  h.stop();
});

it('rejects untrusted and malformed RPC before touching tasks and routes exact trusted commands', async () => {
  const h = setup(),
    reply = vi.fn();
  const list = { version: 1, type: 'organizeTask', action: 'list' };
  h.messages.emit(list, { ...h.sender, id: 'foreign' }, reply);
  expect(reply).toHaveBeenLastCalledWith({ ok: false, reason: 'invalid-sender' });
  h.messages.emit({ ...list, key: 'forbidden' }, h.sender, reply);
  expect(reply).toHaveBeenLastCalledWith({ ok: false, reason: 'invalid-organize-task-request' });
  expect(h.owner.list).not.toHaveBeenCalled();
  h.messages.emit(list, h.sender, reply);
  await vi.waitFor(() => expect(h.owner.list).toHaveBeenCalledOnce());
  h.messages.emit(
    { version: 1, type: 'organizeTask', action: 'pause', id: 'task', expectedRevision: 3 },
    h.sender,
    reply,
  );
  expect(h.owner.command).toHaveBeenCalledWith('task', 3, 'pause', undefined);
  await vi.waitFor(() => expect(reply).toHaveBeenLastCalledWith({ ok: true, task: h.view }));
  expect(h.badge.focus).not.toHaveBeenCalled();
  h.messages.emit(
    { version: 1, type: 'organizeTask', action: 'resume', id: 'task', expectedRevision: 3 },
    h.sender,
    reply,
  );
  await vi.waitFor(() => expect(h.badge.focus).toHaveBeenCalledExactlyOnceWith(h.view));
  h.stop();
});

it('disconnect removes only the observer; task ownership and generation remain intact', () => {
  const h = setup(),
    one = port(h.sender);
  h.connected.emit(one as unknown as chrome.runtime.Port);
  one.onMessage.emit({ version: 1, type: 'subscribe' });
  h.subscribers.forEach(listener => listener(h.view));
  expect(one.postMessage).toHaveBeenCalledWith({ version: 1, task: h.view });
  one.disconnect();
  expect(h.subscribers.size).toBe(0);
  expect(h.owner.command).not.toHaveBeenCalled();
  expect(h.owner.dispose).not.toHaveBeenCalled();
  const forged = port({ ...h.sender, frameId: 1, documentId: 'unclaimed', tab: { id: 1, url: 'https://web.test' } });
  h.connected.emit(forged as unknown as chrome.runtime.Port);
  expect(forged.disconnect).toHaveBeenCalledOnce();
  h.stop();
});

it('never subscribes an overlay port that disconnected while trust restoration was pending', async () => {
  const h = setup();
  let ready!: () => void;
  let trusted = false;
  setOverlayDocumentTrust(
    () => trusted,
    () =>
      new Promise(resolve => {
        ready = resolve;
      }),
  );
  const one = port({
    ...h.sender,
    url: 'chrome-extension://extension/panel/index.html',
    frameId: 1,
    documentId: 'claimed',
    tab: { id: 1, url: 'https://web.test' },
  });
  h.connected.emit(one as unknown as chrome.runtime.Port);
  one.disconnect();
  trusted = true;
  ready();
  await Promise.resolve();
  expect(h.owner.subscribe).not.toHaveBeenCalled();
  h.stop();
});
