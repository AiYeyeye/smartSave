import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  organizeCheckpointSchema,
  interruptedOrganizeCheckpoint,
  type OrganizeCheckpoint,
} from '../domain/organize-checkpoint';
import { OrganizeCheckpointStore } from '../persistence/organize-checkpoints';
import { openOperationsDatabase } from '../persistence/operations-database';
import { organizerTree } from './fixtures/organizer-tree';

function checkpoint(): OrganizeCheckpoint {
  const baseline = organizerTree();
  return {
    schemaVersion: 1,
    id: 'organize-one',
    revision: 0,
    updatedAt: 1000,
    installationId: baseline.installationId,
    root: baseline.nodes.find(node => node.ref.nativeId === 'bar')!.ref,
    baseline,
    scopeDigest: 'a'.repeat(64),
    settingsDigest: 'b'.repeat(64),
    settingsRevision: 'settings-one',
    requiresCredential: true,
    preference: { style: 'topic', instructions: '' },
    options: { batchSize: 100 },
    stage: 'bookmarks',
    status: 'running',
    folderPlan: { output: { moves: [], newFolders: [], merges: [] }, selected: [], targets: {} },
    bookmarkIds: ['a', 'b'],
    selection: { selected: [], targets: {} },
    elapsedMs: 4000,
    batches: [
      { id: 'first', itemIds: ['a'], status: 'pending' },
      {
        id: 'second',
        itemIds: ['b'],
        status: 'accepted',
        output: { moves: [{ itemId: 'b', folderId: 'right' }], newFolders: [], merges: [] },
      },
    ],
  };
}

it('retains validated out-of-order progress over restart but never resumes a running call automatically', async () => {
  const factory = new IDBFactory();
  const store = new OrganizeCheckpointStore(factory);
  const value = checkpoint();
  await store.put(value, null);
  const restored = await new OrganizeCheckpointStore(factory).get(value.id);
  expect(restored).toEqual(value);
  expect(interruptedOrganizeCheckpoint(restored!)).toMatchObject({
    status: 'paused',
    elapsedMs: 4000,
    batches: value.batches,
  });
  expect(await store.list()).toEqual([expect.objectContaining({ id: value.id, readable: true, stage: 'bookmarks' })]);
  expect(JSON.stringify(await store.list())).not.toContain('https://');
});

it('uses strict revision CAS for competing pages and preserves immutable task context', async () => {
  const factory = new IDBFactory();
  const one = new OrganizeCheckpointStore(factory),
    two = new OrganizeCheckpointStore(factory);
  const value = checkpoint();
  await one.put(value, null);
  const next = { ...value, revision: 1, status: 'paused' as const };
  const results = await Promise.allSettled([one.put(next, 0), two.put(next, 0)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  await expect(one.put({ ...next, revision: 2, settingsDigest: 'c'.repeat(64) }, 1)).rejects.toThrow('context-changed');
  await expect(two.remove(value.id, 0)).rejects.toThrow('conflict');
  expect((await one.get(value.id))?.revision).toBe(1);
  await two.remove(value.id, 1);
  expect(await one.list()).toEqual([]);
});

it('rejects missing/duplicate/foreign batch membership and unvalidated or out-of-order merged outputs', () => {
  const value = checkpoint();
  for (const altered of [
    { ...value, batches: value.batches.slice(1) },
    { ...value, bookmarkIds: ['a', 'a'] },
    { ...value, batches: [value.batches[0], { ...value.batches[1], id: 'first' }] },
    { ...value, batches: [value.batches[0], { ...value.batches[1], status: 'merged' }] },
    { ...value, batches: [{ ...value.batches[0], status: 'accepted' }, value.batches[1]] },
    {
      ...value,
      batches: [
        value.batches[0],
        { ...value.batches[1], output: { ...value.batches[1]!.output, moves: [{ itemId: 'c', folderId: 'right' }] } },
      ],
    },
    { ...value, stage: 'complete' },
    { ...value, folderPlan: undefined },
    { ...value, options: { ...value.options, unfiledOnly: true } },
  ])
    expect(organizeCheckpointSchema.safeParse(altered).success).toBe(false);
});

it('rejects credentials, runtime authority and executable requests before any storage is opened', async () => {
  const factory = new IDBFactory(),
    store = new OrganizeCheckpointStore(factory);
  const value = checkpoint();
  for (const field of [
    'key',
    'config',
    'apiKey',
    'organizerContext',
    'previewId',
    'request',
    'requestId',
    'lease',
    'body',
  ])
    await expect(store.put(Object.assign({}, value, { [field]: 'forbidden-secret' }), null)).rejects.toThrow();
  const nested = { ...value, folderPlan: { ...value.folderPlan, key: 'forbidden-secret' } };
  expect(organizeCheckpointSchema.safeParse(nested).success).toBe(false);
  expect(await store.list()).toEqual([]);
});

it('adds the checkpoint store without altering older operation/import/file records and preserves unknown versions', async () => {
  const factory = new IDBFactory();
  await new Promise<void>((resolve, reject) => {
    const request = factory.open('migration', 3);
    request.onupgradeneeded = () => {
      for (const name of ['operations', 'importCheckpoints', 'fileOutput'])
        request.result.createObjectStore(name).put({ evidence: name }, 'old');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
  const db = await openOperationsDatabase(factory, 'migration');
  expect(db.version).toBe(4);
  for (const name of ['operations', 'importCheckpoints', 'fileOutput']) {
    const value = await new Promise(resolve => {
      const request = db.transaction(name).objectStore(name).get('old');
      request.onsuccess = () => resolve(request.result);
    });
    expect(value).toEqual({ evidence: name });
  }
  await new Promise<void>(resolve => {
    const tx = db.transaction('organizeCheckpoints', 'readwrite');
    tx.objectStore('organizeCheckpoints').put({ ...checkpoint(), schemaVersion: 99 });
    tx.oncomplete = () => resolve();
  });
  db.close();
  const store = new OrganizeCheckpointStore(factory, 'migration');
  expect(await store.list()).toEqual([expect.objectContaining({ readable: false, status: 'unknown' })]);
  await expect(store.get('organize-one')).rejects.toThrow('unsupported');
  await expect(store.put({ ...checkpoint(), revision: 1 }, 0)).rejects.toThrow('unsupported');
});
