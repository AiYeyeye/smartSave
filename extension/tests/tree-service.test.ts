import { afterEach, expect, it, vi } from 'vitest';
import { startTreeService } from '../background/tree-service';
import { TREE_PORT, type TreeState } from '../domain/node-reference';

afterEach(() => vi.unstubAllGlobals());

function event<T extends (...args: never[]) => void>() {
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
  };
}

it.each(['get', 'set', 'setAccessLevel'] as const)(
  'recovers first %s failure through explicit refresh in the same service',
  async failure => {
    const harness = setup(failure);
    const port = harness.connect();
    await vi.waitFor(() => expect(port.state()?.status).toBe('error'));
    expect(harness.getTree).not.toHaveBeenCalled();
    harness.recover();
    port.refresh();
    port.refresh();
    await vi.waitFor(() => expect(port.state()?.status).toBe('ready'));
    const ready = port.state();
    expect(ready).toMatchObject({
      status: 'ready',
      snapshot: { installationId: failure === 'set' ? harness.persisted() : 'existing', observedRevision: 0 },
    });
    const calls = [
      harness.storage.get.mock.calls.length,
      harness.storage.set.mock.calls.length,
      harness.storage.setAccessLevel.mock.calls.length,
    ];
    port.refresh();
    await vi.waitFor(() => expect(port.state()?.status).toBe('ready'));
    expect(port.state()).toEqual(ready);
    expect([
      harness.storage.get.mock.calls.length,
      harness.storage.set.mock.calls.length,
      harness.storage.setAccessLevel.mock.calls.length,
    ]).toEqual(calls);
    expect(harness.storage.set).toHaveBeenCalledTimes(failure === 'set' ? 1 : 0);
  },
);

it.each(['get', 'set', 'setAccessLevel'] as const)(
  'recovers first %s failure on authorized reconnect without a refresh message',
  async failure => {
    const harness = setup(failure);
    const first = harness.connect();
    await vi.waitFor(() => expect(first.state()?.status).toBe('error'));
    first.disconnect();
    harness.recover();
    const second = harness.connect();
    const third = harness.connect();
    await vi.waitFor(() => expect(second.state()?.status).toBe('ready'));
    expect(third.state()).toEqual(second.state());
    expect(first.state()?.status).toBe('error');
    expect(harness.storage.set).toHaveBeenCalledTimes(failure === 'set' ? 1 : 0);
  },
);

function setup(failure: 'get' | 'set' | 'setAccessLevel') {
  let failing = true;
  let installationId: unknown = failure === 'set' ? undefined : 'existing';
  const storage = {
    setAccessLevel: vi.fn(async () => {
      if (failing && failure === 'setAccessLevel') throw Error('access');
    }),
    get: vi.fn(async () => {
      if (failing && failure === 'get') throw Error('read');
      return { installationId };
    }),
    set: vi.fn(async (patch: Record<string, unknown>) => {
      installationId = patch.installationId;
      if (failing && failure === 'set') throw Error('ambiguous write');
    }),
  };
  const onConnect = event<(port: chrome.runtime.Port) => void>();
  const getTree = vi.fn(async () => [{ id: 'root', title: '', syncing: false }]);
  const bookmarks = {
    getTree,
    onCreated: event(),
    onChanged: event(),
    onMoved: event(),
    onRemoved: event(),
    onChildrenReordered: event(),
    onImportBegan: event(),
    onImportEnded: event(),
  };
  vi.stubGlobal('chrome', {
    storage: { local: storage },
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, onConnect },
    bookmarks,
  });
  const projection = startTreeService();
  return {
    storage,
    getTree,
    bookmarks,
    projection,
    recover: () => {
      failing = false;
    },
    persisted: () => installationId,
    connect(url = 'chrome-extension://test/options/index.html', id = 'test') {
      const messages: { version: number; state: TreeState }[] = [];
      const onMessage = event<(message: unknown) => void>();
      const onDisconnect = event<() => void>();
      onConnect.emit({
        name: TREE_PORT,
        sender: { id, url },
        onMessage,
        onDisconnect,
        postMessage: (message: { version: number; state: TreeState }) => {
          messages.push(message);
        },
        disconnect: () => onDisconnect.emit(),
      } as unknown as chrome.runtime.Port);
      return {
        state: () => messages.at(-1)?.state,
        statuses: () => messages.map(message => message.state.status),
        refresh: () => onMessage.emit({ version: 1, type: 'refresh' }),
        disconnect: () => onDisconnect.emit(),
      };
    },
  };
}

it('silent fresh reads publish nothing; native events still publish loading then ready', async () => {
  const harness = setup('get');
  harness.recover();
  const port = harness.connect();
  await vi.waitFor(() => expect(port.state()?.status).toBe('ready'));
  const before = port.statuses().length;
  const reads = harness.getTree.mock.calls.length;
  const snapshot = await harness.projection.fresh();
  expect(snapshot.observedRevision).toBe(0);
  expect(harness.getTree).toHaveBeenCalledTimes(reads + 1);
  expect(port.statuses()).toHaveLength(before);
  expect(harness.projection.state).toMatchObject({ status: 'ready', snapshot: { observedRevision: 0 } });
  harness.bookmarks.onCreated.emit();
  await vi.waitFor(() => expect(port.state()).toMatchObject({ status: 'ready', snapshot: { observedRevision: 1 } }));
  expect(port.statuses().slice(before)).toEqual(['loading', 'ready']);
});
it('a port refresh on a ready tree answers only that port from the published state without a native re-read', async () => {
  const harness = setup('get');
  harness.recover();
  const first = harness.connect();
  const second = harness.connect();
  await vi.waitFor(() => expect(first.state()?.status).toBe('ready'));
  await vi.waitFor(() => expect(second.state()?.status).toBe('ready'));
  const reads = harness.getTree.mock.calls.length;
  const firstCount = first.statuses().length;
  const secondCount = second.statuses().length;
  first.refresh();
  expect(first.statuses()).toHaveLength(firstCount + 1);
  expect(first.state()).toEqual(second.state());
  expect(second.statuses()).toHaveLength(secondCount);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(harness.getTree).toHaveBeenCalledTimes(reads);
});

it('publishes authoritative tree to exact trusted options page and toolbar popup', async () => {
  const harness = setup('get');
  harness.recover();
  const options = harness.connect('chrome-extension://test/options/index.html');
  await vi.waitFor(() => expect(options.state()?.status).toBe('ready'));
  const popup = harness.connect('chrome-extension://test/panel/index.html');
  await vi.waitFor(() => expect(popup.state()?.status).toBe('ready'));
});
it.each([
  'https://evil.test/options/index.html',
  'chrome-extension://test/options/index.html?forged',
  'chrome-extension://test/panel/index.html?forged',
  'chrome-extension://test/other.html',
])('rejects untrusted read consumer %s', async url => {
  const harness = setup('get');
  harness.recover();
  const port = harness.connect(url);
  await vi.waitFor(() => expect(harness.getTree).toHaveBeenCalled());
  expect(port.state()).toBeUndefined();
});
it('rejects a different extension ID even with trusted-looking page URL', async () => {
  const harness = setup('get');
  harness.recover();
  const port = harness.connect('chrome-extension://test/options/index.html', 'other');
  await vi.waitFor(() => expect(harness.getTree).toHaveBeenCalled());
  expect(port.state()).toBeUndefined();
});
