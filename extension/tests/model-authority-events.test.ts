import { expect, it, vi } from 'vitest';
import { SettingsStore } from '../persistence/settings';
import { browserModelAuthority, type ModelAuthorityChange } from '../adapters/model-authority';
import { ModelTransport } from '../adapters/model-transport';
import type { TreeState } from '../domain/node-reference';
const { treeListeners } = vi.hoisted(() => ({ treeListeners: new Set<(state: TreeState) => void>() }));
vi.mock('../panel/tree-client', () => ({
  connectTree: (_runtime: unknown, listener: (value: TreeState) => void) => {
    treeListeners.add(listener);
    listener({
      status: 'ready',
      snapshot: { installationId: 'i', epoch: 'e', observedRevision: 0, roots: [], nodes: [] },
    });
    return () => {
      treeListeners.delete(listener);
    };
  },
}));
function boundary() {
  const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>();
  const permissions = new Set<() => void>();
  vi.stubGlobal('chrome', {
    runtime: {},
    storage: {
      onChanged: {
        addListener: (f: (changes: Record<string, unknown>, area: string) => void) => listeners.add(f),
        removeListener: (f: (changes: Record<string, unknown>, area: string) => void) => listeners.delete(f),
      },
    },
    permissions: {
      onRemoved: {
        addListener: (f: () => void) => permissions.add(f),
        removeListener: (f: () => void) => permissions.delete(f),
      },
    },
  });
  const data: Record<string, unknown> = {};
  const store = new SettingsStore(
    {
      get: async key => ({ [key]: data[key] }),
      set: async value => {
        Object.assign(data, value);
      },
      remove: async key => {
        delete data[key];
      },
      setAccessLevel: async () => {},
    },
    run => run(),
  );
  return { listeners, permissions, store };
}
it.each([
  ['tree.expanded.i', 'local', true],
  ['siteRules', 'local', true],
  ['modelSecurity', 'sync', true],
  ['modelSecurity', 'local', false],
] as const)('filters %s in %s without losing authority invalidation', async (key, area, completes) => {
  const { listeners, store } = boundary();
  await store.load();
  const config = { adapter: 'openai-compatible' as const, baseUrl: 'https://model.test', model: 'm', timeoutMs: 10000 };
  await store.save(config, { fullUrl: true, bodyEnabled: false, excludedFolders: [] }, '', false);
  const authority = browserModelAuthority(store);
  let release!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>(resolve => {
        release = resolve;
      }),
  );
  const transport = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority);
  try {
    const state = await authority.read();
    const pending = transport.run({
      ...state,
      config,
      request: { task: 'search', query: 'synthetic', itemIds: [], folderIds: [] },
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    for (const listener of listeners) listener({ [key]: { newValue: {} } }, area);
    release(new Response(JSON.stringify({ choices: [{ message: { content: '{"rankedIds":[]}' } }] })));
    expect((await pending).status === 'completed').toBe(completes);
  } finally {
    transport.dispose();
    store.dispose();
    expect(listeners.size).toBe(0);
    treeListeners.clear();
    vi.unstubAllGlobals();
  }
});
it('names the changed owner: tree port state, settings envelope, removed permission', async () => {
  const { listeners, permissions, store } = boundary();
  await store.load();
  const authority = browserModelAuthority(store);
  const changes: (ModelAuthorityChange | undefined)[] = [];
  const stop = authority.subscribe(change => changes.push(change));
  try {
    expect(changes).toEqual(['tree']);
    treeListeners.forEach(listener => listener({ status: 'loading' }));
    await expect(authority.read()).rejects.toThrow('tree-unavailable');
    treeListeners.forEach(listener =>
      listener({
        status: 'ready',
        snapshot: { installationId: 'i', epoch: 'e', observedRevision: 1, roots: [], nodes: [] },
      }),
    );
    expect((await authority.read()).tree.observedRevision).toBe(1);
    await store.savePrivacy({ fullUrl: false, bodyEnabled: false, excludedFolders: [] });
    for (const listener of listeners) listener({ modelSecurity: { newValue: {} } }, 'local');
    permissions.forEach(listener => listener());
    expect(changes).toEqual(['tree', 'tree', 'tree', 'settings', 'settings', 'permissions']);
  } finally {
    stop();
    store.dispose();
    expect(permissions.size).toBe(0);
    expect(treeListeners.size).toBe(0);
    vi.unstubAllGlobals();
  }
});
