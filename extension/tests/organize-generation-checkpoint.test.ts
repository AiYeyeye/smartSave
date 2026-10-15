import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { OrganizeController, type OrganizeState } from '../panel/organize-controller';
import { OrganizeCheckpointStore } from '../persistence/organize-checkpoints';
import type { ModelResult, ModelTransport } from '../adapters/model-transport';
import { organizerTree } from './fixtures/organizer-tree';

const folderOutput = { newFolders: [{ id: 'new', parentId: 'bar', title: '工具' }], moves: [], merges: [] };
function context() {
  return {
    tree: organizerTree(),
    version: 1 as const,
    revision: 'settings-one',
    sessionRevision: 0,
    key: 'test-secret-never-persist',
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
    config: { adapter: 'openai-responses' as const, baseUrl: 'https://test.example/v1', model: 'm', timeoutMs: 1000 },
  };
}
function setup(current = context(), persist?: () => Promise<void>) {
  let state!: OrganizeState;
  const run = vi.fn<ModelTransport['run']>();
  const model = { run, cancel: vi.fn(), dispose: vi.fn(), fork: () => ({ run, cancel: vi.fn(), dispose: vi.fn() }) };
  const open = vi.fn(async () => {
    throw Error('generation-must-never-open-write-lease');
  });
  const send = vi.fn(async () => {
    throw Error('generation-must-never-write');
  });
  const controller = new OrganizeController(
    value => {
      state = value;
    },
    { read: async () => structuredClone(current), subscribe: () => () => {} },
    model,
    open,
    send,
    { generationOnly: true, persist },
  );
  controller.setTree({ status: 'ready', snapshot: current.tree });
  return { controller, current, run, open, send, state: () => state };
}

it('restores stable out-of-order results with fresh observations, without a lease/key in storage or automatic model call', async () => {
  const h = setup();
  h.run.mockResolvedValueOnce({ status: 'completed', output: folderOutput });
  await h.controller.generate(undefined, { staged: true, batchSize: 1, cleanupEmpty: false });
  const finish = new Map<string, (result: ModelResult) => void>();
  h.run.mockImplementation(
    input =>
      new Promise(resolve => {
        if ('itemIds' in input.request) finish.set(input.request.itemIds[0]!, resolve);
      }),
  );
  const pending = h.controller.confirmFolders();
  await vi.waitFor(() => expect(finish.size).toBe(2));
  finish.get('b')!({
    status: 'completed',
    output: { ...folderOutput, newFolders: [], moves: [{ itemId: 'b', folderId: 'new' }] },
  });
  await vi.waitFor(() => expect(h.state().pipeline?.analyzed).toBe(1));
  const saved = await h.controller.checkpoint('task', 0);
  expect(saved?.batches.map(batch => batch.status)).toEqual(['pending', 'accepted']);
  const wire = JSON.stringify(saved);
  expect(wire).not.toContain(h.current.key);
  for (const field of ['organizerContext', 'previewId', 'requestId', 'maxOutputTokens'])
    expect(wire).not.toContain(field);
  const store = new OrganizeCheckpointStore(new IDBFactory());
  await store.put(JSON.parse(wire), null);
  h.controller.dispose();
  await pending;
  const nextContext = context();
  nextContext.tree.epoch = 'new-worker-epoch';
  nextContext.tree.observedRevision = 42;
  nextContext.tree.nodes.forEach(node => {
    node.observedRevision = 42;
  });
  nextContext.tree.nodes.find(node => node.ref.nativeId === 'c')!.title = 'changed outside scope';
  const next = setup(nextContext);
  await next.controller.restoreCheckpoint(await store.get('task'));
  expect(next.state().pipeline).toMatchObject({ status: 'paused', completed: 0, analyzed: 1 });
  expect(next.state().proposal?.tree.epoch).toBe('new-worker-epoch');
  expect(next.run).not.toHaveBeenCalled();
  next.run.mockResolvedValue({
    status: 'completed',
    output: { newFolders: [], merges: [], moves: [{ itemId: 'a', folderId: 'new' }] },
  });
  await next.controller.resumeBatches();
  expect(next.run).toHaveBeenCalledTimes(1);
  expect(next.run.mock.calls[0]![0].request).toMatchObject({ itemIds: ['a'] });
  expect(next.state().pipeline).toMatchObject({ stage: 'complete', completed: 2 });
  const completed = await next.controller.checkpoint('task', 1);
  expect(completed!.batches.map(batch => batch.id)).toEqual(saved!.batches.map(batch => batch.id));
  await store.put(completed!, 0);
  await next.controller.apply();
  expect(next.open).not.toHaveBeenCalled();
  expect(next.send).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
  next.controller.dispose();
});

it('refuses missing credentials, changed scope/settings and corrupted cached model actions without requesting or writing', async () => {
  const h = setup();
  h.run.mockResolvedValue({ status: 'completed', output: folderOutput });
  await h.controller.generate(undefined, { staged: true, cleanupEmpty: false });
  const saved = await h.controller.checkpoint('task', 0);
  h.controller.dispose();
  for (const change of ['key', 'scope', 'privacy', 'route', 'revision'] as const) {
    const current = context();
    if (change === 'key') current.key = '';
    if (change === 'scope') current.tree.nodes.find(node => node.ref.nativeId === 'a')!.title = 'changed';
    if (change === 'privacy') current.privacy.fullUrl = true;
    if (change === 'route') current.config.model = 'different';
    if (change === 'revision') current.revision = 'new';
    const next = setup(current);
    await expect(next.controller.restoreCheckpoint(saved)).rejects.toThrow(
      change === 'key' ? 'credential-required' : 'stale-context',
    );
    expect(next.state().invalid).toBe(true);
    expect(next.run).not.toHaveBeenCalled();
    expect(next.open).not.toHaveBeenCalled();
    expect(next.send).not.toHaveBeenCalled();
    next.controller.dispose();
  }
  const next = setup();
  await expect(
    next.controller.restoreCheckpoint({
      ...saved,
      folderPlan: { ...saved!.folderPlan, output: { ...folderOutput, moves: [{ itemId: 'a', folderId: 'new' }] } },
    }),
  ).rejects.toThrow('invalid-output');
  expect(next.run).not.toHaveBeenCalled();
  next.controller.dispose();
});

it('stops before model calls when the initial checkpoint cannot be stored', async () => {
  const h = setup(context(), async () => {
    throw Error('quota');
  });
  await h.controller.generate(undefined, { staged: true });
  expect(h.state().failure?.code).toBe('checkpoint-unavailable');
  expect(h.state().invalid).toBe(true);
  expect(h.run).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
  h.controller.dispose();
});
