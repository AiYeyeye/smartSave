import { OrganizerAuthority } from '../background/organizer-authority';
import { SettingsStore } from '../persistence/settings';
import { afterEach, vi } from 'vitest';
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
  const factory = new IDBFactory();
  const store = new OperationsStore(factory);
  const coordinator = new MutationCoordinator(projection, writer, store, 'test');
  const snapshot = await projection.fresh();
  const message = { version: 1, type: 'confirmMutation', requestId: 'one', epoch: snapshot.epoch, installationId: snapshot.installationId, observedRevision: snapshot.observedRevision, scope: snapshot.nodes.find(n => n.ref.nativeId === 'bar')!.ref, before: snapshot.nodes, command: { type: 'update', target: snapshot.nodes.find(n => n.ref.nativeId === 'a')!.ref, changes: { title: 'New' } } };
  const sender = { id: 'test', url: 'chrome-extension://test/options/index.html' };
  return { factory, coordinator, message, sender, store, projection, writer, source, writes: () => writes, tree: () => tree, replace: (value: typeof tree) => { tree = value; } };
}
afterEach(() => vi.unstubAllGlobals());
async function authoritySetup(checkpoint = 0, change = 'settings') {
  const h = await setup();
  const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>();
  vi.stubGlobal('chrome', { storage: { onChanged: { addListener: (cb: (changes: Record<string, unknown>, area: string) => void) => listeners.add(cb), removeListener: (cb: (changes: Record<string, unknown>, area: string) => void) => listeners.delete(cb) } } });
  let revision = 'first'; let broken = false;
  const settings = new SettingsStore({ setAccessLevel: async () => {}, get: async () => {
    if (broken) throw Error('unavailable');
    return { modelSecurity: { version: 2, settings: { version: 1, revision, privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] } } } };
  }, set: async () => {}, remove: async () => {} });
  const authority = new OrganizerAuthority(settings, 'test');
  const token = await authority.open(h.sender);
  const invalidate = () => {
    if (change === 'disconnect') authority.close(token);
    else if (change === 'error') broken = true;
    else if (change === 'unrelated') listeners.forEach(cb => cb({ expansion: {}, siteRules: {} }, 'local'));
    else { revision = 'second'; listeners.forEach(cb => cb({ modelSecurity: {} }, 'local')); }
  };
  let puts = 0;
  const journal = { all: () => h.store.all(), put: async (record: Parameters<typeof h.store.put>[0]) => { await h.store.put(record); if (++puts === checkpoint) invalidate(); } };
  const coordinator = new MutationCoordinator(h.projection, h.writer, journal, 'test', undefined, authority);
  const request = await coordinator.registerOrganizerPreview({ ...h.message, organizerContext: token }, h.sender);
  return { ...h, coordinator, authority, token, request, invalidate };
}
it.each([1, 2])('settings change during backup/intent checkpoint %s prevents first native call', async checkpoint => {
  const h = await authoritySetup(checkpoint);
  expect((await h.coordinator.submit(h.request, h.sender)).status).toBe('failed');
  expect(h.writes()).toBe(0);
});
it.each(['disconnect', 'error'])('fails closed during intent: %s', async change => {
  const h = await authoritySetup(2, change);
  expect((await h.coordinator.submit(h.request, h.sender)).status).toBe('failed'); expect(h.writes()).toBe(0);
});
it.each(['unchanged', 'unrelated'])('allows %s authority, strips transient data, never replays after restart', async change => {
  const h = await authoritySetup(change === 'unrelated' ? 2 : 0, change);
  expect((await h.coordinator.submit(h.request, h.sender)).status).toBe('completed');
  const records = await new Promise<unknown[]>(resolve => {
    const open = h.factory.open('zhilan-operations');
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction('operations').objectStore('operations').getAll();
      read.onsuccess = () => { resolve(read.result); db.close(); };
    };
  });
  expect(JSON.stringify(records)).not.toContain(h.token);
  expect(JSON.stringify(records)).not.toContain('organizerContext');
  expect(JSON.stringify(records)).not.toContain('previewId');
  h.authority.close(h.token);
  const restored = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  expect((await restored.submit(h.request, h.sender)).status).toBe('completed'); expect(h.writes()).toBe(1);
});
it('rejects unknown leases, disconnected queue authority and altered frozen commands', async () => {
  const h = await authoritySetup();
  await expect(h.coordinator.registerOrganizerPreview({ ...h.message, requestId: 'bad', organizerContext: 'unknown' }, h.sender)).rejects.toThrow();
  expect((await h.coordinator.submit({ ...h.request, command: { ...h.request.command, changes: { title: 'Altered' } } }, h.sender)).status).toBe('rejected');
  h.invalidate();
  expect((await h.coordinator.submit(h.request, h.sender)).status).toBe('rejected'); expect(h.writes()).toBe(0);
});

it('observed invalidation in the last tree await is caught synchronously', async () => {
  const h = await authoritySetup();
  const fresh = h.projection.fresh.bind(h.projection);
  let reads = 0;
  vi.spyOn(h.projection, 'fresh').mockImplementation(async () => {
    const tree = await fresh();
    if (++reads === 4) h.invalidate();
    return tree;
  });
  expect((await h.coordinator.submit(h.request, h.sender)).status).toBe('failed');
  expect(reads).toBe(4); expect(h.writes()).toBe(0);
});
it('restart drops unexecuted authority and interrupted records never replay', async () => {
  const h = await authoritySetup();
  const restored = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  expect((await restored.submit(h.request, h.sender)).status).toBe('rejected');
  await h.coordinator.submit(h.request, h.sender);
  const record = (await h.store.all())[0]!;
  if (record.schemaVersion !== 2) throw Error('v2-record-expected');
  delete record.result;
  record.steps[0]!.state = 'intent';
  delete record.steps[0]!.afterDigest; delete record.steps[0]!.touched; delete record.final;
  await h.store.put(record);
  const restarted = new MutationCoordinator(h.projection, h.writer, h.store, 'test');
  expect((await restarted.submit(h.request, h.sender)).status).toBe('unknown');
  expect(h.writes()).toBe(1);
});
