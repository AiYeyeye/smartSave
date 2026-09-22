import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { MutationCoordinator } from '../background/mutation-coordinator';
import { OperationsStore, operationSchema, type OperationRecord } from '../persistence/operations';
import { TreeProjection } from '../background/tree-projection';
import type { BookmarkWriter } from '../adapters/bookmarks-write';
import { prepareRecovery } from '../domain/undo';
import { prepareRecoveryCopy } from '../domain/recovery-copy';
import { applyTouched } from '../domain/mutation-effect';

/** The v1 shape of a v2 record: replays each receipt's touched delta to rebuild the full before/expectedAfter/after trees the old journal persisted per step. */
function legacyEquivalent(record: OperationRecord): OperationRecord {
  if (record.schemaVersion !== 2) throw Error('v2-record-expected');
  let before = record.backup?.nodes ?? record.request.before;
  const steps = record.steps.map(({ step, state, returnedNativeId, touched }) => {
    if (state !== 'receipt' || !touched) return { step, state, returnedNativeId };
    const after = applyTouched(before, touched);
    const entry = { step, state, returnedNativeId, before, expectedAfter: after, after };
    before = after;
    return entry;
  });
  return operationSchema.parse({
    schemaVersion: 1,
    requestId: record.requestId,
    request: record.request,
    affected: record.affected,
    createdAt: record.createdAt,
    backup: record.backup,
    quarantine: record.quarantine,
    mapping: record.mapping,
    result: record.result,
    steps,
  });
}

async function setup() {
  const tree: chrome.bookmarks.BookmarkTreeNode[] = [
    {
      id: '0',
      title: '',
      syncing: false,
      children: [
        {
          id: 'bar',
          parentId: '0',
          title: 'Bar',
          syncing: false,
          children: [
            { id: 'a', parentId: 'bar', title: 'A', url: 'https://a.test/', syncing: false },
            { id: 'b', parentId: 'bar', title: 'B', url: 'https://b.test/', syncing: false },
          ],
        },
      ],
    },
  ];
  const find = (id: string): chrome.bookmarks.BookmarkTreeNode => {
    const pending = [...tree];
    while (pending.length) {
      const n = pending.shift()!;
      if (n.id === id) return n;
      pending.push(...(n.children ?? []));
    }
    throw Error('missing');
  };
  let calls = 0;
  const writer: BookmarkWriter = {
    update: async (id, changes) => {
      calls++;
      Object.assign(find(id), changes);
      return structuredClone(find(id));
    },
    create: async details => {
      const parent = find(details.parentId!);
      const n = {
        ...details,
        id: `new-${++calls}`,
        index: parent.children!.length,
        syncing: false,
        ...(details.url === undefined ? { children: [] } : {}),
      };
      parent.children!.push(n);
      return structuredClone(n);
    },
    remove: async id => {
      calls++;
      const n = find(id);
      const p = find(n.parentId!);
      p.children = p.children!.filter(c => c.id !== id);
      p.children.forEach((c, i) => {
        c.index = i;
      });
    },
    move: async (id, destination) => {
      calls++;
      const n = find(id);
      const old = find(n.parentId!);
      old.children = old.children!.filter(c => c.id !== id);
      old.children.forEach((c, i) => {
        c.index = i;
      });
      const p = find(destination.parentId!);
      p.children!.splice(destination.index ?? p.children!.length, 0, n);
      n.parentId = p.id;
      p.children!.forEach((c, i) => {
        c.index = i;
      });
      return structuredClone(n);
    },
  };
  const projection = new TreeProjection(
    { read: async () => structuredClone(tree), listen: () => () => {} },
    async () => 'install',
    'epoch',
  );
  projection.start();
  const store = new OperationsStore(new IDBFactory());
  const owner = new MutationCoordinator(projection, writer, store, 'test');
  const sender = { id: 'test', url: 'chrome-extension://test/options/index.html' };
  const request = async (command: unknown, requestId = 'batch') => {
    const snapshot = await projection.fresh();
    return {
      version: 1,
      type: 'confirmMutation',
      requestId,
      installationId: snapshot.installationId,
      epoch: snapshot.epoch,
      observedRevision: snapshot.observedRevision,
      scope: findRef('bar', snapshot),
      before: snapshot.nodes,
      command,
    };
  };
  const findRef = (id: string, snapshot: Awaited<ReturnType<typeof projection.fresh>>) =>
    snapshot.nodes.find(n => n.ref.nativeId === id)!.ref;
  const ref = (id: string) => ({ installationId: 'install', nativeId: id, kind: 'bookmark' as const });
  const batch = {
    type: 'batch',
    operations: ['a', 'b'].map(id => ({
      id,
      dependsOn: [] as string[],
      command: { type: 'update', target: ref(id), changes: { title: `${id}-new` } },
    })),
    selectedOperationIds: ['a', 'b'],
  };
  return { tree, find, writer, projection, store, owner, sender, request, ref, batch, calls: () => calls };
}
it('preflights every selected operation before any write and atomically saves full backup', async () => {
  const h = await setup();
  const m = await h.request(h.batch);
  h.find('b').title = 'external';
  expect((await h.owner.submit(m, h.sender)).status).toBe('rejected');
  expect(h.calls()).toBe(0);
  expect(await h.owner.submit(await h.request(h.batch, 'fresh'), h.sender)).toMatchObject({
    status: 'completed',
    completedSteps: 2,
  });
  const record = (await h.store.all()).find(r => r.requestId === 'fresh')!;
  expect(record.backup?.nodes).toHaveLength(4);
  expect(record.createdAt).toBeDefined();
});
it('undo skips later-edited item but restores its unchanged peer through the same owner', async () => {
  const h = await setup();
  await h.owner.submit(await h.request(h.batch), h.sender);
  h.find('a').title = 'later';
  const record = (await h.store.all())[0]!;
  const preview = prepareRecovery(record, await h.projection.fresh(), 'undo');
  expect(preview.conflicts.some(c => c.nativeId === 'a')).toBe(true);
  expect(preview.command.operations).toHaveLength(1);
  expect((await h.owner.submit(await h.request(preview.command, 'undo'), h.sender)).status).toBe('completed');
  expect(h.find('a').title).toBe('later');
  expect(h.find('b').title).toBe('B');
});
it('durable quarantine never changes unknown, never replays and survives restart', async () => {
  const h = await setup();
  h.writer.create = async () => {
    throw Error('lost callback');
  };
  const m = await h.request({ type: 'create', parent: { ...h.ref('bar'), kind: 'folder' }, title: 'Unknown' });
  expect((await h.owner.submit(m, h.sender)).status).toBe('unknown');
  expect(
    await h.owner.submit({ version: 1, type: 'quarantineMutation', requestId: 'batch', confirmed: true }, h.sender),
  ).toMatchObject({ status: 'unknown', needsReconcile: true });
  expect((await h.store.all())[0]!.quarantine?.acknowledgedAt).toBeDefined();
  const restarted = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  expect((await restarted.submit(m, h.sender)).status).toBe('unknown');
  expect((await restarted.submit(await h.request(h.batch, 'independent'), h.sender)).status).toBe('completed');
});
it('backup transaction failure issues zero writes for batch', async () => {
  const h = await setup();
  const owner = new MutationCoordinator(
    h.projection,
    h.writer,
    {
      all: () => h.store.all(),
      put: async () => {
        throw Error('quota');
      },
    },
    'test',
  );
  expect((await owner.submit(await h.request(h.batch), h.sender)).status).toBe('rejected');
  expect(h.calls()).toBe(0);
});
it('rejects omitted dependencies, cycles and a stale pre-quarantine independent preview', async () => {
  const h = await setup();
  const bad = structuredClone(h.batch);
  bad.operations[0]!.dependsOn = ['b'];
  bad.selectedOperationIds = ['a'];
  expect((await h.owner.submit(await h.request(bad, 'omitted'), h.sender)).status).toBe('rejected');
  bad.selectedOperationIds = ['a', 'b'];
  bad.operations[1]!.dependsOn = ['a'];
  expect((await h.owner.submit(await h.request(bad, 'cycle'), h.sender)).status).toBe('rejected');
  const stale = await h.request(h.batch, 'old-independent');
  h.writer.create = async () => {
    throw Error('unknown');
  };
  await h.owner.submit(
    await h.request({ type: 'create', parent: { ...h.ref('bar'), kind: 'folder' }, title: 'x' }),
    h.sender,
  );
  await h.owner.submit({ version: 1, type: 'quarantineMutation', requestId: 'batch', confirmed: true }, h.sender);
  expect((await h.owner.submit(stale, h.sender)).status).toBe('rejected');
  expect(h.calls()).toBe(0);
});
it('quarantine checkpoint failure cannot unlock writes; other unknowns still gate after successful acknowledgement', async () => {
  const h = await setup();
  h.writer.create = async () => {
    throw Error('unknown');
  };
  await h.owner.submit(
    await h.request({ type: 'create', parent: { ...h.ref('bar'), kind: 'folder' }, title: 'x' }),
    h.sender,
  );
  const failed = new MutationCoordinator(
    h.projection,
    h.writer,
    {
      all: () => h.store.all(),
      put: async () => {
        throw Error('disk');
      },
    },
    'test',
  );
  expect(
    (await failed.submit({ version: 1, type: 'quarantineMutation', requestId: 'batch', confirmed: true }, h.sender))
      .reason,
  ).toBe('quarantine-checkpoint-failed');
  expect((await failed.submit(await h.request(h.batch, 'blocked'), h.sender)).status).toBe('rejected');
  const other = structuredClone((await h.store.all())[0]!);
  other.requestId = 'other';
  other.request.requestId = 'other';
  await h.store.put(other);
  await h.owner.submit({ version: 1, type: 'quarantineMutation', requestId: 'batch', confirmed: true }, h.sender);
  expect((await h.owner.submit(await h.request(h.batch, 'still-blocked'), h.sender)).status).toBe('rejected');
  await expect(h.store.cleanup('batch')).rejects.toThrow('cleanup-refused');
});
it('cancellation during an issued call checkpoints that call and stops only remaining steps', async () => {
  const h = await setup();
  const update = h.writer.update;
  h.writer.update = async (id, changes) => {
    void h.owner.submit({ version: 1, type: 'cancelMutation', requestId: 'batch' }, h.sender);
    return update(id, changes);
  };
  expect(await h.owner.submit(await h.request(h.batch), h.sender)).toMatchObject({
    status: 'partial',
    completedSteps: 1,
    remainingSteps: 1,
    reason: 'cancelled-remaining-not-issued',
  });
  expect(h.find('b').title).toBe('B');
});
it('restores deleted folder parents before children with new identities and preserves later siblings', async () => {
  const h = await setup();
  const folder = {
    id: 'f',
    parentId: 'bar',
    title: 'F',
    syncing: false,
    children: [{ id: 'leaf', parentId: 'f', title: 'Leaf', url: 'https://leaf.test/', syncing: false }],
  };
  h.find('bar').children!.push(folder);
  expect(
    (
      await h.owner.submit(
        await h.request({ type: 'deleteSubtree', target: { ...h.ref('f'), kind: 'folder' } }),
        h.sender,
      )
    ).status,
  ).toBe('completed');
  h.find('bar').children!.push({
    id: 'later',
    parentId: 'bar',
    title: 'Later',
    url: 'https://later.test/',
    syncing: false,
  });
  const response = await h.owner.recovery(
    { version: 1, type: 'recoveryPreview', requestId: 'preview', sourceRequestId: 'batch', mode: 'merge' },
    h.sender,
  );
  expect(response.status).toBe('preview');
  if (response.status !== 'preview' || !response.proposal) throw Error('missing proposal');
  expect(await h.owner.submit(response.proposal, h.sender)).toMatchObject({ status: 'completed', reason: undefined });
  expect(h.find('later').title).toBe('Later');
  const restored = h.find('bar').children!.find(n => n.title === 'F')!;
  expect(restored.id).not.toBe('f');
  expect(restored.children![0]!.title).toBe('Leaf');
  await expect(h.store.cleanup('batch')).rejects.toThrow('cleanup-refused');
});
it('cross-lineage merge never adopts by URL; explicit copy previews and writes new identities', async () => {
  const h = await setup();
  await h.owner.submit(await h.request(h.batch), h.sender);
  const source = (await h.store.all())[0]!;
  source.request.installationId = 'foreign';
  source.backup!.installationId = 'foreign';
  await h.store.put(source);
  expect(prepareRecovery(source, await h.projection.fresh(), 'merge').command.operations).toHaveLength(0);
  const response = await h.owner.recovery(
    {
      version: 1,
      type: 'recoveryPreview',
      requestId: 'copy-preview',
      sourceRequestId: 'batch',
      mode: 'copy',
      destination: { ...h.ref('bar'), kind: 'folder' },
      selectedNativeIds: ['a'],
    },
    h.sender,
  );
  expect(response.status).toBe('preview');
  if (response.status !== 'preview' || !response.proposal) throw Error('missing proposal');
  expect(response.warning).toContain('可能重复');
  expect(await h.owner.submit(response.proposal, h.sender)).toMatchObject({ status: 'completed', reason: undefined });
  expect(h.find('bar').children!.filter(n => n.url === 'https://a.test/')).toHaveLength(2);
  expect(h.find('a').title).toBe('a-new');
  expect((await h.store.all()).find(r => r.requestId === 'batch')!.request.installationId).toBe('foreign');
});
it('cleanup leaves a permanent dedupe tombstone and does not delete active dependencies', async () => {
  const h = await setup();
  const m = await h.request(h.batch);
  await h.owner.submit(m, h.sender);
  await h.store.cleanup('batch');
  const record = (await h.store.all())[0]!;
  expect(record.backup).toBeUndefined();
  expect(record.request.before).toEqual([]);
  const restarted = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  expect((await restarted.submit(m, h.sender)).status).toBe('completed');
  expect(h.calls()).toBe(2);
});
it('does not remove a created folder with later-added children on undo', async () => {
  const h = await setup();
  await h.owner.submit(
    await h.request({ type: 'create', parent: { ...h.ref('bar'), kind: 'folder' }, title: 'Created' }),
    h.sender,
  );
  h.find('new-1').children!.push({
    id: 'later',
    parentId: 'new-1',
    title: 'Later',
    url: 'https://later.test/',
    syncing: false,
  });
  const preview = prepareRecovery((await h.store.all())[0]!, await h.projection.fresh(), 'undo');
  expect(preview.command.operations).toHaveLength(0);
  expect(preview.conflicts).toHaveLength(1);
});
it('second merge preview uses recorded old-to-new mapping, never recreates an already restored folder', async () => {
  const h = await setup();
  h.find('bar').children!.push({ id: 'f', parentId: 'bar', title: 'Empty', syncing: false, children: [] });
  await h.owner.submit(await h.request({ type: 'remove', target: { ...h.ref('f'), kind: 'folder' } }), h.sender);
  const first = await h.owner.recovery(
    { version: 1, type: 'recoveryPreview', requestId: 'p1', sourceRequestId: 'batch', mode: 'merge' },
    h.sender,
  );
  if (first.status !== 'preview' || !first.proposal) throw Error('missing');
  expect((await h.owner.submit(first.proposal, h.sender)).status).toBe('completed');
  const second = await h.owner.recovery(
    { version: 1, type: 'recoveryPreview', requestId: 'p2', sourceRequestId: 'batch', mode: 'merge' },
    h.sender,
  );
  expect(second.status).toBe('preview');
  if (second.status === 'preview') expect(second.proposal).toBeUndefined();
  expect(h.find('bar').children!.filter(n => n.title === 'Empty')).toHaveLength(1);
});
it('recovery preview is not write authorization after restart or if modified by a caller', async () => {
  const h = await setup();
  await h.owner.submit(await h.request(h.batch), h.sender);
  const p = await h.owner.recovery(
    { version: 1, type: 'recoveryPreview', requestId: 'p', sourceRequestId: 'batch', mode: 'undo' },
    h.sender,
  );
  if (p.status !== 'preview' || !p.proposal) throw Error('missing');
  const modified = structuredClone(p.proposal);
  modified.command = { type: 'create', parent: { ...h.ref('bar'), kind: 'folder' }, title: 'forged' };
  expect((await h.owner.submit(modified, h.sender)).status).toBe('rejected');
  expect(
    (await new MutationCoordinator(h.projection, h.writer, h.store, 'test').submit(p.proposal, h.sender)).status,
  ).toBe('rejected');
  expect(h.calls()).toBe(2);
});
it('undo move preserves subsequent move to a third folder and reports structural conflicts', async () => {
  const h = await setup();
  for (const id of ['beta', 'gamma'])
    h.find('bar').children!.push({ id, parentId: 'bar', title: id, syncing: false, children: [] });
  const command = {
    type: 'batch',
    selectedOperationIds: ['a', 'b'],
    operations: ['a', 'b'].map((id, i) => ({
      id,
      dependsOn: [] as string[],
      command: { type: 'move', target: h.ref(id), parent: { ...h.ref('beta'), kind: 'folder' }, index: i },
    })),
  };
  expect((await h.owner.submit(await h.request(command), h.sender)).status).toBe('completed');
  await h.writer.move('a', { parentId: 'gamma', index: 0 });
  const p = prepareRecovery((await h.store.all())[0]!, await h.projection.fresh(), 'undo');
  expect(p.conflicts.some(c => c.nativeId === 'a')).toBe(true);
  expect(p.command.operations.some(o => o.command.type === 'move' && o.command.target.nativeId === 'b')).toBe(true);
  const response = await h.owner.recovery(
    { version: 1, type: 'recoveryPreview', requestId: 'peer', sourceRequestId: 'batch', mode: 'undo' },
    h.sender,
  );
  if (response.status !== 'preview' || !response.proposal) throw Error('missing peer proposal');
  expect((await h.owner.submit(response.proposal, h.sender)).status).toBe('completed');
  expect(h.find('a').parentId).toBe('gamma');
  expect(h.find('b').parentId).toBe('bar');
});
it('undo reverses folder merge topology without deleting later additions in destination', async () => {
  const h = await setup();
  h.find('bar').children!.push(
    {
      id: 'source',
      parentId: 'bar',
      title: 'Source',
      syncing: false,
      children: [{ id: 'leaf', parentId: 'source', title: 'Leaf', url: 'https://leaf.test/', syncing: false }],
    },
    { id: 'dest', parentId: 'bar', title: 'Destination', syncing: false, children: [] },
  );
  const command = {
    type: 'batch',
    selectedOperationIds: ['move', 'remove'],
    operations: [
      {
        id: 'move',
        dependsOn: [],
        command: { type: 'move', target: h.ref('leaf'), parent: { ...h.ref('dest'), kind: 'folder' }, index: 0 },
      },
      {
        id: 'remove',
        dependsOn: ['move'],
        command: { type: 'remove', target: { ...h.ref('source'), kind: 'folder' } },
      },
    ],
  };
  expect((await h.owner.submit(await h.request(command), h.sender)).status).toBe('completed');
  h.find('dest').children!.push({
    id: 'later',
    parentId: 'dest',
    title: 'Later',
    url: 'https://later.test/',
    syncing: false,
  });
  const p = await h.owner.recovery(
    { version: 1, type: 'recoveryPreview', requestId: 'p', sourceRequestId: 'batch', mode: 'undo' },
    h.sender,
  );
  expect(p.status).toBe('preview');
  if (p.status !== 'preview' || !p.proposal) throw Error('missing');
  expect((await h.owner.submit(p.proposal, h.sender)).status).toBe('completed');
  expect(h.find('later').parentId).toBe('dest');
  expect(h.find('leaf').parentId).not.toBe('dest');
});
it('undo created folder and bookmark removes child then now-empty folder with receipts', async () => {
  const h = await setup();
  await h.owner.submit(
    await h.request({
      type: 'createFolderAndBookmark',
      parent: { ...h.ref('bar'), kind: 'folder' },
      folderTitle: 'F',
      title: 'New',
      url: 'https://new.test/',
    }),
    h.sender,
  );
  const p = await h.owner.recovery(
    { version: 1, type: 'recoveryPreview', requestId: 'p', sourceRequestId: 'batch', mode: 'undo' },
    h.sender,
  );
  if (p.status !== 'preview' || !p.proposal) throw Error('missing');
  expect((await h.owner.submit(p.proposal, h.sender)).status).toBe('completed');
  expect(h.find('bar').children!.map(n => n.id)).toEqual(['a', 'b']);
});
it('undo restores an unchanged peer even when another moved bookmark was moved again', async () => {
  const h = await setup();
  for (const id of ['beta', 'gamma'])
    h.find('bar').children!.push({ id, parentId: 'bar', title: id, syncing: false, children: [] });
  const batch = {
    type: 'batch',
    selectedOperationIds: ['move', 'edit'],
    operations: [
      {
        id: 'move',
        dependsOn: [],
        command: { type: 'move', target: h.ref('a'), parent: { ...h.ref('beta'), kind: 'folder' }, index: 0 },
      },
      { id: 'edit', dependsOn: [], command: { type: 'update', target: h.ref('b'), changes: { title: 'Edited' } } },
    ],
  };
  await h.owner.submit(await h.request(batch), h.sender);
  await h.writer.move('a', { parentId: 'gamma', index: 0 });
  const p = await h.owner.recovery(
    { version: 1, type: 'recoveryPreview', requestId: 'p', sourceRequestId: 'batch', mode: 'undo' },
    h.sender,
  );
  if (p.status !== 'preview' || !p.proposal) throw Error('missing');
  expect(p.conflicts.some(c => c.nativeId === 'a')).toBe(true);
  expect((await h.owner.submit(p.proposal, h.sender)).status).toBe('completed');
  expect(h.find('a').parentId).toBe('gamma');
  expect(h.find('b').title).toBe('B');
});
it('superseded and explicitly discarded recovery previews cannot authorize writes', async () => {
  const h = await setup();
  await h.owner.submit(await h.request(h.batch), h.sender);
  const request = { version: 1, type: 'recoveryPreview', requestId: 'p', sourceRequestId: 'batch', mode: 'undo' };
  const first = await h.owner.recovery(request, h.sender);
  const second = await h.owner.recovery(request, h.sender);
  if (first.status !== 'preview' || !first.proposal || second.status !== 'preview' || !second.proposal)
    throw Error('missing');
  expect((await h.owner.submit(first.proposal, h.sender)).reason).toBe('recovery-preview-required');
  await h.owner.recovery(
    { version: 1, type: 'recoveryDiscard', requestId: 'discard', proposalRequestId: second.proposal.requestId },
    h.sender,
  );
  expect((await h.owner.submit(second.proposal, h.sender)).reason).toBe('recovery-preview-required');
  expect(h.calls()).toBe(2);
});
it.each(['undo', 'merge', 'copy'] as const)(
  'recovery %s skips unsupported URL and applies eligible peers',
  async mode => {
    const h = await setup();
    h.find('a').url = 'javascript:alert(1)';
    const command = {
      type: 'batch',
      selectedOperationIds: ['a', 'b'],
      operations: ['a', 'b'].map(id => ({ id, dependsOn: [], command: { type: 'remove', target: h.ref(id) } })),
    };
    expect((await h.owner.submit(await h.request(command), h.sender)).status).toBe('completed');
    const p = await h.owner.recovery(
      {
        version: 1,
        type: 'recoveryPreview',
        requestId: 'url',
        sourceRequestId: 'batch',
        mode,
        ...(mode === 'copy' ? { destination: { ...h.ref('bar'), kind: 'folder' }, selectedNativeIds: ['a', 'b'] } : {}),
      },
      h.sender,
    );
    expect(p.status).toBe('preview');
    if (p.status !== 'preview' || !p.proposal) throw Error('missing');
    expect(p.conflicts).toContainEqual({ nativeId: 'a', reason: 'unsupported-recovery-url' });
    expect((await h.owner.submit(p.proposal, h.sender)).status).toBe('completed');
    expect(h.find('bar').children!.map(n => n.url)).toEqual(['https://b.test/']);
  },
);
it.each(['target-reorder', 'survivor-reorder', 'insertion', 'missing-evidence', 'preview-race'])(
  'undo index drift rejects %s',
  async scenario => {
    const h = await setup();
    for (const id of ['beta', 'gamma'])
      h.find('bar').children!.push({ id, parentId: 'bar', title: id, syncing: false, children: [] });
    h.find('bar').children!.push({ id: 'c', parentId: 'bar', title: 'C', url: 'https://c.test/', syncing: false });
    const command = {
      type: 'batch',
      selectedOperationIds: ['a', 'b', 'c'],
      operations: ['a', 'b', 'c'].map((id, index) => ({
        id,
        dependsOn: [],
        command: { type: 'move', target: h.ref(id), parent: { ...h.ref('beta'), kind: 'folder' }, index },
      })),
    };
    expect((await h.owner.submit(await h.request(command), h.sender)).status).toBe('completed');
    await h.writer.move('a', { parentId: 'gamma', index: 0 });
    if (scenario === 'target-reorder') await h.writer.move('b', { parentId: 'beta', index: 1 });
    if (scenario === 'survivor-reorder') await h.writer.move('c', { parentId: 'beta', index: 0 });
    if (scenario === 'insertion') await h.writer.create({ parentId: 'beta', title: 'New', url: 'https://new.test/' });
    if (scenario === 'missing-evidence') {
      const record = (await h.store.all())[0]!;
      if (record.schemaVersion !== 2 || !record.final) throw Error('v2-final-expected');
      record.final = { nodes: record.final.nodes.filter(n => n.ref.nativeId !== 'beta') };
      await h.store.put(record);
    }
    const p = await h.owner.recovery(
      { version: 1, type: 'recoveryPreview', requestId: 'drift', sourceRequestId: 'batch', mode: 'undo' },
      h.sender,
    );
    expect(p.status).toBe('preview');
    if (p.status !== 'preview') throw Error('missing');
    if (scenario === 'preview-race') {
      if (!p.proposal) throw Error('missing proposal');
      await h.writer.move('b', { parentId: 'gamma', index: 1 });
      expect((await h.owner.submit(p.proposal, h.sender)).status).toBe('rejected');
      expect(h.find('b').parentId).toBe('gamma');
    } else {
      expect(p.conflicts.some(c => c.nativeId === 'b')).toBe(true);
      if (p.proposal) expect((await h.owner.submit(p.proposal, h.sender)).status).toBe('completed');
      expect(h.find('b').parentId).toBe('beta');
    }
    expect(h.find('a').parentId).toBe('gamma');
  },
);
it('title-only undo after sibling departure never emits a move', async () => {
  const h = await setup();
  await h.owner.submit(await h.request({ type: 'update', target: h.ref('b'), changes: { title: 'Edited' } }), h.sender);
  await h.writer.remove('a');
  const p = await h.owner.recovery(
    { version: 1, type: 'recoveryPreview', requestId: 'title', sourceRequestId: 'batch', mode: 'undo' },
    h.sender,
  );
  if (p.status !== 'preview' || !p.proposal || p.proposal.command.type !== 'batch') throw Error('missing');
  expect(p.proposal.command.operations.map(o => o.command.type)).toEqual(['update']);
  expect((await h.owner.submit(p.proposal, h.sender)).status).toBe('completed');
  expect(h.find('b')).toMatchObject({ title: 'B', parentId: 'bar', index: 0 });
});
it.each(['forward', 'reverse'] as const)(
  'restores b/c in original order with legal indexes despite %s receipts',
  async order => {
    const h = await setup();
    for (const id of ['beta', 'gamma'])
      h.find('bar').children!.push({ id, parentId: 'bar', title: id, syncing: false, children: [] });
    h.find('bar').children!.push({ id: 'c', parentId: 'bar', title: 'C', url: 'https://c.test/', syncing: false });
    const ids = order === 'forward' ? ['a', 'b', 'c'] : ['c', 'b', 'a'];
    await h.owner.submit(
      await h.request({
        type: 'batch',
        selectedOperationIds: ids,
        operations: ids.map((id, index) => ({
          id,
          dependsOn: [],
          command: { type: 'move', target: h.ref(id), parent: { ...h.ref('beta'), kind: 'folder' }, index },
        })),
      }),
      h.sender,
    );
    await h.writer.move('a', { parentId: 'gamma', index: 0 });
    const p = await h.owner.recovery(
      { version: 1, type: 'recoveryPreview', requestId: 'peers', sourceRequestId: 'batch', mode: 'undo' },
      h.sender,
    );
    if (p.status !== 'preview' || !p.proposal) throw Error('missing');
    expect((await h.owner.submit(p.proposal, h.sender)).status).toBe('completed');
    expect(h.find('bar').children!.map(n => n.id)).toEqual(['b', 'beta', 'gamma', 'c']);
    expect(h.find('a').parentId).toBe('gamma');
  },
);
it.each(['first', 'middle', 'last', 'unrelated', 'ambiguous', 'missing', 'reordered'] as const)(
  'anchor placement %s is evidence-based through owner apply',
  async scenario => {
    const h = await setup();
    const bar = h.find('bar');
    bar.children!.push({ id: 'c', parentId: 'bar', title: 'C', url: 'https://c.test/', syncing: false });
    // Destination outside the source parent, but inside the request scope.
    h.tree[0]!.children!.push({ id: 'dest', parentId: '0', title: 'Dest', syncing: false, children: [] });
    const target = scenario === 'first' ? 'a' : scenario === 'last' ? 'c' : 'b';
    const request = await h.request({
      type: 'move',
      target: h.ref(target),
      parent: { ...h.ref('dest'), kind: 'folder' },
      index: 0,
    });
    request.scope = { ...h.ref('0'), kind: 'folder' };
    expect((await h.owner.submit(request, h.sender)).status).toBe('completed');
    if (scenario === 'unrelated' || scenario === 'ambiguous') {
      await h.writer.create({ parentId: 'bar', title: 'Unrelated', url: 'https://unrelated.test/' });
      if (scenario === 'ambiguous') await h.writer.move('new-2', { parentId: 'bar', index: 1 });
    }
    if (scenario === 'missing') {
      await h.writer.remove('a');
      await h.writer.remove('c');
    }
    if (scenario === 'reordered') await h.writer.move('c', { parentId: 'bar', index: 0 });
    const p = await h.owner.recovery(
      { version: 1, type: 'recoveryPreview', requestId: 'anchor', sourceRequestId: 'batch', mode: 'undo' },
      h.sender,
    );
    if (p.status !== 'preview') throw Error('missing');
    if (['ambiguous', 'missing', 'reordered'].includes(scenario)) {
      expect(p.conflicts).toContainEqual({ nativeId: target, reason: 'placement-conflict' });
      expect(p.proposal).toBeUndefined();
      expect(h.find(target).parentId).toBe('dest');
    } else {
      if (!p.proposal) throw Error('missing proposal');
      expect((await h.owner.submit(p.proposal, h.sender)).status).toBe('completed');
      expect(h.find('bar').children!.map(n => n.id)).toEqual([
        'a',
        'b',
        'c',
        ...(scenario === 'unrelated' ? ['new-2'] : []),
      ]);
    }
  },
);
it('authenticates and journals skipped coverage across reload and reconciliation', async () => {
  const h = await setup();
  h.find('a').url = 'javascript:blocked';
  await h.owner.submit(
    await h.request({
      type: 'batch',
      selectedOperationIds: ['a', 'b'],
      operations: ['a', 'b'].map(id => ({ id, dependsOn: [], command: { type: 'remove', target: h.ref(id) } })),
    }),
    h.sender,
  );
  const request = {
    version: 1,
    type: 'recoveryPreview',
    requestId: 'coverage',
    sourceRequestId: 'batch',
    mode: 'undo',
  };
  const p = await h.owner.recovery(request, h.sender);
  if (p.status !== 'preview' || !p.proposal) throw Error('missing');
  expect(p.proposal.recovery?.conflicts).toContainEqual({ nativeId: 'a', reason: 'unsupported-recovery-url' });
  const forged = structuredClone(p.proposal);
  forged.recovery!.conflicts = [];
  expect((await h.owner.submit(forged, h.sender)).status).toBe('rejected');
  const fresh = await h.owner.recovery(request, h.sender);
  if (fresh.status !== 'preview' || !fresh.proposal) throw Error('missing');
  expect((await h.owner.submit(fresh.proposal, h.sender)).status).toBe('completed');
  const restarted = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  const list = await restarted.recovery({ version: 1, type: 'recoveryList', requestId: 'list' }, h.sender);
  if (list.status !== 'ready') throw Error('missing');
  expect(list.records.find(r => r.requestId === fresh.proposal!.requestId)?.request.recovery?.conflicts).toEqual(
    p.conflicts,
  );
  expect(
    (await restarted.submit({ version: 1, type: 'reconcileMutation', requestId: fresh.proposal.requestId }, h.sender))
      .status,
  ).toBe('completed');
});
it('rejects contradictory restored sibling anchors', async () => {
  const h = await setup();
  h.find('bar').children!.push({ id: 'dest', parentId: 'bar', title: 'Dest', syncing: false, children: [] });
  const command = {
    type: 'batch',
    selectedOperationIds: ['move', 'remove'],
    operations: [
      {
        id: 'move',
        dependsOn: [],
        command: { type: 'move', target: h.ref('a'), parent: { ...h.ref('dest'), kind: 'folder' }, index: 0 },
      },
      { id: 'remove', dependsOn: [], command: { type: 'remove', target: h.ref('b') } },
    ],
  };
  await h.owner.submit(await h.request(command), h.sender);
  const p = await h.owner.recovery(
    { version: 1, type: 'recoveryPreview', requestId: 'alias', sourceRequestId: 'batch', mode: 'undo' },
    h.sender,
  );
  if (p.status !== 'preview') throw Error('missing');
  // Restored b is appended beyond dest: contradictory historical anchors must not be guessed.
  expect(p.conflicts).toContainEqual({ nativeId: 'a', reason: 'placement-conflict' });
  if (!p.proposal) throw Error('missing restore');
  expect((await h.owner.submit(p.proposal, h.sender)).status).toBe('completed');
  expect(h.find('a').parentId).toBe('dest');
});
it('places against a newly restored sole sibling rather than treating its temporary ID as unrelated', async () => {
  const h = await setup();
  h.tree[0]!.children!.push({ id: 'dest', parentId: '0', title: 'Dest', syncing: false, children: [] });
  const request = await h.request({
    type: 'batch',
    selectedOperationIds: ['move', 'remove'],
    operations: [
      {
        id: 'move',
        dependsOn: [],
        command: { type: 'move', target: h.ref('a'), parent: { ...h.ref('dest'), kind: 'folder' }, index: 0 },
      },
      { id: 'remove', dependsOn: [], command: { type: 'remove', target: h.ref('b') } },
    ],
  });
  request.scope = { ...h.ref('0'), kind: 'folder' };
  expect((await h.owner.submit(request, h.sender)).status).toBe('completed');
  const p = await h.owner.recovery(
    { version: 1, type: 'recoveryPreview', requestId: 'alias-good', sourceRequestId: 'batch', mode: 'undo' },
    h.sender,
  );
  if (p.status !== 'preview' || !p.proposal || p.proposal.command.type !== 'batch') throw Error('missing');
  expect(p.proposal.command.operations.find(o => o.id === 'undo-move-a')?.dependsOn).toContain('restore-b');
  expect((await h.owner.submit(p.proposal, h.sender)).status).toBe('completed');
  expect(h.find('bar').children!.map(n => n.title)).toEqual(['A', 'B']);
});
it.each(['undo', 'merge', 'copy'] as const)(
  '%s preview is identical for a v2 record and its v1 full-tree equivalent, including an interrupted batch',
  async mode => {
    const h = await setup();
    for (const id of ['beta', 'gamma'])
      h.find('bar').children!.push({ id, parentId: 'bar', title: id, syncing: false, children: [] });
    const command = {
      type: 'batch',
      selectedOperationIds: ['move', 'remove'],
      operations: [
        {
          id: 'move',
          dependsOn: [],
          command: { type: 'move', target: h.ref('a'), parent: { ...h.ref('beta'), kind: 'folder' }, index: 0 },
        },
        { id: 'remove', dependsOn: [], command: { type: 'remove', target: h.ref('b') } },
      ],
    };
    expect((await h.owner.submit(await h.request(command), h.sender)).status).toBe('completed');
    await h.writer.move('a', { parentId: 'gamma', index: 0 });
    const record = (await h.store.all())[0]!;
    if (record.schemaVersion !== 2 || !record.final) throw Error('v2-final-expected');
    const tree = await h.projection.fresh();
    const preview = (r: OperationRecord) =>
      mode === 'copy'
        ? prepareRecoveryCopy(r, tree, { ...h.ref('bar'), kind: 'folder' }, ['a', 'b'])
        : prepareRecovery(r, tree, mode);
    const modern = preview(record);
    expect(preview(legacyEquivalent(record))).toEqual(modern);
    if (mode === 'undo') {
      expect(modern.conflicts).toEqual([{ nativeId: 'a', reason: 'later-change-or-missing' }]);
      expect(modern.command.operations.map(o => o.command.type)).toEqual(['create']);
    }
    if (mode === 'merge') {
      expect(modern.command.operations.map(o => o.id)).toEqual(['restore-b']);
      expect(modern.conflicts.some(c => c.nativeId === 'a')).toBe(true);
    }
    if (mode === 'copy') expect(modern.command.operations).toHaveLength(2);
    // Without the final snapshot, v2 rebuilds the last receipt tree from touched deltas: same preview as the retained trees.
    const interrupted: OperationRecord = {
      ...record,
      final: undefined,
      result: undefined,
      steps: [record.steps[0]!, { ...record.steps[1]!, state: 'intent', afterDigest: undefined, touched: undefined }],
    };
    expect(preview(interrupted)).toEqual(preview(legacyEquivalent(interrupted)));
    if (mode === 'undo')
      expect(preview(interrupted).conflicts.map(c => c.reason)).toEqual([
        'operation-not-proven',
        'later-change-or-missing',
      ]);
  },
);
