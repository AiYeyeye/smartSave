import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { ImportCheckpointStore, type ImportCheckpoint } from '../persistence/import-checkpoints';
import { OperationsStore, operationRecord } from '../persistence/operations';
import { openOperationsDatabase } from '../persistence/operations-database';
import { parseImport } from '../import/parsers';
import { TreeProjection } from '../background/tree-projection';
import { MutationCoordinator } from '../background/mutation-coordinator';
import type { BookmarkWriter } from '../adapters/bookmarks-write';

function checkpoint(): ImportCheckpoint {
  return { schemaVersion: 1, id: 'import', revision: 0, installationId: 'install', root: { installationId: 'install', nativeId: 'bar', kind: 'folder' }, items: parseImport(new TextEncoder().encode('https://example.test/?a=1#中'), 'txt').items.map(item => ({ item, titleLocked: false })), diagnostics: [], classified: [], newFolders: [], phase: 'paused' };
}
async function rawDatabase(factory: IDBFactory, version: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('zhilan-operations', version);
    request.onupgradeneeded = () => request.result.createObjectStore('operations', { keyPath: 'requestId' });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
it('migrates seeded v1 evidence, then uses actual OperationsStore and coordinator without replay', async () => {
  const factory = new IDBFactory();
  const projection = new TreeProjection({ read: async () => [{ id: '0', title: '', syncing: false, children: [{ id: 'bar', parentId: '0', title: 'Bar', syncing: false, children: [] }] }], listen: () => () => {} }, async () => 'install', 'epoch');
  projection.start(); const tree = await projection.fresh();
  const request = { version: 1 as const, type: 'confirmMutation' as const, requestId: 'unknown', installationId: 'install', epoch: 'epoch', observedRevision: tree.observedRevision, scope: tree.nodes.find(n => n.ref.nativeId === 'bar')!.ref, before: tree.nodes, command: { type: 'create' as const, parent: tree.nodes.find(n => n.ref.nativeId === 'bar')!.ref, title: 'Unknown', url: 'https://unknown.test/' } };
  const record = operationRecord(request, [{ type: 'create', parentId: 'bar', title: 'Unknown', url: 'https://unknown.test/', temporaryId: '$created' }], tree.nodes);
  record.steps[0]!.state = 'intent';
  const db = await rawDatabase(factory, 1);
  await new Promise<void>((resolve, reject) => { const tx = db.transaction('operations', 'readwrite'); tx.objectStore('operations').put(record); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  const checkpoints = new ImportCheckpointStore(factory); await checkpoints.put(checkpoint(), null);
  const operations = new OperationsStore(factory);
  expect(await operations.all()).toEqual([record]);
  await operations.put(record); expect(await operations.all()).toEqual([record]);
  let writes = 0; const fail = async (): Promise<never> => { writes++; throw Error('must not issue'); };
  const writer: BookmarkWriter = { create: fail, update: fail, move: fail, remove: fail };
  const owner = new MutationCoordinator(projection, writer, operations, 'test');
  const sender = { id: 'test', url: 'chrome-extension://test/panel/index.html' };
  expect((await owner.submit(request, sender)).status).toBe('unknown');
  expect((await owner.submit({ version: 1, type: 'reconcileMutation', requestId: 'unknown' }, sender)).status).toBe('unknown');
  expect(writes).toBe(0); expect((await operations.all())[0]!.backup).toEqual(record.backup);
  expect(await checkpoints.all()).toEqual([checkpoint()]);
});
it('persists completed classifications across instances and atomically rejects stale page overwrites', async () => {
  const factory = new IDBFactory(); const store = new ImportCheckpointStore(factory); const initial = checkpoint();
  await store.put(initial, null);
  const next: ImportCheckpoint = { ...initial, revision: 1, classified: [{ sourceOrdinal: 0, title: '中', folderId: 'bar' }], phase: 'classified' };
  const results = await Promise.allSettled([store.put(next, 0), new ImportCheckpointStore(factory).put({ ...initial, revision: 1 }, 0)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(await new ImportCheckpointStore(factory).all()).toEqual([next]);
  await expect(store.put(initial, null)).rejects.toThrow('conflict');
});
it('refuses incomplete preview phases, locked AI title changes and secret or authority fields', async () => {
  const store = new ImportCheckpointStore(new IDBFactory()); const value = checkpoint();
  await expect(store.put({ ...value, phase: 'classified' }, null)).rejects.toThrow();
  const locked = { ...value, items: value.items.map(row => ({ ...row, titleLocked: true, item: { ...row.item, title: 'Original' } })), classified: [{ sourceOrdinal: 0, title: 'AI changed', folderId: 'bar' }] };
  await expect(store.put(locked, null)).rejects.toThrow();
  for (const field of ['apiKey', 'body', 'importContext', 'settings', 'previewId']) await expect(store.put(Object.assign({}, value, { [field]: 'forbidden' }), null)).rejects.toThrow();
  expect(await store.all()).toEqual([]);
});
it('keeps issued request identity and never permits restart to reset unknown work to classification', async () => {
  const factory = new IDBFactory(); const store = new ImportCheckpointStore(factory);
  const value: ImportCheckpoint = { ...checkpoint(), classified: [{ sourceOrdinal: 0, title: '', folderId: 'bar' }], phase: 'classified' };
  await store.put(value, null);
  await expect(store.put({ ...value, phase: 'applying', requestId: 'issued', revision: 1 }, 0)).rejects.toThrow('recovery-required');
  // Legacy raw applying evidence remains readable, never recreated by the new handoff API.
  const db = await openOperationsDatabase(factory);
  await new Promise<void>(resolve => { const tx = db.transaction('importCheckpoints', 'readwrite'); tx.objectStore('importCheckpoints').put({ ...value, phase: 'applying', requestId: 'issued', revision: 1 }); tx.oncomplete = () => resolve(); }); db.close();
  await expect(new ImportCheckpointStore(factory).put({ ...value, revision: 2 }, 1)).rejects.toThrow('recovery-required');
  await expect(store.put({ ...value, phase: 'finished', requestId: 'other', revision: 2 }, 1)).rejects.toThrow('recovery-required');
  const finished: ImportCheckpoint = { ...value, phase: 'finished', requestId: 'issued', revision: 2 };
  for (const altered of [
    { ...finished, root: { ...finished.root, nativeId: 'other' } },
    { ...finished, classified: [{ sourceOrdinal: 0, title: 'changed', folderId: 'bar' }] },
    { ...finished, items: finished.items.map(row => ({ ...row, item: { ...row.item, rawURL: 'https://changed.test/' } })) },
    { ...finished, newFolders: [{ id: 'extra', parentId: 'bar', title: 'Extra' }] },
    finished,
  ]) await expect(store.put(altered, 1)).rejects.toThrow('recovery-required');
  expect((await store.all())[0]).toMatchObject({ phase: 'applying', requestId: 'issued', revision: 1 });
});
it('rejects future database versions without deleting or upgrading their records', async () => {
  const factory = new IDBFactory(); const db = await rawDatabase(factory, 4); db.close();
  await expect(openOperationsDatabase(factory)).rejects.toThrow('unsupported-journal');
  await expect(new OperationsStore(factory).all()).rejects.toThrow('unsupported-journal');
  await expect(new ImportCheckpointStore(factory).all()).rejects.toThrow('unsupported-journal');
  const unchanged = await rawDatabase(factory, 4); expect(unchanged.version).toBe(4); expect([...unchanged.objectStoreNames]).toEqual(['operations']); unchanged.close();
});
