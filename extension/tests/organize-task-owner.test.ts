import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { OrganizeTaskOwner } from '../background/organize-task-owner';
import { OrganizeCheckpointStore } from '../persistence/organize-checkpoints';
import type { ModelTransport, ModelResult } from '../adapters/model-transport';
import { settingsIdentity } from '../domain/context-dependencies';
import type { TreeState } from '../domain/node-reference';
import { organizerTree } from './fixtures/organizer-tree';

const folder = {
  status: 'completed' as const,
  output: { newFolders: [{ id: 'new', parentId: 'bar', title: '工具' }], moves: [], merges: [] },
};
const request = {
  scopeId: 'bar',
  preference: { style: 'topic' as const, instructions: '' },
  options: { batchSize: 1, cleanupEmpty: false },
};
function setup(factory = new IDBFactory()) {
  const tree = organizerTree();
  const state: TreeState = { status: 'ready', snapshot: tree };
  const treeListeners = new Set<(state: TreeState) => void>();
  const settingsListeners = new Set<() => void>();
  const value = {
    version: 1 as const,
    revision: 'settings-one',
    sessionRevision: 7,
    key: '',
    config: { adapter: 'openai-responses' as const, baseUrl: 'https://models.test/v1', model: 'm', timeoutMs: 1000 },
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
  };
  const projection = {
    state,
    fresh: async () => structuredClone(tree),
    subscribe: (listener: (state: TreeState) => void) => {
      treeListeners.add(listener);
      listener(state);
      return () => {
        treeListeners.delete(listener);
      };
    },
  };
  const settings = {
    snapshot: async () => structuredClone(value),
    subscribe: (listener: () => void) => {
      settingsListeners.add(listener);
      return () => {
        settingsListeners.delete(listener);
      };
    },
  };
  const store = new OrganizeCheckpointStore(factory);
  const run = vi.fn<ModelTransport['run']>();
  const cancel = vi.fn(),
    dispose = vi.fn(),
    release = vi.fn();
  const lifetime = { acquire: vi.fn(() => release), dispose: vi.fn() };
  const owner = new OrganizeTaskOwner({
    projection,
    settings,
    store,
    lifetime,
    model: () => ({ run, cancel, dispose, fork: () => ({ run, cancel, dispose }) }),
  });
  const credential = { revision: value.revision, identity: settingsIdentity(value), key: 'task-temporary-secret' };
  return { owner, store, run, tree, value, projection, settings, lifetime, release, credential, settingsListeners };
}
async function idle(h: ReturnType<typeof setup>, id: string) {
  await vi.waitFor(async () => expect((await h.owner.get(id)).state.busy).toBe(false));
  return h.owner.get(id);
}

it('continues without subscribers, checkpoints out-of-order results and resumes only missing work after a worker replacement', async () => {
  const factory = new IDBFactory(),
    h = setup(factory);
  const finishes = new Map<string, (value: ModelResult) => void>();
  h.run.mockImplementation(
    input =>
      new Promise(resolve => {
        finishes.set(
          input.request.task === 'organize' && input.request.stage === 'folders'
            ? 'folders'
            : 'itemIds' in input.request
              ? input.request.itemIds[0]!
              : '',
          resolve,
        );
      }),
  );
  const subscriber = vi.fn(),
    unsubscribe = h.owner.subscribe(subscriber);
  const started = await h.owner.start({ ...request, credential: h.credential });
  await vi.waitFor(() => expect(finishes.has('folders')).toBe(true));
  expect(started.state.busy).toBe(true);
  unsubscribe();
  const observed = subscriber.mock.calls.length;
  finishes.get('folders')!(folder);
  const reviewed = await idle(h, started.id);
  expect(subscriber).toHaveBeenCalledTimes(observed);
  expect(reviewed.state.pipeline?.stage).toBe('folders');
  await h.owner.command(started.id, reviewed.revision, 'confirmFolders');
  await vi.waitFor(() => expect(finishes.has('a') && finishes.has('b')).toBe(true));
  finishes.get('b')!({
    status: 'completed',
    output: { newFolders: [], merges: [], moves: [{ itemId: 'b', folderId: 'new' }] },
  });
  await vi.waitFor(async () =>
    expect((await h.store.get(started.id))?.batches.map(batch => batch.status)).toEqual(['pending', 'accepted']),
  );
  expect(h.run.mock.calls.every(([input]) => input.key === h.credential.key)).toBe(true);
  expect(JSON.stringify(await h.store.get(started.id))).not.toContain(h.credential.key);
  expect(h.lifetime.acquire.mock.calls.length).toBeGreaterThan(1);
  h.owner.dispose();
  const next = setup(factory);
  const restored = await next.owner.get(started.id);
  expect(restored.needsCredential).toBe(true);
  expect(restored.state.pipeline).toMatchObject({ status: 'paused', analyzed: 1, completed: 0 });
  expect(next.run).not.toHaveBeenCalled();
  await expect(next.owner.command(started.id, restored.revision, 'resume')).rejects.toThrow('credential-required');
  expect(next.run).not.toHaveBeenCalled();
  next.run.mockResolvedValue({
    status: 'completed',
    output: { newFolders: [], merges: [], moves: [{ itemId: 'a', folderId: 'new' }] },
  });
  await next.owner.command(started.id, restored.revision, 'resume', next.credential);
  const completed = await idle(next, started.id);
  expect(completed.state.pipeline).toMatchObject({ stage: 'complete', completed: 2 });
  expect(next.run).toHaveBeenCalledTimes(1);
  expect(next.run.mock.calls[0]![0].request).toMatchObject({ itemIds: ['a'] });
  expect((await next.store.get(started.id))?.requiresCredential).toBe(true);
  expect(JSON.stringify(completed)).not.toContain(next.credential.key);
  next.owner.dispose();
});

it('reserves start and review edits so simultaneous pages cannot both commit using an old revision', async () => {
  const h = setup();
  let finish!: (result: ModelResult) => void;
  h.run.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const results = await Promise.allSettled([h.owner.start(request), h.owner.start(request)]);
  expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  const started = results.find(value => value.status === 'fulfilled');
  if (started?.status !== 'fulfilled') throw Error('missing-start');
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce());
  finish(folder);
  const reviewed = await idle(h, started.value.id);
  const edits = await Promise.allSettled([
    h.owner.select(reviewed.id, reviewed.revision, { ids: ['create:new'], selected: false }),
    h.owner.select(reviewed.id, reviewed.revision, { ids: ['create:new'], selected: true }),
  ]);
  expect(edits.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(edits.filter(value => value.status === 'rejected')).toHaveLength(1);
  expect((await h.store.get(reviewed.id))?.selection.selected).toEqual([]);
  h.owner.dispose();
});

it('binds in-memory credentials to current settings and invalidates on configuration changes', async () => {
  const h = setup();
  await expect(h.owner.start({ ...request, credential: { ...h.credential, revision: 'foreign' } })).rejects.toThrow(
    'stale-context',
  );
  expect(h.run).not.toHaveBeenCalled();
  h.run.mockResolvedValue(folder);
  const started = await h.owner.start({ ...request, credential: h.credential });
  const reviewed = await idle(h, started.id);
  h.value.config.model = 'changed';
  h.value.revision = 'changed-revision';
  h.settingsListeners.forEach(listener => listener());
  await vi.waitFor(async () => expect((await h.store.get(reviewed.id))?.status).toBe('invalid'));
  expect((await h.owner.get(reviewed.id)).state.invalid).toBe(true);
  expect(h.run).toHaveBeenCalledOnce();
  h.owner.dispose();
});
