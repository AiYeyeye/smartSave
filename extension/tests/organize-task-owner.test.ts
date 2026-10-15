import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { OrganizeTaskOwner } from '../background/organize-task-owner';
import { OrganizeCheckpointStore } from '../persistence/organize-checkpoints';
import type { ModelTransport, ModelResult, ModelProgress } from '../adapters/model-transport';
import { settingsIdentity } from '../domain/context-dependencies';
import type { TreeState } from '../domain/node-reference';
import { organizerTree } from './fixtures/organizer-tree';
import { OrganizeMemoryStore } from '../persistence/organize-memory';
import { organizeRejectionKey } from '../domain/organize-review';

const folder = {
  status: 'completed' as const,
  output: { newFolders: [{ id: 'new', parentId: 'bar', title: '工具' }], moves: [], merges: [] },
};
const request = {
  scopeId: 'bar',
  preference: { style: 'topic' as const, instructions: '' },
  options: { batchSize: 1, cleanupEmpty: false },
};
it('coalesces token progress before cloning full task views but publishes durable completion immediately', async () => {
  const h = setup();
  let progress!: (value: ModelProgress) => void;
  let finish!: (value: ModelResult) => void;
  h.run.mockImplementation(input => {
    progress = input.onProgress!;
    return new Promise(done => {
      finish = done;
    });
  });
  const notify = vi.fn();
  h.owner.subscribe(notify);
  const started = await h.owner.start(request);
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce());
  notify.mockClear();
  for (let i = 1; i <= 1000; i++) progress({ phase: 'receiving', streaming: true, text: '{', receivedChars: i });
  expect(notify.mock.calls.length).toBeLessThanOrEqual(2);
  await vi.waitFor(() =>
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ progress: expect.objectContaining({ receivedChars: 1000 }) }),
      }),
    ),
  );
  finish(folder);
  const reviewed = await idle(h, started.id);
  expect(notify).toHaveBeenLastCalledWith(
    expect.objectContaining({
      revision: reviewed.revision,
      state: expect.objectContaining({ busy: false, pipeline: expect.objectContaining({ status: 'review' }) }),
    }),
  );
  expect((await h.store.get(started.id))?.status).toBe('review');
  h.owner.dispose();
});
function setup(factory = new IDBFactory(), memory?: Pick<OrganizeMemoryStore, 'load'>) {
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
    memory,
    model: () => ({ run, cancel, dispose, fork: () => ({ run, cancel, dispose }) }),
  });
  const credential = { revision: value.revision, identity: settingsIdentity(value), key: 'task-temporary-secret' };
  return {
    owner,
    store,
    run,
    cancel,
    tree,
    value,
    projection,
    settings,
    lifetime,
    release,
    credential,
    settingsListeners,
  };
}

it('keeps review and cached batches restorable after remembered rejection without changing generation options', async () => {
  const factory = new IDBFactory(),
    memory = new OrganizeMemoryStore(),
    h = setup(factory, memory);
  h.run.mockResolvedValueOnce(folder).mockImplementation(async input => ({
    status: 'completed',
    output: {
      newFolders: [],
      merges: [],
      moves: 'itemIds' in input.request ? input.request.itemIds.map(itemId => ({ itemId, folderId: 'new' })) : [],
    },
  }));
  const started = await h.owner.start({ ...request, credential: h.credential });
  const folders = await idle(h, started.id);
  await h.owner.command(started.id, folders.revision, 'confirmFolders');
  let reviewed = await idle(h, started.id);
  reviewed = await h.owner.select(started.id, reviewed.revision, { id: 'move:a', target: 'right' });
  const signature = organizeRejectionKey(
    reviewed.state.proposal!,
    reviewed.state.proposal!.actions.find(a => a.id === 'move:a')!,
    reviewed.state.targets,
  );
  await h.owner.select(started.id, reviewed.revision, { ids: ['move:a'], selected: false });
  const before = (await h.store.get(started.id))!;
  await memory.update('install', value => ({ ...value, rejected: [{ signature, label: 'move' }] }));
  await h.owner.refreshMemory('install');
  expect((await h.owner.get(started.id)).state).toMatchObject({ invalid: false, targets: { 'move:a': 'right' } });
  h.owner.dispose();
  const next = setup(factory, memory);
  const restored = await next.owner.get(started.id);
  expect(restored.state.pipeline?.stage).toBe('complete');
  expect(restored.state.invalid).toBe(false);
  expect(restored.state.selected).not.toContain('move:a');
  expect(restored.state.selected).toContain('move:b');
  expect(restored.state.targets['move:a']).toBe('right');
  expect(next.run).not.toHaveBeenCalled();
  const after = (await next.store.get(started.id))!;
  expect(after.options).toEqual(before.options);
  expect(after.batches).toEqual(before.batches);
  await memory.update('install', value => ({ ...value, rejected: [] }));
  await next.owner.refreshMemory('install');
  expect((await next.owner.get(started.id)).state.selected).toEqual(restored.state.selected);
  next.owner.dispose();
});

it('returns a refused locked taxonomy to review and stops in-flight batches without losing its folder output', async () => {
  const memory = new OrganizeMemoryStore(),
    h = setup(new IDBFactory(), memory);
  h.run.mockResolvedValueOnce(folder).mockImplementation(() => new Promise(() => {}));
  const started = await h.owner.start(request);
  const folders = await idle(h, started.id);
  const signature = organizeRejectionKey(folders.state.proposal!, folders.state.proposal!.actions[0]!, {});
  await h.owner.command(started.id, folders.revision, 'confirmFolders');
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(3));
  await memory.update('install', value => ({ ...value, rejected: [{ signature, label: 'folder' }] }));
  await h.owner.refreshMemory('install');
  const reviewed = await h.owner.get(started.id);
  expect(reviewed.state).toMatchObject({
    busy: false,
    invalid: false,
    pipeline: { stage: 'folders', status: 'review' },
  });
  expect(reviewed.state.selected).toEqual([]);
  expect((await h.store.get(started.id))?.folderPlan?.output).toEqual(folder.output);
  expect((await h.store.get(started.id))?.batches).toEqual([]);
  expect(h.run).toHaveBeenCalledTimes(3);
  h.owner.dispose();
});

it('stops a taxonomy refusal during the pending-batch checkpoint before issuing any bookmark model call', async () => {
  const memory = new OrganizeMemoryStore(),
    h = setup(new IDBFactory(), memory);
  h.run.mockResolvedValue(folder);
  const started = await h.owner.start(request);
  const folders = await idle(h, started.id);
  const signature = organizeRejectionKey(folders.state.proposal!, folders.state.proposal!.actions[0]!, {});
  let release!: () => void;
  const delayed = new Promise<void>(resolve => {
    release = resolve;
  });
  const put = h.store.put.bind(h.store);
  let pending = false;
  vi.spyOn(h.store, 'put').mockImplementation(async (checkpoint, revision) => {
    await put(checkpoint, revision);
    if (checkpoint.stage === 'bookmarks' && !pending) {
      pending = true;
      await delayed;
    }
  });
  await h.owner.command(started.id, folders.revision, 'confirmFolders');
  await vi.waitFor(() => expect(pending).toBe(true));
  await memory.update('install', value => ({ ...value, rejected: [{ signature, label: 'folder' }] }));
  h.cancel.mockClear();
  const refreshing = h.owner.refreshMemory('install');
  await vi.waitFor(() => expect(h.cancel).toHaveBeenCalled());
  release();
  await refreshing;
  expect((await h.owner.get(started.id)).state).toMatchObject({ invalid: false, pipeline: { stage: 'folders' } });
  expect(h.run).toHaveBeenCalledTimes(1);
  h.owner.dispose();
});

it('ignores unrelated memory and protection but stops new relevant protection before another model request', async () => {
  const memory = new OrganizeMemoryStore(),
    h = setup(new IDBFactory(), memory);
  h.run.mockResolvedValue(folder);
  const started = await h.owner.start(request);
  await idle(h, started.id);
  await memory.update('another-install', value => ({ ...value, protectedFolderIds: ['bar'] }));
  await h.owner.refreshMemory('another-install');
  await memory.update('install', value => ({ ...value, protectedFolderIds: ['outside', 'missing'] }));
  await h.owner.refreshMemory('install');
  const reviewed = await h.owner.get(started.id);
  expect(reviewed.state.invalid).toBe(false);
  expect(h.run).toHaveBeenCalledTimes(1);
  // No storage event is necessary: the next explicit continuation reads the latest protection itself.
  await memory.update('install', value => ({ ...value, protectedFolderIds: ['0'] }));
  await expect(h.owner.command(started.id, reviewed.revision, 'confirmFolders')).rejects.toThrow('stale-context');
  expect(h.run).toHaveBeenCalledTimes(1);
  expect((await h.store.get(started.id))?.status).toBe('invalid');
  h.owner.dispose();
});

it('accepts an observed older revision only for stopping the same active generation', async () => {
  const h = setup();
  h.run.mockResolvedValueOnce(folder).mockImplementation(() => new Promise(() => {}));
  const started = await h.owner.start(request);
  const reviewed = await idle(h, started.id);
  await h.owner.command(started.id, reviewed.revision, 'confirmFolders');
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(3));
  const paused = await h.owner.command(started.id, started.revision, 'pause');
  expect(paused.state.pipeline?.status).toBe('paused');
  await idle(h, started.id);
  await expect(h.owner.command(started.id, started.revision, 'resume')).rejects.toThrow('conflict');
  expect(h.run).toHaveBeenCalledTimes(3);
  h.owner.dispose();
});

it('rejects an unconfigured start without exposing a negative revision or retaining an unreadable task', async () => {
  const h = setup();
  delete (h.value as { config?: unknown }).config;
  await expect(h.owner.start(request)).rejects.toThrow('model-unconfigured');
  expect(await h.owner.list()).toEqual([]);
  expect(h.run).not.toHaveBeenCalled();
  h.owner.dispose();
});
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
