import { expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { OrganizeTaskAuthority } from '../background/organize-task-authority';
import { OrganizerAuthority } from '../background/organizer-authority';
import { MutationCoordinator } from '../background/mutation-coordinator';
import { OrganizeTaskOwner } from '../background/organize-task-owner';
import { ImportPersistenceStore } from '../persistence/import-persistence';
import { OrganizeMemoryStore } from '../persistence/organize-memory';
import { organizeCheckpointContext, type OrganizeCheckpoint } from '../domain/organize-checkpoint';
import { organizeRejectionKey } from '../domain/organize-review';
import { restoreOrganizeGeneration } from '../domain/organize-generation-checkpoint';
import { expectedAfter } from '../domain/mutation-effect';
import { preflight } from '../domain/preflight';
import { operationRecord } from '../persistence/operations';
import type { BookmarkWriter } from '../adapters/bookmarks-write';
import type { TreeState } from '../domain/node-reference';
import { organizerTree } from './fixtures/organizer-tree';

const sender = { id: 'test', url: 'chrome-extension://test/options/index.html' };
async function setup() {
  const tree = organizerTree();
  const value = {
    version: 1 as const,
    revision: 'one',
    sessionRevision: 0,
    key: '',
    config: { adapter: 'openai-responses' as const, baseUrl: 'https://model.test/v1', model: 'm', timeoutMs: 1000 },
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] as (typeof tree.nodes)[number]['ref'][] },
  };
  const listeners = new Set<() => void>();
  const settings = {
    snapshot: async () => structuredClone(value),
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
  const projection = {
    state: { status: 'ready', snapshot: tree } as TreeState,
    fresh: vi.fn(async () => structuredClone(tree)),
    subscribe: () => () => {},
  };
  const journal = new ImportPersistenceStore(new IDBFactory());
  const checkpoint: OrganizeCheckpoint = {
    schemaVersion: 1,
    id: 'task',
    revision: 0,
    updatedAt: 1000,
    installationId: tree.installationId,
    root: tree.nodes.find(n => n.ref.nativeId === 'bar')!.ref,
    baseline: structuredClone(tree),
    ...(await organizeCheckpointContext({ ...value, tree }, 'bar', ['a', 'b'])),
    requiresCredential: true,
    preference: { style: 'topic', instructions: '' },
    options: { batchSize: 100, cleanupEmpty: false },
    stage: 'complete',
    status: 'review',
    bookmarkIds: ['a', 'b'],
    folderPlan: { output: { newFolders: [], merges: [], moves: [] }, selected: [], targets: {} },
    batches: [
      {
        id: 'batch',
        itemIds: ['a', 'b'],
        status: 'merged',
        output: {
          newFolders: [],
          merges: [],
          moves: [{ itemId: 'a', folderId: 'right' }],
          unchangedIds: ['b'],
        },
      },
    ],
    selection: { selected: ['move:a'], targets: {} },
    elapsedMs: 1000,
  };
  await journal.organizeCheckpoints.put(checkpoint, null);
  const organizer = new OrganizerAuthority(settings, 'test');
  const memory = new OrganizeMemoryStore();
  const owner = new OrganizeTaskOwner({
    projection,
    settings,
    store: journal.organizeCheckpoints,
    lifetime: { acquire: () => () => {}, dispose: () => {} },
  });
  const authority = new OrganizeTaskAuthority(
    settings,
    projection,
    journal.organizeCheckpoints,
    organizer,
    'test',
    memory,
    cp => owner.submitted(cp),
  );
  const write = vi.fn<BookmarkWriter['move']>(async (id, input) => {
    const node = tree.nodes.find(n => n.ref.nativeId === id)!;
    const returned = {
      id,
      title: node.title,
      url: node.url,
      parentId: input.parentId,
      index: input.index,
      syncing: false,
    };
    tree.nodes = expectedAfter(tree, { type: 'move', id, parentId: input.parentId!, index: input.index! }, returned);
    tree.observedRevision++;
    return returned;
  });
  const writer = { move: write, create: vi.fn(), update: vi.fn(), remove: vi.fn() } as BookmarkWriter;
  const coordinator = new MutationCoordinator(
    projection,
    writer,
    journal,
    'test',
    undefined,
    organizer,
    undefined,
    authority,
  );
  const token = await organizer.open(sender);
  const preview = () => coordinator.registerOrganizeTaskPreview(token, 'task', 0, sender);
  const dispose = () => owner.dispose();
  return {
    tree,
    value,
    listeners,
    settings,
    projection,
    journal,
    checkpoint,
    organizer,
    memory,
    authority,
    owner,
    write,
    writer,
    coordinator,
    token,
    preview,
    dispose,
  };
}

it('atomically associates one task with its journal, strips live authority and observes the same outcome after restart', async () => {
  const h = await setup();
  const request = (await h.preview())!;
  expect(request.organizerBinding).toMatchObject({ checkpointId: 'task', checkpointRevision: 0 });
  expect((await h.coordinator.submit(request, sender)).status).toBe('completed');
  expect(h.write).toHaveBeenCalledTimes(1);
  const saved = (await h.journal.organizeCheckpoints.get('task'))!;
  expect(saved.submission?.requestId).toBe(request.requestId);
  const record = (await h.journal.get(request.requestId))!;
  expect(record.request.organizerBinding).toEqual(request.organizerBinding);
  expect(JSON.stringify(record.request)).not.toContain('organizerContext');
  expect(JSON.stringify(record.request)).not.toContain('previewId');
  expect(await h.owner.get('task')).toMatchObject({
    submission: { requestId: request.requestId },
    needsCredential: false,
  });
  h.organizer.close(h.token);
  const restarted = new MutationCoordinator(h.projection, h.writer, h.journal, 'test');
  expect((await restarted.submit(request, sender)).status).toBe('completed');
  expect(
    (await restarted.submit({ version: 1, type: 'mutationStatus', requestId: request.requestId }, sender)).status,
  ).toBe('completed');
  expect(h.write).toHaveBeenCalledTimes(1);
  await expect(h.journal.organizeCheckpoints.put({ ...h.checkpoint, revision: 2 }, 1)).rejects.toThrow('submitted');
  await expect(h.journal.organizeCheckpoints.remove('task', 1)).rejects.toThrow('conflict');
  await expect(h.authority.prepare(await h.organizer.open(sender), 'task', 1, sender)).rejects.toThrow('conflict');
  const changedIdentity = {
    ...request,
    organizerBinding: { ...request.organizerBinding!, selectionDigest: 'f'.repeat(64) },
  };
  expect((await restarted.submit(changedIdentity, sender)).reason).toBe('request-id-conflict');
  const ownerAfterRestart = new OrganizeTaskOwner({
    projection: h.projection,
    settings: h.settings,
    store: h.journal.organizeCheckpoints,
    lifetime: { acquire: () => () => {}, dispose: () => {} },
  });
  expect(await ownerAfterRestart.get('task')).toMatchObject({
    submission: { requestId: request.requestId },
    state: { invalid: true },
  });
  ownerAfterRestart.dispose();
  h.dispose();
});

it('commits exactly one of two task handoffs and refuses a stale review without native writes', async () => {
  const h = await setup();
  const request = (await h.preview())!;
  const handoff = await h.authority.authorizeHandoff(request, sender);
  const plan = preflight(request, h.tree);
  const first = operationRecord(request, plan.steps, plan.affected);
  const second = operationRecord({ ...request, requestId: 'second-request' }, plan.steps, plan.affected);
  const result = await Promise.allSettled([
    h.journal.handoffOrganize(handoff.checkpoint, first, 0),
    h.journal.handoffOrganize(
      { ...handoff.checkpoint, submission: { ...handoff.checkpoint.submission!, requestId: second.requestId } },
      second,
      0,
    ),
  ]);
  expect(result.filter(entry => entry.status === 'fulfilled')).toHaveLength(1);
  expect(await h.journal.all()).toHaveLength(1);
  expect(h.write).not.toHaveBeenCalled();
  const restarted = new MutationCoordinator(h.projection, h.writer, h.journal, 'test');
  const saved = (await h.journal.all())[0]!;
  expect(
    await restarted.submit({ version: 1, type: 'reconcileMutation', requestId: saved.requestId }, sender),
  ).toMatchObject({ status: 'unknown', needsReconcile: true });
  // Even planned/not-issued evidence is not permission to replay after a worker loss.
  await restarted.submit(saved.request, sender);
  expect(h.write).not.toHaveBeenCalled();
  h.dispose();
});

it('aborts both stores on quota failure and issues no bookmark call', async () => {
  const h = await setup();
  const request = (await h.preview())!;
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === 'organizeCheckpoints' && value.submission) throw new DOMException('quota', 'QuotaExceededError');
    return key === undefined ? put.call(this, value) : put.call(this, value, key);
  });
  try {
    expect(await h.coordinator.submit(request, sender)).toMatchObject({
      status: 'rejected',
      reason: 'organize-checkpoint-freeze-failed',
    });
  } finally {
    spy.mockRestore();
  }
  expect(await h.journal.all()).toEqual([]);
  expect(await h.journal.organizeCheckpoints.get('task')).toEqual(h.checkpoint);
  expect(h.write).not.toHaveBeenCalled();
  h.dispose();
});

it('loses page authorization during durable intent without issuing the first call', async () => {
  const h = await setup();
  const request = (await h.preview())!;
  const put = h.journal.put.bind(h.journal);
  vi.spyOn(h.journal, 'put').mockImplementation(async record => {
    await put(record);
    if (record.steps.some(step => step.state === 'intent')) h.organizer.close(h.token);
  });
  expect(await h.coordinator.submit(request, sender)).toMatchObject({
    status: 'failed',
    reason: 'expired-organizer-context',
  });
  expect((await h.journal.organizeCheckpoints.get('task'))?.submission?.requestId).toBe(request.requestId);
  expect(h.write).not.toHaveBeenCalled();
  h.dispose();
});

it('preserves ambiguous native results after restart and never repeats a call with no receipt', async () => {
  const h = await setup();
  const request = (await h.preview())!;
  const move = h.write.getMockImplementation()!;
  h.write.mockImplementation(async (...args) => {
    await move(...args);
    throw Error('response lost');
  });
  expect(await h.coordinator.submit(request, sender)).toMatchObject({ status: 'unknown', needsReconcile: true });
  const restarted = new MutationCoordinator(h.projection, h.writer, h.journal, 'test');
  expect(await restarted.submit(request, sender)).toMatchObject({ status: 'unknown', needsReconcile: true });
  await restarted.submit({ version: 1, type: 'reconcileMutation', requestId: request.requestId }, sender);
  expect(h.write).toHaveBeenCalledTimes(1);
  h.dispose();
});

it('rechecks the page lease after the additional task validation awaits immediately before the first call', async () => {
  const h = await setup();
  const request = (await h.preview())!;
  let armed = false,
    reads = 0;
  const put = h.journal.put.bind(h.journal);
  vi.spyOn(h.journal, 'put').mockImplementation(async record => {
    await put(record);
    if (record.steps.some(step => step.state === 'intent')) armed = true;
  });
  h.projection.fresh.mockImplementation(async () => {
    // latest after intent, organizer's final tree, then the additional task authority's tree.
    if (armed && ++reads === 3) h.organizer.close(h.token);
    return structuredClone(h.tree);
  });
  expect(await h.coordinator.submit(request, sender)).toMatchObject({
    status: 'failed',
    reason: 'expired-organize-task',
  });
  expect(h.write).not.toHaveBeenCalled();
  expect((await h.journal.organizeCheckpoints.get('task'))?.submission?.requestId).toBe(request.requestId);
  h.dispose();
});

it('rejects changed settings, scope, selection and remembered safety constraints before handoff', async () => {
  for (const change of ['settings', 'scope', 'selection', 'protection', 'rejection'] as const) {
    const h = await setup();
    const request = (await h.preview())!;
    if (change === 'settings') {
      h.value.revision = 'two';
      h.listeners.forEach(cb => cb());
    }
    if (change === 'scope') h.tree.nodes.find(n => n.ref.nativeId === 'a')!.title = 'edited';
    if (change === 'selection')
      await h.journal.organizeCheckpoints.put(
        { ...h.checkpoint, revision: 1, selection: { selected: [], targets: {} } },
        0,
      );
    if (change === 'protection')
      await h.memory.update('install', memory => ({ ...memory, protectedFolderIds: ['left'] }));
    if (change === 'rejection') {
      const { state } = await restoreOrganizeGeneration(
        h.checkpoint,
        { ...h.value, tree: h.tree },
        { allowMissingCredential: true },
      );
      const signature = organizeRejectionKey(state.proposal!, state.proposal!.actions[0]!, {});
      await h.memory.update('install', memory => ({ ...memory, rejected: [{ signature, label: 'move' }] }));
    }
    expect((await h.coordinator.submit(request, sender)).status).toBe('rejected');
    expect(await h.journal.all()).toEqual([]);
    expect(h.write).not.toHaveBeenCalled();
    h.dispose();
  }
});

it('requires the exact journal facet and rejects forged bindings through generic preview registration', async () => {
  const h = await setup();
  const other = new ImportPersistenceStore(new IDBFactory());
  const wrong = new MutationCoordinator(
    h.projection,
    h.writer,
    other,
    'test',
    undefined,
    h.organizer,
    undefined,
    h.authority,
  );
  await expect(wrong.registerOrganizeTaskPreview(h.token, 'task', 0, sender)).rejects.toThrow('owner-mismatch');
  const request = (await h.preview())!;
  expect(() => h.coordinator.registerPreview({ ...request, previewId: undefined }, sender)).toThrow('invalid-preview');
  await expect(
    h.coordinator.registerOrganizerPreview(
      { ...request, previewId: undefined, organizerBinding: { ...request.organizerBinding!, checkpointId: 'forged' } },
      sender,
    ),
  ).rejects.toThrow('invalid-organize-authority');
  expect(h.write).not.toHaveBeenCalled();
  expect(await other.all()).toEqual([]);
  h.dispose();
});
