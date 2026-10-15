import { expect, it, vi } from 'vitest';
import { OrganizeController, type OrganizeState } from '../panel/organize-controller';
import { organizerTree } from './fixtures/organizer-tree';
import { serializeAiPayload, type AiPrivacy } from '../domain/ai-payload';
import { parseModelOutput } from '../schemas/model-output';
import { ORGANIZE_REQUEST_BYTES, partitionOrganizeItems } from '../domain/organize-batches';
import { MODEL_BYTE_LIMITS } from '../adapters/model-byte-limits';
import type { ModelResult, ModelTransport } from '../adapters/model-transport';
import { normalizeModelJson } from '../adapters/model-transport';
import { organizeCompilation, organizeProposal } from '../domain/organize-proposal';

const noChanges = { moves: [], newFolders: [], merges: [] };
const partial: ModelResult = {
  status: 'repairable',
  reason: 'partial-invalid-targets',
  repair: { retained: { ...noChanges, moves: [{ itemId: 'a', folderId: 'new', reason: 'preserve' }] }, itemIds: ['b'] },
};
const folderPlan = {
  moves: [],
  newFolders: [{ id: 'new', parentId: 'bar', title: '工具' }],
  merges: [{ sourceId: 'left', targetId: 'right' }],
  renames: [{ folderId: 'right', title: '资料' }],
};
function setup() {
  const tree = organizerTree();
  const context = {
    tree,
    version: 1 as const,
    revision: 'one',
    sessionRevision: 0,
    key: '',
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] } as AiPrivacy,
    config: { adapter: 'openai-responses' as const, baseUrl: 'https://test.example/v1', model: 'm', timeoutMs: 1000 },
  };
  const model = { run: vi.fn<ModelTransport['run']>(), cancel: vi.fn(), dispose: vi.fn() };
  const close = vi.fn();
  const active = vi.fn();
  const send = vi.fn(async (request: { requestId: string }) => ({
    requestId: request.requestId,
    status: 'completed',
    completedSteps: 1,
    remainingSteps: 0,
    needsReconcile: false,
  }));
  let state!: OrganizeState;
  const controller = new OrganizeController(
    s => {
      state = s;
    },
    {
      read: async () => structuredClone(context),
      subscribe: () => () => {},
    },
    model,
    async () => ({ token: 'lease', close, setActive: active }),
    send,
  );
  controller.setTree({ status: 'ready', snapshot: tree });
  controller.selectScope('bar');
  const start = async (batchSize = 1) => {
    model.run.mockResolvedValueOnce({ status: 'completed', output: folderPlan });
    await controller.generate(undefined, { staged: true, batchSize, cleanupEmpty: true });
    expect(state.pipeline?.stage).toBe('folders');
    expect(state.invalid).toBe(false);
  };
  return { controller, context, model, close, active, send, state: () => state, start };
}

it('waits for explicit one-shot repair, sends only pending identities and checkpoints only the fully revalidated batch', async () => {
  const h = setup();
  await h.start(100);
  h.model.run.mockResolvedValueOnce(partial);
  await h.controller.confirmFolders();
  expect(h.state().repair).toEqual({ count: 1, retained: 1 });
  expect(h.state().pipeline).toMatchObject({ status: 'failed', completed: 0 });
  expect(h.state().pipeline?.analyzed ?? 0).toBe(0);
  expect(h.model.run).toHaveBeenCalledTimes(2);
  const checkpoint = (await h.controller.checkpoint('task', 0))!;
  expect(checkpoint.batches).toHaveLength(1);
  expect(checkpoint.batches[0]).toMatchObject({ status: 'pending', itemIds: ['a', 'b'] });
  expect(checkpoint.batches[0]).not.toHaveProperty('output');
  expect(JSON.stringify(checkpoint)).not.toContain('preserve');
  h.model.run.mockResolvedValueOnce({
    status: 'completed',
    output: { ...noChanges, moves: [{ itemId: 'b', folderId: 'right' }] },
  });
  await h.controller.repairBatches();
  expect(h.model.run.mock.calls[2]![0].request).toMatchObject({ itemIds: ['b'], stage: 'bookmarks' });
  expect(h.model.run.mock.calls[2]![0].organizeRepair).toBeUndefined();
  expect(h.state().pipeline).toMatchObject({ stage: 'complete', completed: 2 });
  expect(h.state().proposal?.actions.find(action => action.sourceId === 'a')).toMatchObject({
    targetId: 'new',
    reason: 'preserve',
  });
  expect(h.state().repair).toBeUndefined();
  const final = (await h.controller.checkpoint('task', 1))!;
  expect(final.batches[0]).toMatchObject({
    status: 'merged',
    output: {
      moves: [
        { itemId: 'a', folderId: 'new', reason: 'preserve' },
        { itemId: 'b', folderId: 'right' },
      ],
    },
  });
  await h.controller.repairBatches();
  expect(h.model.run).toHaveBeenCalledTimes(3);
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});

it.each(['invalid', 'foreign', 'network', 'changed', 'cancel'] as const)(
  'a %s repair is not accepted or retried',
  async failure => {
    const h = setup();
    await h.start(100);
    h.model.run.mockResolvedValueOnce(partial);
    await h.controller.confirmFolders();
    if (failure === 'changed') h.context.config.model = 'changed';
    if (failure === 'cancel') {
      h.model.run.mockImplementationOnce(() => new Promise(() => {}));
      const pending = h.controller.repairBatches();
      await vi.waitFor(() => expect(h.model.run).toHaveBeenCalledTimes(3));
      h.controller.pauseBatches();
      await pending;
    } else {
      h.model.run.mockResolvedValueOnce(
        failure === 'network'
          ? { status: 'failed', reason: 'network-error' }
          : {
              status: 'completed',
              output: {
                ...noChanges,
                moves: [{ itemId: failure === 'foreign' ? 'a' : 'b', folderId: 'invalid-again' }],
              },
            },
      );
      await h.controller.repairBatches();
    }
    const count = failure === 'changed' ? 2 : 3;
    expect(h.model.run).toHaveBeenCalledTimes(count);
    expect(h.state().pipeline?.completed).toBe(0);
    expect(h.state().repair).toBeUndefined();
    await h.controller.repairBatches();
    expect(h.model.run).toHaveBeenCalledTimes(count);
    expect(h.send).not.toHaveBeenCalled();
    h.controller.dispose();
  },
);

it('keeps an already validated out-of-order batch while repairing only the failed earlier batch', async () => {
  const h = setup();
  Object.assign(h.model, { fork: () => ({ run: h.model.run, cancel: vi.fn(), dispose: vi.fn() }) });
  await h.start(1);
  const complete = new Map<string, (result: ModelResult) => void>();
  h.model.run.mockImplementation(
    input =>
      new Promise(resolve => {
        if ('itemIds' in input.request) complete.set(input.request.itemIds[0]!, resolve);
      }),
  );
  const pending = h.controller.confirmFolders();
  await vi.waitFor(() => expect(complete.size).toBe(2));
  complete.get('b')!({ status: 'completed', output: { ...noChanges, moves: [{ itemId: 'b', folderId: 'new' }] } });
  await vi.waitFor(() => expect(h.state().pipeline?.analyzed).toBe(1));
  complete.get('a')!({
    status: 'repairable',
    reason: 'partial-invalid-targets',
    repair: { retained: noChanges, itemIds: ['a'] },
  });
  await pending;
  expect(h.state().repair).toEqual({ count: 1, retained: 0 });
  expect((await h.controller.checkpoint('task', 0))!.batches.map(batch => batch.status)).toEqual([
    'pending',
    'accepted',
  ]);
  const before = h.model.run.mock.calls.length;
  h.model.run.mockResolvedValue({
    status: 'completed',
    output: { ...noChanges, moves: [{ itemId: 'a', folderId: 'right' }] },
  });
  await h.controller.repairBatches();
  expect(
    h.model.run.mock.calls.slice(before).map(([input]) => 'itemIds' in input.request && input.request.itemIds),
  ).toEqual([['a']]);
  expect(h.state().pipeline).toMatchObject({ stage: 'complete', completed: 2 });
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});

it('prefetches independent batches, retains an out-of-order completed batch on pause and merges in order on resume', async () => {
  const h = setup();
  const dispose = vi.fn();
  Object.assign(h.model, { fork: () => ({ run: h.model.run, cancel: vi.fn(), dispose }) });
  await h.start(1);
  const completions = new Map<string, (result: ModelResult) => void>();
  h.model.run.mockImplementation(
    input =>
      new Promise(resolve => {
        completions.set('itemIds' in input.request ? input.request.itemIds[0]! : '', resolve);
      }),
  );
  const pending = h.controller.confirmFolders();
  await vi.waitFor(() => expect([...completions.keys()]).toEqual(['a', 'b']));
  completions.get('b')!({ status: 'completed', output: { ...noChanges, moves: [{ itemId: 'b', folderId: 'new' }] } });
  await vi.waitFor(() => expect(h.state().pipeline?.analyzed).toBe(1));
  expect(h.state().pipeline?.completed).toBe(0);
  expect(h.state().proposal?.actions.some(action => action.id === 'move:b')).toBe(false);
  h.controller.pauseBatches();
  await pending;
  expect(h.state().pipeline?.status).toBe('paused');
  expect(h.send).not.toHaveBeenCalled();
  const callsBeforeResume = h.model.run.mock.calls.length;
  h.model.run.mockResolvedValue({
    status: 'completed',
    output: { ...noChanges, moves: [{ itemId: 'a', folderId: 'new' }] },
  });
  await h.controller.resumeBatches();
  expect(
    h.model.run.mock.calls
      .slice(callsBeforeResume)
      .map(([input]) => ('itemIds' in input.request ? input.request.itemIds : [])),
  ).toEqual([['a']]);
  expect(h.state().pipeline).toMatchObject({ stage: 'complete', completed: 2 });
  expect(
    h
      .state()
      .proposal?.actions.filter(action => action.kind === 'move')
      .map(action => action.sourceId),
  ).toEqual(['a', 'b']);
  completions.get('a')!({
    status: 'completed',
    output: { ...noChanges, moves: [{ itemId: 'a', folderId: 'missing' }] },
  });
  await Promise.resolve();
  expect(h.state().pipeline?.stage).toBe('complete');
  expect(h.send).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledTimes(3);
  h.controller.dispose();
});

it('reduces further dispatch to one request after 429 without cancelling already valid parallel work', async () => {
  const h = setup();
  const a = h.context.tree.nodes.find(node => node.ref.nativeId === 'a')!;
  h.context.tree.nodes.push({ ...a, ref: { ...a.ref, nativeId: 'd' } });
  h.context.tree.nodes.find(node => node.ref.nativeId === 'left')!.childrenIds.push('d');
  h.controller.setTree({ status: 'ready', snapshot: h.context.tree });
  Object.assign(h.model, { fork: () => ({ run: h.model.run, cancel: vi.fn(), dispose: vi.fn() }) });
  await h.start(1);
  const completions = new Map<string, (result: ModelResult) => void>();
  h.model.run.mockImplementation(input => {
    const id = 'itemIds' in input.request ? input.request.itemIds[0]! : '';
    if (id === 'a')
      input.onProgress?.({
        phase: 'waiting',
        streaming: true,
        text: '',
        receivedChars: 0,
        retry: { httpStatus: 429, attempt: 1, delaySeconds: 2 },
      });
    return new Promise(resolve => {
      completions.set(id, resolve);
    });
  });
  const pending = h.controller.confirmFolders();
  await vi.waitFor(() => expect([...completions.keys()]).toEqual(['a', 'b']));
  expect(h.state().pipeline?.concurrency).toBe(1);
  completions.get('a')!({ status: 'completed', output: noChanges });
  await vi.waitFor(() => expect(h.state().pipeline?.completed).toBe(1));
  expect(completions.has('d')).toBe(false);
  completions.get('b')!({ status: 'completed', output: noChanges });
  await vi.waitFor(() => expect(completions.has('d')).toBe(true));
  completions.get('d')!({ status: 'completed', output: noChanges });
  await pending;
  expect(h.state().pipeline).toMatchObject({ stage: 'complete', completed: 3, concurrency: 1 });
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});

it('retains folder review, failed batches and final confirmation across long waits without rerunning accepted work', async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    await h.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.state().invalid).toBe(false);
    h.model.run.mockResolvedValueOnce({ status: 'completed', output: { ...noChanges, unchangedIds: ['a'] } });
    h.model.run.mockResolvedValueOnce({ status: 'failed', reason: 'http-429' });
    await h.controller.confirmFolders();
    expect(h.state().pipeline).toMatchObject({ status: 'failed', completed: 1 });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.state().invalid).toBe(false);
    h.model.run.mockResolvedValueOnce({ status: 'completed', output: { ...noChanges, unchangedIds: ['b'] } });
    await h.controller.resumeBatches();
    expect(h.state().pipeline).toMatchObject({ stage: 'complete', completed: 2 });
    expect(h.model.run.mock.calls.slice(1).map(([call]) => call.request)).toEqual([
      expect.objectContaining({ itemIds: ['a'] }),
      expect.objectContaining({ itemIds: ['b'] }),
      expect.objectContaining({ itemIds: ['b'] }),
    ]);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.state().invalid).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
    await h.controller.apply();
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.model.run).toHaveBeenCalledTimes(4);
  } finally {
    h.controller.dispose();
    vi.useRealTimers();
  }
});

it('bounds batches by count and complete request bytes; never silently drops an oversized item', () => {
  const ids = Array.from({ length: 101 }, (_, i) => String(i));
  expect(partitionOrganizeItems(ids, () => 10)).toEqual([ids.slice(0, 100), ids.slice(100)]);
  expect(partitionOrganizeItems(ids, () => 10, 200)).toEqual([ids]);
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => partitionOrganizeItems(ids, () => 10, invalid)).toThrow('invalid-batch-size');
  }
  expect(partitionOrganizeItems(['a', 'b', 'c', 'd', 'e'], ids => 100 + ids.length * 20_000, 3)).toEqual([
    ['a', 'b'],
    ['c', 'd'],
    ['e'],
  ]);
  expect(partitionOrganizeItems(['a', 'b', 'c'], () => 10, 2)).toEqual([['a', 'b'], ['c']]);
  expect(() => partitionOrganizeItems(['a'], () => ORGANIZE_REQUEST_BYTES + 1)).toThrow('folder-context-too-large');
  expect(() => partitionOrganizeItems(['a'], ids => (ids.length ? ORGANIZE_REQUEST_BYTES + 1 : 10))).toThrow(
    'bookmark-context-too-large',
  );
});
it('isolates a bookmark above the preferred batch size without truncation or premature writes', async () => {
  const h = setup();
  const url = `https://test.example/${'x'.repeat(60_000)}`;
  h.context.tree.nodes.find(n => n.ref.nativeId === 'a')!.url = url;
  h.controller.setTree({ status: 'ready', snapshot: h.context.tree });
  await h.start(100);
  h.model.run.mockImplementation(async ({ request }) => ({
    status: 'completed',
    output: { ...noChanges, unchangedIds: 'itemIds' in request ? request.itemIds : [] },
  }));
  await h.controller.confirmFolders();
  expect(h.state().failure).toBeUndefined();
  expect(h.state().pipeline).toMatchObject({ stage: 'complete', completed: 2 });
  expect(h.model.run.mock.calls.slice(1).map(([input]) => input.request)).toEqual([
    expect.objectContaining({ itemIds: ['a'] }),
    expect.objectContaining({ itemIds: ['b'] }),
  ]);
  const payload = JSON.parse(
    serializeAiPayload(h.context.tree, h.context.privacy, h.model.run.mock.calls[1]![0].request),
  );
  expect(payload.items[0].url).toBe(url);
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});
it('allows shared folder context above the preferred batch size within the actual transport limit', async () => {
  const h = setup();
  h.context.tree.nodes.find(n => n.ref.nativeId === 'left')!.title = '分类'.repeat(10_000);
  h.controller.setTree({ status: 'ready', snapshot: h.context.tree });
  h.model.run.mockResolvedValueOnce({ status: 'completed', output: noChanges });
  await h.controller.generate(undefined, { staged: true });
  expect(h.state().pipeline?.stage).toBe('folders');
  h.model.run.mockImplementation(async ({ request }) => ({
    status: 'completed',
    output: { ...noChanges, unchangedIds: 'itemIds' in request ? request.itemIds : [] },
  }));
  await h.controller.confirmFolders();
  expect(h.state().failure).toBeUndefined();
  expect(h.state().pipeline).toMatchObject({ stage: 'complete', completed: 2 });
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});
it('measures the actual request before fetching a bookmark above the transport limit', async () => {
  const h = setup();
  h.context.tree.nodes.find(n => n.ref.nativeId === 'a')!.url =
    `https://test.example/${'x'.repeat(MODEL_BYTE_LIMITS.requestBytes)}`;
  h.controller.setTree({ status: 'ready', snapshot: h.context.tree });
  await h.start();
  await h.controller.confirmFolders();
  expect(h.state().failure?.code).toBe('bookmark-context-too-large');
  expect(h.state().failure?.phase).toBe('书签请求准备');
  expect(h.model.run).toHaveBeenCalledOnce();
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});

it.each([false, true])(
  'keeps 179 items and preserves default batches across an explicit resume on interruption=%s',
  async interrupted => {
    const h = setup();
    const source = h.context.tree.nodes.find(n => n.ref.nativeId === 'a')!;
    const parent = h.context.tree.nodes.find(n => n.ref.nativeId === source.parentId)!;
    for (let i = 0; i < 177; i++) {
      const nativeId = `extra-${i}`;
      h.context.tree.nodes.push({
        ...structuredClone(source),
        ref: { ...source.ref, nativeId },
        title: nativeId,
        index: i + 2,
      });
      parent.childrenIds = [...(parent.childrenIds ?? []), nativeId];
    }
    h.controller.setTree({ status: 'ready', snapshot: h.context.tree });
    h.model.run.mockResolvedValueOnce({ status: 'completed', output: noChanges });
    await h.controller.generate(undefined, { staged: true });
    expect(h.state().pipeline).toMatchObject({ stage: 'folders', total: 179, batchSize: 100 });
    const folderRequest = h.model.run.mock.calls[0]![0].request;
    const payload = JSON.parse(serializeAiPayload(h.context.tree, h.context.privacy, folderRequest));
    expect(payload.items.every((item: { url?: string }) => item.url === undefined)).toBe(true);
    h.model.run.mockImplementation(async ({ request }) => ({
      status: 'completed',
      output: { ...noChanges, unchangedIds: 'itemIds' in request ? request.itemIds : [] },
    }));
    if (interrupted) h.model.run.mockResolvedValueOnce({ status: 'failed', reason: 'network-error' });
    await h.controller.confirmFolders();
    if (interrupted) {
      expect(h.model.run).toHaveBeenCalledTimes(2);
      expect(h.state().pipeline?.status).toBe('failed');
      await h.controller.resumeBatches();
    }
    expect(
      h.model.run.mock.calls.slice(1).map(([input]) => ('itemIds' in input.request ? input.request.itemIds.length : 0)),
    ).toEqual(interrupted ? [100, 100, 79] : [100, 79]);
    expect(h.state().pipeline).toMatchObject({ completed: 179, stage: 'complete' });
    expect(h.send).not.toHaveBeenCalled();
    h.controller.dispose();
  },
);
it('does not permit new folder aliases to collide with a native identity beyond the selected scope', () => {
  const h = setup();
  expect(() =>
    organizeProposal(
      h.context.tree,
      'bar',
      { ...noChanges, newFolders: [{ id: 'outside', parentId: 'bar', title: 'new' }] },
      h.context.privacy,
    ),
  ).toThrow('invalid-output');
  h.controller.dispose();
});
it('preserves existing untitled folders in the approved destination projection', () => {
  const h = setup();
  h.context.tree.nodes.find(n => n.ref.nativeId === 'left')!.title = '';
  const payload = JSON.parse(
    serializeAiPayload(h.context.tree, h.context.privacy, {
      task: 'organize',
      stage: 'bookmarks',
      rootId: 'bar',
      itemIds: ['a'],
      folderIds: ['bar', 'left', 'right'],
      destinations: [
        { id: 'bar', title: 'bar' },
        { id: 'left', parentId: 'bar', title: '' },
      ],
      placements: { a: 'left' },
    }),
  );
  expect(payload.items[0].currentFolderId).toBe('left');
  expect(payload.folders).toContainEqual(expect.objectContaining({ id: 'left', path: ['bar', ''] }));
  h.controller.dispose();
});
it('sends folder-only samples first, then publishes complete batches before later responses and resumes only failures', async () => {
  const h = setup();
  await h.start();
  expect(h.model.run.mock.calls).toHaveLength(1);
  const folderRequest = h.model.run.mock.calls[0]![0].request;
  expect(folderRequest).toMatchObject({ stage: 'folders', itemIds: ['left', 'right'] });
  const payload = JSON.parse(serializeAiPayload(h.context.tree, h.context.privacy, folderRequest));
  expect(payload.items.some((i: { id: string }) => i.id === 'a')).toBe(false);
  expect(payload.folderSummaries.find((s: { folderId: string }) => s.folderId === 'left')).toMatchObject({
    bookmarkCount: 2,
    sampleTitles: ['a', 'b'],
  });
  expect(JSON.stringify(payload)).not.toContain('https://');
  await h.controller.apply();
  expect(h.send).not.toHaveBeenCalled();
  let finish!: (r: ModelResult) => void;
  h.model.run.mockResolvedValueOnce({
    status: 'completed',
    output: { ...noChanges, moves: [{ itemId: 'a', folderId: 'new', reason: '工具' }] },
  });
  h.model.run.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const pending = h.controller.confirmFolders();
  await vi.waitFor(() => expect(h.model.run).toHaveBeenCalledTimes(3));
  expect(h.state().pipeline).toMatchObject({ stage: 'bookmarks', status: 'running', completed: 1 });
  expect(h.state().proposal?.actions.some(a => a.id === 'move:a')).toBe(true);
  expect(h.state().busy).toBe(true);
  await h.controller.apply();
  expect(h.send).not.toHaveBeenCalled();
  const request = h.model.run.mock.calls[1]![0].request;
  const batch = JSON.parse(serializeAiPayload(h.context.tree, h.context.privacy, request));
  expect(batch.items).toEqual([expect.objectContaining({ id: 'a', currentFolderId: 'right', url: 'https://x.test/' })]);
  expect(batch.folders).toContainEqual(expect.objectContaining({ id: 'new', path: ['bar', '工具'] }));
  expect(batch.folders.some((f: { id: string }) => f.id === 'left')).toBe(false);
  finish({ status: 'failed', reason: 'http-429' });
  await pending;
  expect(h.state().pipeline).toMatchObject({ status: 'failed', completed: 1 });
  expect(h.state().failure?.code).toBe('http-429');
  expect(h.send).not.toHaveBeenCalled();
  expect(h.state().invalid).toBe(false);
  h.model.run.mockResolvedValueOnce({ status: 'completed', output: { ...noChanges, unchangedIds: ['b'] } });
  await h.controller.resumeBatches();
  expect(h.model.run.mock.calls[3]![0].request).toMatchObject({ stage: 'bookmarks', itemIds: ['b'] });
  expect(h.state().pipeline).toMatchObject({ stage: 'complete', completed: 2 });
  const state = h.state();
  const after = organizeCompilation(state.proposal!, state.selected, state.targets, 'test').plan.simulated;
  expect(after.nodes.find(n => n.ref.nativeId === 'b')?.parentId).toBe('right');
  expect(after.nodes.find(n => n.ref.nativeId === 'a')?.parentId).toBe('$batch:create:new:$created');
  h.controller.toggle('merge:left', false);
  expect(h.state().selected).toContain('merge:left');
  await h.controller.apply();
  expect(h.send).toHaveBeenCalledOnce();
  h.controller.dispose();
});
it('splits a truncated batch, without accepting partial output or rerunning accepted batches', async () => {
  const h = setup();
  await h.start(30);
  h.model.run.mockResolvedValueOnce({ status: 'failed', reason: 'incomplete', detail: 'output-limit' });
  h.model.run.mockResolvedValueOnce({ status: 'completed', output: { ...noChanges, unchangedIds: ['a'] } });
  h.model.run.mockResolvedValueOnce({ status: 'completed', output: { ...noChanges, unchangedIds: ['b'] } });
  await h.controller.confirmFolders();
  expect(h.model.run.mock.calls.slice(1).map(c => c[0].request)).toEqual([
    expect.objectContaining({ itemIds: ['a', 'b'] }),
    expect.objectContaining({ itemIds: ['a'] }),
    expect.objectContaining({ itemIds: ['b'] }),
  ]);
  expect(h.state().pipeline).toMatchObject({ stage: 'complete', completed: 2, batchCount: 2 });
  h.controller.dispose();
});
it('retains completed batches after a network failure without timers, automatic replay or resizing', async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    await h.start(1);
    h.model.run.mockResolvedValueOnce({ status: 'completed', output: { ...noChanges, unchangedIds: ['a'] } });
    h.model.run.mockResolvedValueOnce({ status: 'failed', reason: 'network-error' });
    await h.controller.confirmFolders();
    expect(h.state().pipeline).toMatchObject({ status: 'failed', completed: 1 });
    expect(h.state().failure?.code).toBe('network-error');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.model.run).toHaveBeenCalledTimes(3);
    expect(h.send).not.toHaveBeenCalled();
    h.model.run.mockResolvedValueOnce({ status: 'completed', output: { ...noChanges, unchangedIds: ['b'] } });
    await h.controller.resumeBatches();
    expect(h.model.run.mock.calls[3]![0].request).toMatchObject({ itemIds: ['b'] });
    expect(h.state().pipeline).toMatchObject({ stage: 'complete', completed: 2 });
  } finally {
    h.controller.dispose();
    vi.useRealTimers();
  }
});
it('pauses immediately, fences late replies and invalidates retained batches if the baseline changed before resume', async () => {
  const h = setup();
  await h.start();
  let late!: (r: ModelResult) => void;
  h.model.run.mockResolvedValueOnce({ status: 'completed', output: { ...noChanges, unchangedIds: ['a'] } });
  h.model.run.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        late = resolve;
      }),
  );
  const pending = h.controller.confirmFolders();
  await vi.waitFor(() => expect(h.model.run).toHaveBeenCalledTimes(3));
  h.controller.pauseBatches();
  await pending;
  expect(h.state().pipeline).toMatchObject({ status: 'paused', completed: 1 });
  late({ status: 'completed', output: { ...noChanges, unchangedIds: ['b'] } });
  await Promise.resolve();
  expect(h.state().pipeline?.completed).toBe(1);
  h.context.tree.nodes.find(n => n.ref.nativeId === 'b')!.title = 'changed';
  await h.controller.resumeBatches();
  expect(h.state().invalid).toBe(true);
  expect(h.state().pipeline?.status).toBe('invalid');
  expect(h.model.run).toHaveBeenCalledTimes(3);
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});
it('requires complete per-item accounting and fixed taxonomy in bookmark responses', () => {
  const context = {
    task: 'organize',
    stage: 'bookmarks' as const,
    items: [
      { id: '1', title: 'a' },
      { id: '2', title: 'b' },
    ],
    folders: [{ id: 'f' }],
  };
  expect(() => parseModelOutput({ ...noChanges, unchangedIds: ['1'] }, context)).toThrow('invalid-output');
  expect(() =>
    parseModelOutput({ ...noChanges, moves: [{ itemId: '1', folderId: 'f' }], unchangedIds: ['1', '2'] }, context),
  ).toThrow();
  expect(() =>
    parseModelOutput({ ...noChanges, unchangedIds: ['1', '2'], renames: [{ folderId: 'f', title: 'new' }] }, context),
  ).toThrow();
  expect(
    parseModelOutput(normalizeModelJson({ ...noChanges, unchangedIds: [1, 2] }, 'organize'), context),
  ).toMatchObject({ unchangedIds: ['1', '2'] });
});
it('excludes protected folders from samples and projected targets and clears batches when changing the folder plan', async () => {
  const h = setup();
  h.model.run.mockResolvedValueOnce({ status: 'completed', output: noChanges });
  await h.controller.generate(undefined, { staged: true, protectedFolderIds: ['left'] });
  const payload = JSON.parse(
    serializeAiPayload(h.context.tree, h.context.privacy, h.model.run.mock.calls[0]![0].request),
  );
  expect(payload.folderSummaries).not.toContainEqual(expect.objectContaining({ folderId: 'left' }));
  expect(h.state().pipeline?.total).toBe(0);
  await h.controller.confirmFolders();
  expect(h.model.run).toHaveBeenCalledOnce();
  expect(h.state().pipeline?.stage).toBe('complete');
  h.controller.returnToFolders();
  expect(h.state().pipeline).toMatchObject({ stage: 'folders', completed: 0, finished: [], lockedActionIds: [] });
  h.controller.dispose();
});
