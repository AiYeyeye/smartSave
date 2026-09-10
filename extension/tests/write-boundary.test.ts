import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { MutationCoordinator } from '../background/mutation-coordinator';
import { OperationsStore } from '../persistence/operations';
import { TreeProjection } from '../background/tree-projection';
import type { BookmarkSource } from '../adapters/bookmarks-read';
import type { BookmarkWriter } from '../adapters/bookmarks-write';

async function setup() {
  let tree: chrome.bookmarks.BookmarkTreeNode[] = [{ syncing: false, id: '0', title: '', children: [{ syncing: false, id: 'bar', parentId: '0', title: 'Bar', children: [{ syncing: false, id: 'a', parentId: 'bar', title: 'Old', url: 'https://example.test/' }] }] }];
  const listeners = new Set<() => void>();
  let writes = 0;
  const source: BookmarkSource = { read: async () => structuredClone(tree), listen: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; } };
  const projection = new TreeProjection(source, async () => 'install', 'epoch'); projection.start();
  const writer: BookmarkWriter = {
    update: async (id, changes) => { writes++; const node = tree[0]!.children![0]!.children!.find(n => n.id === id)!; Object.assign(node, changes); listeners.forEach(cb => cb()); return structuredClone(node); },
    create: async () => { throw Error('not used'); }, move: async () => { throw Error('not used'); }, remove: async () => { throw Error('not used'); },
  };
  const store = new OperationsStore(new IDBFactory());
  const coordinator = new MutationCoordinator(projection, writer, store, 'test');
  const snapshot = await projection.fresh();
  const message = { version: 1, type: 'confirmMutation', requestId: 'one', epoch: snapshot.epoch, installationId: snapshot.installationId, observedRevision: snapshot.observedRevision, scope: snapshot.nodes.find(n => n.ref.nativeId === 'bar')!.ref, before: snapshot.nodes, command: { type: 'update', target: snapshot.nodes.find(n => n.ref.nativeId === 'a')!.ref, changes: { title: 'New' } } };
  const sender = { id: 'test', url: 'chrome-extension://test/panel/index.html' };
  return { coordinator, message, sender, store, projection, writer, source, writes: () => writes, tree: () => tree, replace: (value: typeof tree) => { tree = value; } };
}
it('validates sender then journals, reads back and deduplicates a confirmed edit', async () => {
  const h = await setup();
  expect((await h.coordinator.submit(h.message, { id: 'evil', url: h.sender.url })).status).toBe('rejected');
  expect(h.writes()).toBe(0);
  expect((await h.coordinator.submit(h.message, h.sender)).status).toBe('completed');
  expect(h.tree()[0]!.children![0]!.children![0]!.title).toBe('New');
  expect((await h.coordinator.submit(h.message, h.sender)).status).toBe('completed');
  expect(h.writes()).toBe(1);
  const restored = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  expect((await restored.submit(h.message, h.sender)).status).toBe('completed');
  expect(h.writes()).toBe(1);
});
it.each(['epoch', 'revision', 'missing', 'scope', 'readonly', 'dangerous', 'unknown-field'])('rejects %s before any native write', async fault => {
  const h = await setup();
  const m = structuredClone(h.message);
  if (fault === 'epoch') m.epoch = 'old';
  if (fault === 'revision') m.observedRevision++;
  if (fault === 'missing') m.command.target.nativeId = 'missing';
  if (fault === 'scope') m.scope = m.command.target;
  if (fault === 'readonly') m.command.target = m.scope;
  if (fault === 'dangerous') Object.assign(m.command.changes, { url: ' JaVaScRiPt:alert(1)' });
  if (fault === 'unknown-field') Object.assign(m, { apiKey: 'synthetic-forbidden-field' });
  expect((await h.coordinator.submit(m, h.sender)).status).toBe('rejected');
  expect(h.writes()).toBe(0);
});
it('serializes two window requests; second old preview cannot overwrite the first', async () => {
  const h = await setup();
  const results = await Promise.all([h.coordinator.submit(h.message, h.sender), h.coordinator.submit({ ...h.message, requestId: 'two' }, h.sender)]);
  expect(results.map(r => r.status)).toEqual(['completed', 'rejected']); expect(h.writes()).toBe(1);
});
it('blocks every write when backup/intent persistence fails', async () => {
  const h = await setup();
  const coordinator = new MutationCoordinator(h.projection, h.writer, { all: () => h.store.all(), put: async () => { throw Error('quota'); } }, 'test');
  expect((await coordinator.submit(h.message, h.sender)).status).toBe('rejected'); expect(h.writes()).toBe(0);
});
it('keeps completed folder and unknown bookmark when composite second call fails', async () => {
  const h = await setup();
  let creates = 0;
  h.writer.create = async details => {
    creates++;
    if (creates === 2) throw Error('native failure');
    const node = { ...details, id: 'new-folder', index: 1, syncing: false, children: [] };
    h.tree()[0]!.children![0]!.children!.push(node);
    return node;
  };
  const message = { ...h.message, command: { type: 'createFolderAndBookmark', parent: h.message.scope, folderTitle: 'New folder', title: 'Bookmark', url: 'https://second.test/' } };
  const result = await h.coordinator.submit(message, h.sender);
  expect(result).toMatchObject({ status: 'unknown', completedSteps: 1, remainingSteps: 1, needsReconcile: true });
  expect(h.tree()[0]!.children![0]!.children!.map(n => n.id)).toEqual(['a', 'new-folder']);
  expect((await h.coordinator.submit(message, h.sender)).status).toBe('unknown'); expect(creates).toBe(2);
});
it('never recreates a folder whose native success lost its durable receipt', async () => {
  const h = await setup(); let creates = 0; let failed = false;
  h.writer.create = async details => { creates++; const node = { ...details, id: 'unclaimed', index: 1, syncing: false, children: [] }; h.tree()[0]!.children![0]!.children!.push(node); return node; };
  const journal = { all: () => h.store.all(), put: async (record: Parameters<typeof h.store.put>[0]) => {
    if (record.steps.some(s => s.state === 'receipt')) { failed = true; throw Error('disk'); }
    if (failed) throw Error('disk');
    await h.store.put(record);
  } };
  const m = { ...h.message, command: { type: 'createFolderAndBookmark', parent: h.message.scope, folderTitle: 'Folder', title: 'Bookmark', url: 'https://second.test/' } };
  expect((await new MutationCoordinator(h.projection, h.writer, journal, 'test').submit(m, h.sender)).status).toBe('unknown');
  expect((await new MutationCoordinator(h.projection, h.writer, h.store, 'test').submit(m, h.sender)).status).toBe('unknown');
  expect(creates).toBe(1);
});
it('does not delete a later-added child during confirmed postorder subtree deletion', async () => {
  const h = await setup();
  const bar = h.tree()[0]!.children![0]!;
  bar.children = [{ syncing: false, id: 'folder', parentId: 'bar', title: 'Folder', children: [{ syncing: false, id: 'leaf', parentId: 'folder', title: 'Leaf', url: 'https://leaf.test/' }] }];
  const snapshot = await h.projection.fresh(); let removes = 0;
  h.writer.remove = async id => {
    removes++;
    expect(id).toBe('leaf');
    bar.children![0]!.children = [{ syncing: false, id: 'later', parentId: 'folder', title: 'Later', url: 'https://later.test/' }];
  };
  const message = { ...h.message, before: snapshot.nodes, command: { type: 'deleteSubtree', target: snapshot.nodes.find(n => n.ref.nativeId === 'folder')!.ref } };
  expect((await h.coordinator.submit(message, h.sender)).status).toBe('unknown');
  expect(removes).toBe(1); expect(bar.children![0]!.children![0]!.id).toBe('later');
});
it('allows immutable real root as a destination, never virtual root or managed root', async () => {
  const h = await setup();
  const nodes = (await h.projection.fresh()).nodes;
  expect(nodes.find(n => n.ref.nativeId === '0')).toMatchObject({ readOnly: true, childrenWritable: false });
  expect(nodes.find(n => n.ref.nativeId === 'bar')).toMatchObject({ readOnly: true, childrenWritable: true });
  h.tree()[0]!.children![0]!.unmodifiable = 'managed';
  const managed = await h.projection.fresh();
  expect(managed.nodes.find(n => n.ref.nativeId === 'bar')).toMatchObject({ childrenWritable: false });
  expect(managed.nodes.find(n => n.ref.nativeId === 'a')).toMatchObject({ readOnly: true, childrenWritable: false });
});
it('does not issue new writes after a failed final checkpoint even for a different request', async () => {
  const h = await setup();
  const journal = { all: () => h.store.all(), put: async (record: Parameters<typeof h.store.put>[0]) => { if (record.result) throw Error('final checkpoint'); await h.store.put(record); } };
  const owner = new MutationCoordinator(h.projection, h.writer, journal, 'test');
  expect((await owner.submit(h.message, h.sender)).status).toBe('unknown');
  expect((await owner.submit({ ...h.message, requestId: 'two' }, h.sender)).status).toBe('rejected');
  expect(h.writes()).toBe(1);
});
it('records known second-step failure as partial when intent fails before invocation', async () => {
  const h = await setup(); let creates = 0;
  h.writer.create = async details => { creates++; const node = { ...details, id: 'folder', index: 1, syncing: false, children: [] }; h.tree()[0]!.children![0]!.children!.push(node); return node; };
  const journal = { all: () => h.store.all(), put: async (r: Parameters<typeof h.store.put>[0]) => { if (r.steps[1]?.state === 'intent' && !r.result) throw Error('quota'); await h.store.put(r); } };
  const message = { ...h.message, command: { type: 'createFolderAndBookmark', parent: h.message.scope, folderTitle: 'Folder', title: 'Bookmark', url: 'https://second.test/' } };
  const result = await new MutationCoordinator(h.projection, h.writer, journal, 'test').submit(message, h.sender);
  expect(result).toMatchObject({ status: 'partial', completedSteps: 1, remainingSteps: 1, needsReconcile: false }); expect(creates).toBe(1);
});
it('allows retrying a preflight-rejected requestId only as the original rejected result', async () => {
  const h = await setup();
  const invalid = { ...h.message, epoch: 'old' };
  expect((await h.coordinator.submit(invalid, h.sender)).status).toBe('rejected');
  expect((await h.coordinator.submit(h.message, h.sender)).status).toBe('rejected');
  expect(h.writes()).toBe(0);
});
it('executes both bounded create steps and persists their native identity mapping', async () => {
  const h = await setup(); let creates = 0;
  h.writer.create = async details => {
    const parent = details.parentId === 'bar' ? h.tree()[0]!.children![0]! : h.tree()[0]!.children![0]!.children!.find(n => n.id === details.parentId)!;
    const node = { ...details, id: `new-${++creates}`, index: parent.children!.length, syncing: false, ...(details.url === undefined ? { children: [] } : {}) };
    parent.children!.push(node); return node;
  };
  const message = { ...h.message, command: { type: 'createFolderAndBookmark', parent: h.message.scope, folderTitle: 'Folder', title: 'Bookmark', url: 'https://second.test/' } };
  expect((await h.coordinator.submit(message, h.sender))).toMatchObject({ status: 'completed', completedSteps: 2 });
  const records = await h.store.all();
  expect(records[0]!.mapping).toEqual({ $folder: 'new-1', $bookmark: 'new-2' });
  expect(records[0]!.steps.map(s => s.state)).toEqual(['receipt', 'receipt']);
});
it('deletes exactly the confirmed subtree in postorder using remove only', async () => {
  const h = await setup(); const bar = h.tree()[0]!.children![0]!;
  bar.children = [{ syncing: false, id: 'folder', parentId: 'bar', title: 'Folder', children: [{ syncing: false, id: 'leaf', parentId: 'folder', title: 'Leaf', url: 'https://leaf.test/' }] }];
  const snapshot = await h.projection.fresh(); const ids: string[] = [];
  h.writer.remove = async id => { ids.push(id); if (id === 'leaf') bar.children![0]!.children = []; else bar.children = []; };
  const message = { ...h.message, before: snapshot.nodes, command: { type: 'deleteSubtree', target: snapshot.nodes.find(n => n.ref.nativeId === 'folder')!.ref } };
  expect((await h.coordinator.submit(message, h.sender))).toMatchObject({ status: 'completed', completedSteps: 2 });
  expect(ids).toEqual(['leaf', 'folder']); expect(bar.children).toEqual([]);
  expect((await h.store.all())[0]!.affected.map(n => n.ref.nativeId)).toEqual(expect.arrayContaining(['folder', 'leaf']));
});
it('stops before first call when external edit occurs while intent commits', async () => {
  const h = await setup();
  const journal = { all: () => h.store.all(), put: async (record: Parameters<typeof h.store.put>[0]) => {
    await h.store.put(record);
    if (record.steps[0]?.state === 'intent' && !record.result) h.tree()[0]!.children![0]!.children![0]!.title = 'External';
  } };
  expect((await new MutationCoordinator(h.projection, h.writer, journal, 'test').submit(h.message, h.sender)).status).toBe('failed');
  expect(h.writes()).toBe(0);
});
it('marks readback failure unknown and never replays', async () => {
  const h = await setup(); const update = h.writer.update;
  h.writer.update = async (id, changes) => { const node = await update(id, changes); h.source.read = async () => { throw Error('readback'); }; return node; };
  expect((await h.coordinator.submit(h.message, h.sender))).toMatchObject({ status: 'unknown', needsReconcile: true });
  expect((await h.coordinator.submit(h.message, h.sender)).status).toBe('unknown'); expect(h.writes()).toBe(1);
});
it('does not reject title-only updates for existing non-HTTP URLs', async () => {
  const h = await setup(); h.tree()[0]!.children![0]!.children![0]!.url = 'file:///legacy.txt';
  const snapshot = await h.projection.fresh();
  const m = { ...h.message, before: snapshot.nodes, command: { ...h.message.command, changes: { title: 'Legacy', url: 'file:///legacy.txt' } } };
  expect((await h.coordinator.submit(m, h.sender)).status).toBe('completed'); expect(h.writes()).toBe(1);
});
it('unknown journal schema blocks new writes without deleting recovery records', async () => {
  const h = await setup();
  const records = await h.store.all(); expect(records).toEqual([]);
  // The fake IDB is an external storage boundary, not a mocked repository module.
  const factory = new IDBFactory();
  await new Promise<void>((resolve, reject) => {
    const open = factory.open('zhilan-operations', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('operations', { keyPath: 'requestId' });
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const tx = open.result.transaction('operations', 'readwrite'); tx.objectStore('operations').put({ schemaVersion: 99, requestId: 'future' }); tx.oncomplete = () => { open.result.close(); resolve(); }; };
  });
  const store = new OperationsStore(factory);
  const owner = new MutationCoordinator(h.projection, h.writer, store, 'test');
  expect((await owner.submit(h.message, h.sender)).status).toBe('rejected'); expect(h.writes()).toBe(0);
  await expect(store.all()).rejects.toThrow('unsupported-journal');
});
it('rejects folder movement when a descendant differs from the fixed preview', async () => {
  const h = await setup(); const bar = h.tree()[0]!.children![0]!;
  bar.children = [{ syncing: false, id: 'folder', parentId: 'bar', title: 'Folder', children: [{ syncing: false, id: 'leaf', parentId: 'folder', title: 'Original', url: 'https://leaf.test/' }] }];
  const before = await h.projection.fresh();
  bar.children[0]!.children![0]!.title = 'External';
  let moved = false; h.writer.move = async () => { moved = true; throw Error('should not issue'); };
  const message = { ...h.message, before: before.nodes, command: { type: 'move', target: before.nodes.find(n => n.ref.nativeId === 'folder')!.ref, parent: h.message.scope, index: 0 } };
  expect((await h.coordinator.submit(message, h.sender)).status).toBe('rejected'); expect(moved).toBe(false);
});
it('explicit reconciliation bypasses cached unknown and proves a final durable receipt after restart', async () => {
  const h = await setup(); let fail = true;
  const journal = { all: () => h.store.all(), put: async (r: Parameters<typeof h.store.put>[0]) => { if (r.result && fail) throw Error('final checkpoint'); await h.store.put(r); } };
  const owner = new MutationCoordinator(h.projection, h.writer, journal, 'test');
  expect((await owner.submit(h.message, h.sender)).status).toBe('unknown');
  fail = false;
  const query = { version: 1, type: 'reconcileMutation', requestId: 'one' };
  expect((await owner.submit(query, h.sender))).toMatchObject({ status: 'completed', needsReconcile: false, evidence: [{ stepIndex: 0, state: 'checkpointed', nativeId: 'a', currentMatchesReceipt: true }] });
  const restarted = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  expect((await restarted.submit(query, h.sender)).status).toBe('completed'); expect(h.writes()).toBe(1);
});
it('explicit reconciliation reports unknown creates and remaining steps without claiming URL ownership', async () => {
  const h = await setup(); let creates = 0;
  h.writer.create = async details => { creates++; h.tree()[0]!.children![0]!.children!.push({ ...details, id: 'ambiguous', syncing: false, children: [] }); throw Error('lost response'); };
  const message = { ...h.message, command: { type: 'createFolderAndBookmark', parent: h.message.scope, folderTitle: 'Folder', title: 'Bookmark', url: 'https://second.test/' } };
  expect((await h.coordinator.submit(message, h.sender)).status).toBe('unknown');
  const restarted = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  const result = await restarted.submit({ version: 1, type: 'reconcileMutation', requestId: 'one' }, h.sender);
  expect(result).toMatchObject({ status: 'unknown', needsReconcile: true, evidence: [{ stepIndex: 0, state: 'unknown', currentMatchesReceipt: false }, { stepIndex: 1, state: 'not-issued', currentMatchesReceipt: false }] });
  expect(result.evidence?.[0]?.nativeId).toBeUndefined();
  expect((await restarted.submit({ ...message, requestId: 'new' }, h.sender)).status).toBe('rejected'); expect(creates).toBe(1);
});
it.each([0, 1])('restart after composite receipt %s exposes checkpointed and remaining work without replay', async stopAfter => {
  const h = await setup(); let creates = 0;
  h.writer.create = async details => {
    const parent = details.parentId === 'bar' ? h.tree()[0]!.children![0]! : h.tree()[0]!.children![0]!.children!.find(n => n.id === details.parentId)!;
    const node = { ...details, id: `created-${++creates}`, index: parent.children!.length, syncing: false, ...(details.url === undefined ? { children: [] } : {}) }; parent.children!.push(node); return node;
  };
  let checkpoint: Parameters<typeof h.store.put>[0] | undefined;
  const journal = { all: () => h.store.all(), put: async (r: Parameters<typeof h.store.put>[0]) => {
    if (!checkpoint && r.steps[stopAfter]?.state === 'receipt') checkpoint = structuredClone(r);
    await h.store.put(r);
  } };
  const message = { ...h.message, command: { type: 'createFolderAndBookmark', parent: h.message.scope, folderTitle: 'Folder', title: 'Bookmark', url: 'https://second.test/' } };
  await new MutationCoordinator(h.projection, h.writer, journal, 'test').submit(message, h.sender);
  expect(checkpoint).toBeDefined();
  await h.store.put(checkpoint!);
  const restarted = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  const result = await restarted.submit({ version: 1, type: 'reconcileMutation', requestId: 'one' }, h.sender);
  expect(result.completedSteps).toBe(stopAfter + 1);
  expect(result.status).toBe(stopAfter === 1 ? 'completed' : 'unknown');
  expect(result.evidence?.[0]?.state).toBe('checkpointed'); expect(creates).toBe(2);
});
it.each(['put', 'all'])('reconciliation %s failure never reports successful recovery checkpoint', async failure => {
  const h = await setup(); let checkpoint: Parameters<typeof h.store.put>[0] | undefined;
  const capture = { all: () => h.store.all(), put: async (r: Parameters<typeof h.store.put>[0]) => { if (!r.result && r.steps[0]?.state === 'receipt') checkpoint = structuredClone(r); await h.store.put(r); } };
  await new MutationCoordinator(h.projection, h.writer, capture, 'test').submit(h.message, h.sender);
  await h.store.put(checkpoint!); let reads = 0;
  const faulty = { all: async () => { reads++; if (failure === 'all' && reads === 2) throw Error('read'); return h.store.all(); }, put: async (r: Parameters<typeof h.store.put>[0]) => { if (failure === 'put') throw Error('write'); await h.store.put(r); } };
  const result = await new MutationCoordinator(h.projection, h.writer, faulty, 'test').submit({ version: 1, type: 'reconcileMutation', requestId: 'one' }, h.sender);
  expect(result).toMatchObject({ status: 'unknown', needsReconcile: true }); expect(h.writes()).toBe(1);
});
it('completed nested save resolves final folder from durable coordinator receipts without replay', async () => {
  const h = await setup(); let creates = 0;
  const find = (id: string, nodes = h.tree()): chrome.bookmarks.BookmarkTreeNode | undefined => { for (const node of nodes) { if (node.id === id) return node; const found = find(id, node.children ?? []); if (found) return found; } };
  h.writer.create = async details => { const parent = find(details.parentId)!; const node = { ...details, id: `created-${++creates}`, index: parent.children!.length, syncing: false, ...(details.url ? {} : { children: [] }) }; parent.children!.push(node); return node; };
  const { beginSave, prepareSave } = await import('../panel/save-controller'); const { completedSaveFolder } = await import('../panel/save-receipt');
  const snapshot = await h.projection.fresh();
  const draft = { ...beginSave(snapshot, { title: 'Save', url: 'https://nested.test/' }, []), parentId: 'bar', newFolder: true, proposedPath: ['One', 'Two'], folderTitle: 'One' };
  const request = prepareSave(draft, snapshot);
  expect((await h.coordinator.submit(request, h.sender)).status).toBe('completed');
  const reconciled = await h.coordinator.submit({ version: 1, type: 'reconcileMutation', requestId: request.requestId }, h.sender);
  expect(completedSaveFolder(reconciled, request.requestId, snapshot.installationId, 1).nativeId).toBe('created-2');
  const restarted = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  expect((await restarted.submit(request, h.sender)).status).toBe('completed'); expect(creates).toBe(3);
});
it('save-context authority is checked after queue and durable intent, while omitted/forged/restarted contexts fail closed', async () => {
  const h = await setup(); let valid = true;
  const coordinator = new MutationCoordinator(h.projection, h.writer, h.store, 'test', request => request.requestId === 'save:token' && request.saveContext === 'token' && valid);
  const request = { ...h.message, requestId: 'save:token', saveContext: 'token' };
  const registered = coordinator.registerPreview(request, h.sender);
  const pending = coordinator.submit(registered, h.sender); valid = false;
  expect((await pending).status).toBe('rejected'); expect(h.writes()).toBe(0);
  valid = true;
  expect((await coordinator.submit({ ...request, saveContext: undefined }, h.sender)).status).toBe('rejected');
  expect((await coordinator.submit({ ...request, saveContext: 'forged' }, h.sender)).status).toBe('rejected');
  const restarted = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  expect((await restarted.submit(request, h.sender)).status).toBe('rejected');
  const journal = { all: () => h.store.all(), put: async (record: Parameters<typeof h.store.put>[0]) => { await h.store.put(record); if (record.steps.some(step => step.state === 'intent')) valid = false; } };
  const duringIntent = new MutationCoordinator(h.projection, h.writer, journal, 'test', () => valid);
  expect((await duringIntent.submit(duringIntent.registerPreview(request, h.sender), h.sender)).status).toBe('failed'); expect(h.writes()).toBe(0);
});
it('valid save context executes normally and retains durable dedupe after context expires', async () => {
  const h = await setup(); let valid = true;
  const coordinator = new MutationCoordinator(h.projection, h.writer, h.store, 'test', () => valid);
  const request = { ...h.message, requestId: 'save:valid', saveContext: 'valid' };
  const registered = coordinator.registerPreview(request, h.sender);
  expect((await coordinator.submit(registered, h.sender)).status).toBe('completed'); valid = false;
  expect((await coordinator.submit(request, h.sender)).status).toBe('completed'); expect(h.writes()).toBe(1);
});
it('nested save interruption preserves durable identity evidence and never replays creates after restart', async () => {
  const h = await setup(); let creates = 0;
  h.writer.create = async details => { if (++creates === 2) throw Error('ambiguous native failure'); const node = { ...details, id: 'created-one', index: 1, syncing: false, children: [] }; h.tree()[0]!.children![0]!.children!.push(node); return node; };
  const { beginSave, prepareSave } = await import('../panel/save-controller'); const { completedSaveFolder } = await import('../panel/save-receipt');
  const snapshot = await h.projection.fresh();
  const request = prepareSave({ ...beginSave(snapshot, { title: 'Nested', url: 'https://nested.test/' }, []), parentId: 'bar', newFolder: true, proposedPath: ['One', 'Two'], folderTitle: 'One' }, snapshot);
  const result = await h.coordinator.submit(request, h.sender); expect(result).toMatchObject({ status: 'unknown', completedSteps: 1 });
  expect(() => completedSaveFolder(result, request.requestId, snapshot.installationId, 1)).toThrow();
  const restarted = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  await restarted.submit(request, h.sender); expect(creates).toBe(2);
  expect((await h.store.all())[0]?.mapping).toMatchObject({ '$batch:folder-0:$created': 'created-one' });
});
it('registered save preview rejects stripped metadata, replaced command/id and unknown preview after restart', async () => {
  const h = await setup(); const owner = new MutationCoordinator(h.projection, h.writer, h.store, 'test', () => true);
  const proposal = owner.registerPreview({ ...h.message, saveContext: 'token' }, h.sender);
  expect((await owner.submit({ ...proposal, saveContext: undefined }, h.sender)).status).toBe('rejected');
  expect((await owner.submit({ ...proposal, command: { ...h.message.command, changes: { title: 'Forged' } } }, h.sender)).status).toBe('rejected');
  expect((await owner.submit({ ...proposal, requestId: 'replaced' }, h.sender)).status).toBe('rejected');
  const restart = new MutationCoordinator(h.projection, h.writer, h.store, 'test', () => true);
  expect((await restart.submit(proposal, h.sender)).status).toBe('rejected'); expect(h.writes()).toBe(0);
  expect((await owner.submit(proposal, h.sender)).status).toBe('completed');
});
it('invalidated save registrations release ephemeral authority without deleting durable evidence', async () => {
  const h = await setup(); let valid = true;
  const owner = new MutationCoordinator(h.projection, h.writer, h.store, 'test', () => valid);
  const proposal = owner.registerPreview({ ...h.message, saveContext: 'token' }, h.sender);
  valid = false; owner.purgeSavePreviews(); valid = true;
  expect((await owner.submit(proposal, h.sender)).status).toBe('rejected');
  expect((await owner.submit({ ...proposal, saveContext: undefined, previewId: undefined }, h.sender)).status).toBe('rejected');
  expect(await h.store.all()).toEqual([]); expect(h.writes()).toBe(0);
});

it('superseded registration cannot downgrade into generic or execute the previous window proposal', async () => {
  const h = await setup(); const owner = new MutationCoordinator(h.projection, h.writer, h.store, 'test', () => true);
  const first = owner.registerPreview({ ...h.message, saveContext: 'first' }, h.sender);
  const second = owner.registerPreview({ ...h.message, requestId: 'second' }, h.sender);
  expect((await owner.submit({ ...first, saveContext: undefined, previewId: undefined }, h.sender)).status).toBe('rejected');
  expect((await owner.submit(second, h.sender)).status).toBe('completed'); expect(h.writes()).toBe(1);
});

it('projects every journal.put and raw IDB intent/receipt/cleanup onto durable fields', async () => {
  const h = await setup(); const factory = new IDBFactory();
  const store = new OperationsStore(factory, 'durable-envelope');
  const raw = async () => new Promise<unknown[]>(resolve => {
    const open = factory.open('durable-envelope');
    open.onsuccess = () => { const db = open.result; const tx = db.transaction('operations'); const read = tx.objectStore('operations').getAll(); tx.oncomplete = () => { db.close(); resolve(read.result); }; };
  });
  const records: Parameters<typeof store.put>[0][] = [];
  const journal = { all: () => store.all(), put: async (record: Parameters<typeof store.put>[0]) => {
    records.push(structuredClone(record)); await store.put(record);
    expect(JSON.stringify(await raw())).not.toMatch(/saveContext|previewId/);
  } };
  const owner = new MutationCoordinator(h.projection, h.writer, journal, 'test', () => true);
  const registered = owner.registerPreview({ ...h.message, requestId: crypto.randomUUID(), saveContext: 'transient-context' }, h.sender);
  expect((await owner.submit(registered, h.sender)).status).toBe('completed');
  expect(records.some(r => r.steps.some(s => s.state === 'intent'))).toBe(true);
  expect(records.some(r => r.steps.some(s => s.state === 'receipt'))).toBe(true);
  expect(JSON.stringify(records)).not.toMatch(/saveContext|previewId/);
  await store.cleanup(registered.requestId);
  expect(JSON.stringify(await raw())).not.toMatch(/saveContext|previewId/);
});

it.each(['completed', 'interrupted'] as const)('strips historical envelopes on read/rewrite and deduplicates %s after restart without native replay', async state => {
  const h = await setup(); const factory = new IDBFactory(); const name = 'historical-envelope';
  const store = new OperationsStore(factory, name);
  await h.coordinator.submit(h.message, h.sender);
  const record = (await h.store.all())[0]!;
  if (state === 'interrupted') { delete record.result; record.steps[0]!.state = 'intent'; delete record.steps[0]!.after; }
  const legacy = { ...record, request: { ...record.request, saveContext: 'old-context', previewId: 'old-preview', futureEnvelopeField: 'must-not-persist' } };
  // Seed raw historical bytes, bypassing today's schema and writer.
  await new Promise<void>(resolve => { const open = factory.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('operations', { keyPath: 'requestId' }); open.onsuccess = () => { const db = open.result; const tx = db.transaction('operations', 'readwrite'); tx.objectStore('operations').put(legacy); tx.oncomplete = () => { db.close(); resolve(); }; }; });
  const loaded = (await store.all())[0]!;
  expect(loaded.request).not.toHaveProperty('saveContext'); expect(loaded.request).not.toHaveProperty('previewId'); expect(loaded.request).not.toHaveProperty('futureEnvelopeField');
  expect(loaded.steps).toEqual(record.steps); expect(loaded.backup).toEqual(record.backup);
  const restarted = new MutationCoordinator(h.projection, h.writer, store, 'test');
  for (const envelope of [{}, { saveContext: 'expired-other', previewId: 'unregistered-other' }]) {
    expect((await restarted.submit({ ...h.message, ...envelope }, h.sender)).status).toBe(state === 'completed' ? 'completed' : 'unknown');
  }
  expect(h.writes()).toBe(1);
  if (state === 'completed') await store.cleanup(record.requestId);
  else await store.put(legacy);
  await new Promise<void>(resolve => { const open = factory.open(name); open.onsuccess = () => { const db = open.result; const tx = db.transaction('operations'); const read = tx.objectStore('operations').getAll(); tx.oncomplete = () => { expect(JSON.stringify(read.result)).not.toMatch(/saveContext|previewId|futureEnvelopeField/); expect(read.result).toHaveLength(1); db.close(); resolve(); }; }; });
});

it.each(['command', 'recovery-mode', 'recovery-source', 'recovery-conflicts'])('rejects requestId reuse with changed %s both in-worker and after restart/cleanup', async field => {
  const h = await setup(); await h.coordinator.submit(h.message, h.sender);
  const changed = structuredClone(h.message);
  if (field === 'command') changed.command.changes.title = 'Different';
  else Object.assign(changed, { recovery: { sourceRequestId: field === 'recovery-source' ? 'different' : 'source', mode: field === 'recovery-mode' ? 'copy' : 'undo', ...(field === 'recovery-conflicts' ? { conflicts: [{ nativeId: 'a', reason: 'changed' }] } : {}) } });
  for (const owner of [h.coordinator, new MutationCoordinator(h.projection, h.writer, h.store, 'test')]) {
    expect((await owner.submit(changed, h.sender)).reason).toBe('request-id-conflict');
  }
  await h.store.cleanup(h.message.requestId);
  const restarted = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  expect((await restarted.submit(changed, h.sender)).reason).toBe('request-id-conflict');
  expect((await restarted.submit(h.message, h.sender)).status).toBe('completed');
  expect(h.writes()).toBe(1);
});

it('checks volatile unknown semantics even when final checkpoint and subsequent journal reads fail', async () => {
  const h = await setup(); let unavailable = false;
  const journal = { all: async () => { if (unavailable) throw Error('offline'); return h.store.all(); }, put: async (record: Parameters<typeof h.store.put>[0]) => {
    if (record.result) { unavailable = true; throw Error('final-checkpoint'); }
    await h.store.put(record);
  } };
  const owner = new MutationCoordinator(h.projection, h.writer, journal, 'test');
  expect((await owner.submit(h.message, h.sender)).status).toBe('unknown');
  expect((await owner.submit({ ...h.message, command: { ...h.message.command, changes: { title: 'other' } } }, h.sender)).reason).toBe('request-id-conflict');
  expect((await owner.submit(h.message, h.sender)).status).toBe('unknown');
  expect(h.writes()).toBe(1);
});

it.each(['mode', 'sourceRequestId', 'conflicts'] as const)('compares retained historical recovery %s rather than transient authority', async field => {
  const h = await setup(); await h.coordinator.submit(h.message, h.sender);
  const record = (await h.store.all())[0]!;
  const recovery = { sourceRequestId: 'source', mode: 'undo' as const, conflicts: [{ nativeId: 'a', reason: 'later-edit' }] };
  record.request.recovery = recovery; await h.store.put(record);
  const owner = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  const changed = { ...recovery, ...(field === 'mode' ? { mode: 'copy' } : field === 'sourceRequestId' ? { sourceRequestId: 'other' } : { conflicts: [] }) };
  expect((await owner.submit({ ...h.message, recovery: changed }, h.sender)).reason).toBe('request-id-conflict');
  expect((await owner.submit({ ...h.message, recovery, saveContext: 'expired', previewId: 'expired' }, h.sender)).status).toBe('completed');
  expect((await owner.submit({ ...h.message, recovery: changed }, h.sender)).reason).toBe('request-id-conflict');
  expect(h.writes()).toBe(1);
});
