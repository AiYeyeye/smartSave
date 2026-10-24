import { expect, it, vi } from 'vitest';
import { OrganizeController, type OrganizeState } from '../panel/organize-controller';
import type { ModelAuthority } from '../adapters/model-authority';
import type { ModelTransport } from '../adapters/model-transport';
import { organizerTree } from './fixtures/organizer-tree';
import { serializeAiPayload } from '../domain/ai-payload';
import { organizeCheckpointSchema, type OrganizeCheckpoint } from '../domain/organize-checkpoint';
import { restoreOrganizeGeneration } from '../domain/organize-generation-checkpoint';
import { parseModelOutput } from '../schemas/model-output';

const empty = () => ({ moves: [], merges: [], newFolders: [] });
function setup({ flat = true, count = 5 } = {}) {
  const tree = organizerTree();
  tree.nodes = tree.nodes.filter(node => !['a', 'b', ...(flat ? ['left', 'right'] : [])].includes(node.ref.nativeId));
  for (const node of tree.nodes)
    node.childrenIds = node.childrenIds.filter(id => tree.nodes.some(n => n.ref.nativeId === id));
  const parent = tree.nodes.find(node => node.ref.nativeId === (flat ? 'bar' : 'left'))!;
  for (let i = 0; i < count; i++) {
    const id = `item-${i}`;
    parent.childrenIds.push(id);
    tree.nodes.push({
      ref: { installationId: 'install', nativeId: id, kind: 'bookmark' },
      parentId: parent.ref.nativeId,
      index: i,
      title: i === count - 1 ? 'JMeter 性能测试' : `SQL 教程 ${i}`,
      url: `https://example.test/${i}?private=1`,
      childrenIds: [],
      readOnly: false,
      observedRevision: 1,
    });
  }
  const context = {
    tree,
    version: 1 as const,
    revision: 'one',
    sessionRevision: 0,
    key: 'key',
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
    config: { adapter: 'openai-compatible' as const, baseUrl: 'https://model.test/v1', model: 'test', timeoutMs: 1000 },
  };
  const authority: ModelAuthority = { read: async () => structuredClone(context), subscribe: () => () => {} };
  const snapshots: OrganizeState[] = [];
  const saved: OrganizeCheckpoint[] = [];
  const send = vi.fn();
  const model = { run: vi.fn<ModelTransport['run']>(), cancel: vi.fn(), dispose: vi.fn() };
  let controller: OrganizeController;
  const create = () =>
    new OrganizeController(state => snapshots.push(structuredClone(state)), authority, model, undefined, send, {
      generationOnly: true,
      persist: async () => {
        const value = await controller.checkpoint('content-task', saved.length);
        if (value) saved.push(value);
      },
    });
  controller = create();
  controller.setTree({ status: 'ready', snapshot: tree });
  controller.selectScope('bar');
  let folderCalls = 0;
  model.run.mockImplementation(async input => {
    if (input.request.task !== 'organize') throw Error('wrong-task');
    const request = input.request;
    if (request.stage === 'analysis')
      return {
        status: 'completed',
        output: {
          ...empty(),
          topics: request.itemIds.map(id => ({
            title: id === `item-${count - 1}` ? '性能测试' : '数据库',
            itemIds: [id],
          })),
        },
      };
    if (request.stage === 'folders') {
      folderCalls++;
      return {
        status: 'completed',
        output: { ...empty(), newFolders: [{ id: `draft-${folderCalls}`, parentId: 'bar', title: '学习' }] },
      };
    }
    return {
      status: 'completed',
      output: { ...empty(), moves: request.itemIds.map(itemId => ({ itemId, folderId: `draft-${folderCalls}` })) },
    };
  });
  return {
    controller,
    context,
    model,
    send,
    saved,
    snapshots,
    state: () => snapshots.at(-1)!,
    restart: () => {
      controller.dispose();
      controller = create();
      return controller;
    },
  };
}

it('reviews completed items during generation, prioritizes subset feedback and fences late AI replies behind newer manual choices', async () => {
  const h = setup({ count: 4 });
  const original = h.model.run.getMockImplementation()!;
  let releaseBatch!: () => void;
  let releaseFeedback!: () => void;
  h.model.run.mockImplementation(async input => {
    if (input.request.task === 'organize' && input.request.stage === 'bookmarks') {
      if (input.request.userFeedback)
        await new Promise<void>(resolve => {
          releaseFeedback = resolve;
        });
      else if (input.request.itemIds.includes('item-2'))
        await new Promise<void>(resolve => {
          releaseBatch = resolve;
        });
    }
    return original(input);
  });
  const generation = h.controller.generate(undefined, { contentFirst: true, batchSize: 2 });
  await vi.waitFor(() => expect(h.state().pipeline?.completed).toBe(2));
  expect(h.state().busy).toBe(true);
  expect(() => h.controller.reviewContent({ kind: 'destination', ids: ['item-2'], targetId: 'bar' })).toThrow();
  expect(() => h.controller.reviewContent({ kind: 'destination', ids: ['item-0'], targetId: 'unknown' })).toThrow();
  expect(h.controller.reviewContent({ kind: 'destination', ids: ['item-0'], targetId: 'bar' })).toMatchObject([
    { source: 'choice', status: 'active' },
  ]);
  h.controller.reviewContent({
    kind: 'feedback',
    ids: ['item-1'],
    text: 'This is a tutorial, keep it in the learning collection.',
  });
  const pending = await h.controller.checkpoint('interactive', 1);
  expect(organizeCheckpointSchema.safeParse(pending).success).toBe(true);
  expect((await restoreOrganizeGeneration(pending, h.context)).state.pipeline?.reviewedIds).toEqual(['item-0']);
  releaseBatch();
  await vi.waitFor(() => expect(releaseFeedback).toBeTypeOf('function'));
  const feedbackCall = h.model.run.mock.calls.at(-1)![0];
  expect(feedbackCall.request).toMatchObject({
    task: 'organize',
    stage: 'bookmarks',
    itemIds: ['item-1'],
    userFeedback: 'This is a tutorial, keep it in the learning collection.',
  });
  h.controller.reviewContent({ kind: 'destination', ids: ['item-1'], targetId: 'bar' });
  releaseFeedback();
  await generation;
  expect(h.state().failure).toBeUndefined();
  expect(h.state().pipeline).toMatchObject({
    completed: 4,
    reviewedIds: ['item-0', 'item-1'],
    reclassifyingIds: [],
    unchangedIds: ['item-0', 'item-1'],
  });
  expect(
    h
      .state()
      .proposal?.actions.filter(action => action.kind === 'move')
      .map(action => action.sourceId),
  ).toEqual(['item-2', 'item-3']);
  expect(h.send).not.toHaveBeenCalled();
  const restored = await restoreOrganizeGeneration(await h.controller.checkpoint('interactive', 2), h.context);
  expect(restored.state.pipeline?.reviewedIds).toEqual(['item-0', 'item-1']);
  expect(restored.state.proposal?.actions).toEqual(h.state().proposal?.actions);
  h.controller.dispose();
});

it('preserves reviewed taxonomy, exposes uncertain items and restores feedback queued after completion', async () => {
  const h = setup({ count: 4 });
  const original = h.model.run.getMockImplementation()!;
  let release!: () => void;
  h.model.run.mockImplementation(async input => {
    if (
      input.request.task === 'organize' &&
      input.request.stage === 'bookmarks' &&
      input.request.itemIds.includes('item-2') &&
      !input.request.userFeedback
    ) {
      await new Promise<void>(resolve => {
        release = resolve;
      });
      return {
        status: 'completed',
        output: {
          ...empty(),
          uncertainIds: ['item-2', 'item-3'],
          categorySuggestions: [{ title: 'Testing', itemIds: ['item-2', 'item-3'] }],
        },
      };
    }
    return original(input);
  });
  const generation = h.controller.generate(undefined, { contentFirst: true, batchSize: 2, cleanupEmpty: true });
  await vi.waitFor(() => expect(h.state().pipeline?.completed).toBe(2));
  h.controller.reviewContent({ kind: 'destination', ids: ['item-0'], targetId: 'draft-1' });
  release();
  await generation;
  expect(
    h.model.run.mock.calls.filter(([input]) => input.request.task === 'organize' && input.request.stage === 'folders'),
  ).toHaveLength(1);
  expect(h.state().pipeline?.uncertainIds).toEqual(['item-2', 'item-3']);
  h.controller.reviewContent({ kind: 'destination', ids: ['item-2'], targetId: 'draft-1' });
  expect(h.state().pipeline?.uncertainIds).toEqual(['item-3']);
  h.controller.reviewContent({ kind: 'feedback', ids: ['item-3'], text: 'Classify this tutorial with learning.' });
  const checkpoint = await h.controller.checkpoint('interactive', 3);
  expect(organizeCheckpointSchema.safeParse(checkpoint).success).toBe(true);
  const calls = h.model.run.mock.calls.length;
  const restored = h.restart();
  await restored.restoreCheckpoint(checkpoint);
  expect(h.model.run).toHaveBeenCalledTimes(calls);
  await restored.resumeBatches();
  expect(h.model.run).toHaveBeenCalledTimes(calls + 1);
  expect(h.model.run.mock.calls.at(-1)![0].request).toMatchObject({ itemIds: ['item-3'] });
  expect(h.state().pipeline).toMatchObject({ stage: 'complete', completed: 4, uncertainIds: [] });
  expect(h.state().failure).toBeUndefined();
  expect(h.send).not.toHaveBeenCalled();
  restored.dispose();
});

it('analyzes every flat-root bookmark including the last topic, then auto-plans and assigns without intermediate confirmation', async () => {
  const h = setup();
  await h.controller.generate(undefined, { contentFirst: true, unfiledOnly: true, batchSize: 2 });
  expect(h.state().failure).toBeUndefined();
  expect(h.state().pipeline).toMatchObject({ stage: 'complete', completed: 5, topicCompleted: 5, lockedActionIds: [] });
  const requests = h.model.run.mock.calls
    .map(([input]) => input.request)
    .filter(request => request.task === 'organize');
  expect(requests.map(request => request.stage)).toEqual([
    'analysis',
    'analysis',
    'analysis',
    'folders',
    'bookmarks',
    'bookmarks',
    'bookmarks',
  ]);
  expect(requests.filter(request => request.stage === 'analysis').flatMap(request => request.itemIds)).toEqual([
    'item-0',
    'item-1',
    'item-2',
    'item-3',
    'item-4',
  ]);
  expect(requests.find(request => request.stage === 'folders')?.topicEvidence).toContainEqual({
    title: '性能测试',
    count: 1,
    reason: undefined,
  });
  const serialized = JSON.parse(serializeAiPayload(h.context.tree, h.context.privacy, requests[0]!));
  expect(serialized.items[0]).toMatchObject({ title: 'SQL 教程 0', url: 'https://example.test/0', path: ['0', 'bar'] });
  expect(h.snapshots.some(state => state.pipeline?.status === 'review' && state.pipeline.stage !== 'complete')).toBe(
    false,
  );
  expect(h.state().proposal?.actions.filter(action => action.kind === 'move')).toHaveLength(5);
  expect(h.send).not.toHaveBeenCalled();
  const restored = await restoreOrganizeGeneration(h.saved.at(-1), h.context);
  expect(restored.state.proposal?.actions).toEqual(h.state().proposal?.actions);
  expect(restored.state.pipeline?.lockedActionIds).toEqual([]);
  h.controller.dispose();
});

it('revises the draft for a late category and invalidates all old assignments; unresolved cases stay explicit after the bounded revision', async () => {
  const h = setup({ count: 4 });
  const original = h.model.run.getMockImplementation()!;
  h.model.run.mockImplementation(async input => {
    if (
      input.request.task === 'organize' &&
      input.request.stage === 'bookmarks' &&
      input.request.itemIds.includes('item-3')
    )
      return {
        status: 'completed',
        output: {
          ...empty(),
          unchangedIds: ['item-2'],
          uncertainIds: ['item-3'],
          categorySuggestions: [{ title: '性能测试', itemIds: ['item-3'] }],
        },
      };
    return original(input);
  });
  await h.controller.generate(undefined, { contentFirst: true, batchSize: 2 });
  expect(h.state().failure).toBeUndefined();
  expect(h.state().pipeline).toMatchObject({
    stage: 'complete',
    completed: 4,
    uncertainIds: ['item-3'],
    unchangedIds: ['item-2'],
  });
  const requests = h.model.run.mock.calls
    .map(([input]) => input.request)
    .filter(request => request.task === 'organize');
  expect(requests.filter(request => request.stage === 'folders')).toHaveLength(2);
  expect(requests.filter(request => request.stage === 'bookmarks').map(request => request.itemIds)).toEqual([
    ['item-0', 'item-1'],
    ['item-2', 'item-3'],
    ['item-0', 'item-1'],
    ['item-2', 'item-3'],
  ]);
  expect(
    h.state().proposal?.actions.some(action => action.sourceId === 'draft-1' || action.targetId === 'draft-1'),
  ).toBe(false);
  expect(h.saved.find(value => value.content?.phase === 'revision')).toMatchObject({
    stage: 'folders',
    batches: [],
    selection: { selected: [], targets: {} },
  });
  const checkpoint = h.saved.at(-1)!;
  expect(checkpoint.batches.every(batch => batch.taxonomyRevision === 1)).toBe(true);
  expect(
    organizeCheckpointSchema.safeParse({
      ...checkpoint,
      batches: checkpoint.batches.map(batch => ({ ...batch, taxonomyRevision: 0 })),
    }).success,
  ).toBe(false);
  expect((await restoreOrganizeGeneration(checkpoint, h.context)).state.pipeline?.uncertainIds).toEqual(['item-3']);
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});

it('retains completed analysis after a failure and restores without automatically contacting the model', async () => {
  const h = setup({ count: 4 });
  const original = h.model.run.getMockImplementation()!;
  h.model.run.mockImplementation(async input => {
    if (
      input.request.task === 'organize' &&
      input.request.stage === 'analysis' &&
      input.request.itemIds.includes('item-2')
    )
      return { status: 'failed', reason: 'network' };
    return original(input);
  });
  await h.controller.generate(undefined, { contentFirst: true, batchSize: 2 });
  expect(h.state()).toMatchObject({ invalid: false, pipeline: { status: 'failed', topicCompleted: 2 } });
  const checkpoint = await h.controller.checkpoint('content-task', 20);
  const calls = h.model.run.mock.calls.length;
  const restored = h.restart();
  await restored.restoreCheckpoint(checkpoint);
  expect(h.model.run).toHaveBeenCalledTimes(calls);
  h.model.run.mockImplementation(original);
  await restored.resumeBatches();
  expect(h.state().pipeline?.stage).toBe('complete');
  const newCalls = h.model.run.mock.calls
    .slice(calls)
    .map(([input]) => input.request)
    .filter(request => request.task === 'organize');
  expect(newCalls.filter(request => request.stage === 'analysis').map(request => request.itemIds)).toEqual([
    ['item-2', 'item-3'],
  ]);
  restored.dispose();
});

it('never treats missing discovery or assignment answers as unchanged', () => {
  const context = {
    task: 'organize',
    contentFirst: true,
    rootId: 'root',
    items: [
      { id: 'a', title: 'a' },
      { id: 'b', title: 'b' },
    ],
    folders: [{ id: 'root' }],
  };
  expect(() =>
    parseModelOutput({ ...empty(), topics: [{ title: 'A', itemIds: ['a'] }] }, { ...context, stage: 'analysis' }),
  ).toThrow('invalid-output');
  expect(() =>
    parseModelOutput(
      { ...empty(), unchangedIds: ['a'] },
      { ...context, stage: 'bookmarks', omittedItemsUnchanged: true },
    ),
  ).toThrow('invalid-output');
  expect(() =>
    parseModelOutput(
      { ...empty(), unchangedIds: ['a', 'b'], categorySuggestions: [{ title: 'New', itemIds: ['b'] }] },
      { ...context, stage: 'bookmarks' },
    ),
  ).toThrow('invalid-output');
  expect(
    parseModelOutput({ ...empty(), unchangedIds: ['a'], uncertainIds: ['b'] }, { ...context, stage: 'bookmarks' }),
  ).toMatchObject({ uncertainIds: ['b'] });
});

it('pauses discovery without accepting a late response and resumes only pending analysis', async () => {
  const h = setup({ count: 3 });
  const original = h.model.run.getMockImplementation()!;
  let finish!: (value: Awaited<ReturnType<ModelTransport['run']>>) => void;
  h.model.run.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const generating = h.controller.generate(undefined, { contentFirst: true, batchSize: 2 });
  await vi.waitFor(() => expect(h.model.run).toHaveBeenCalledOnce());
  h.controller.pauseBatches();
  finish({ status: 'completed', output: { ...empty(), topics: [{ title: 'Stale', itemIds: ['item-0', 'item-1'] }] } });
  await generating;
  expect(h.state().pipeline).toMatchObject({ status: 'paused', topicCompleted: 0 });
  const checkpoint = await h.controller.checkpoint('content-task', 10);
  expect(checkpoint?.content?.analysis.every(batch => !batch.output)).toBe(true);
  h.model.run.mockImplementation(original);
  await h.controller.resumeBatches();
  expect(h.state().pipeline?.stage).toBe('complete');
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});

it('preserves privacy and protected folders across analysis and taxonomy inputs', async () => {
  const h = setup({ flat: false });
  await h.controller.generate(undefined, { contentFirst: true, protectedFolderIds: ['left'] });
  expect(h.state().pipeline).toMatchObject({ stage: 'complete', total: 0 });
  expect(h.model.run).not.toHaveBeenCalled();
  h.controller.dispose();
});

it('restores final cleanup after assignments and permits deselecting a new category with its dependent moves', async () => {
  const h = setup({ flat: false });
  const original = h.model.run.getMockImplementation()!;
  h.model.run.mockImplementation(async input => {
    const response = await original(input);
    if (input.request.task === 'organize' && input.request.stage === 'folders' && response.status === 'completed')
      return {
        ...response,
        output: { ...(response.output as ReturnType<typeof empty>), removeFolders: [{ folderId: 'left' }] },
      };
    return response;
  });
  await h.controller.generate(undefined, { contentFirst: true, cleanupEmpty: true, batchSize: 2 });
  expect(h.state().failure).toBeUndefined();
  const checkpoint = await h.controller.checkpoint('content-task', 10);
  expect((await restoreOrganizeGeneration(checkpoint, h.context)).state.proposal?.actions).toEqual(
    h.state().proposal?.actions,
  );
  h.controller.toggle('create:draft-1', false);
  const edited = await h.controller.checkpoint('content-task', 11);
  expect(edited?.selection.selected.some(id => id.startsWith('move:'))).toBe(false);
  expect((await restoreOrganizeGeneration(edited, h.context)).state.selected).toEqual(h.state().selected);
  h.controller.dispose();
});
