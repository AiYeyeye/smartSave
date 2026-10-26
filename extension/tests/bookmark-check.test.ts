import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  bookmarkCheckMessageSchema,
  bookmarkCheckResponseSchema,
  checkScopeNodes,
  checkedDuplicateDeletions,
  compileCheckDeletion,
  currentCheckResults,
  emptyBookmarkCheck,
  linkCategory,
  type BookmarkCheckState,
} from '../domain/bookmark-check';
import { groupDuplicateNodes } from '../domain/suspected-duplicates';
import { preflight } from '../domain/preflight';
import { BookmarkCheckStore } from '../persistence/bookmark-check';
import { organizerTree } from './fixtures/organizer-tree';

it('validates restart scope and an optional worker owner identity without accepting arbitrary URLs', () => {
  const restart = { type: 'bookmarkCheck', action: 'restart', installationId: 'install', scopeId: null };
  expect(bookmarkCheckMessageSchema.parse(restart)).toEqual(restart);
  expect(bookmarkCheckMessageSchema.safeParse({ ...restart, url: 'https://foreign.test/' }).success).toBe(false);
  expect(bookmarkCheckMessageSchema.safeParse({ ...restart, installationId: '' }).success).toBe(false);
  const response = { status: 'ok', state: emptyBookmarkCheck() };
  expect(bookmarkCheckResponseSchema.parse(response)).toEqual(response);
  expect(bookmarkCheckResponseSchema.parse({ ...response, ownerId: 'new-worker' })).toMatchObject({
    ownerId: 'new-worker',
  });
  expect(bookmarkCheckResponseSchema.safeParse({ ...response, ownerId: '' }).success).toBe(false);
});

it('checks across protected roots without granting deletion authority to folders', () => {
  const tree = organizerTree(),
    original = structuredClone(tree);
  expect(checkScopeNodes(tree, null).map(n => n.ref.nativeId)).toEqual(['a', 'b', 'c']);
  expect(checkScopeNodes(tree, 'bar').map(n => n.ref.nativeId)).toEqual(['a', 'b']);
  expect(groupDuplicateNodes(checkScopeNodes(tree, null))[0]!.items).toHaveLength(3);
  expect(() => checkedDuplicateDeletions(checkScopeNodes(tree, null), { b: 'delete' })).toThrow('keep-required');
  expect(() => checkedDuplicateDeletions(checkScopeNodes(tree, 'bar'), { a: 'keep', c: 'delete' })).toThrow(
    'stale-selection',
  );
  const ids = checkedDuplicateDeletions(checkScopeNodes(tree, null), { a: 'keep', b: 'delete', c: 'delete' });
  const request = compileCheckDeletion(tree, null, ids);
  expect(request.scope.nativeId).toBe('0');
  expect(preflight(request, tree).steps).toEqual([
    { type: 'remove', id: 'b' },
    { type: 'remove', id: 'c' },
  ]);
  expect(request.before.find(n => n.ref.nativeId === 'b')?.url).toBe('https://x.test/?a#b');
  expect(tree).toEqual(original);
  for (const ids of [['bar'], ['missing'], ['a', 'a']]) expect(() => compileCheckDeletion(tree, null, ids)).toThrow();
  expect(() => compileCheckDeletion(tree, 'bar', ['c'])).toThrow();
  tree.nodes.find(n => n.ref.nativeId === 'b')!.readOnly = true;
  expect(() => compileCheckDeletion(tree, null, ['b'])).toThrow();
  expect(() => preflight(request, tree)).toThrow();
});

it('binds results to installation, current native identity and original URL', () => {
  const tree = organizerTree();
  const state = emptyBookmarkCheck();
  state.job = {
    id: 'job',
    installationId: 'install',
    scopeId: null,
    status: 'completed',
    startedAt: 1,
    updatedAt: 1,
    duplicateGroups: 1,
    items: [
      { nativeId: 'a', url: 'https://x.test/?a#b', result: { status: 'broken', reason: 'http', code: 404, at: 1 } },
    ],
  };
  expect(currentCheckResults(tree, state).size).toBe(1);
  tree.nodes.find(n => n.ref.nativeId === 'a')!.url += 'changed';
  expect(currentCheckResults(tree, state).size).toBe(0);
  expect(currentCheckResults({ ...organizerTree(), installationId: 'other' }, state).size).toBe(0);
});

it('persists local settings/results through new store instances and rejects malformed storage', async () => {
  const factory = new IDBFactory(),
    store = new BookmarkCheckStore(factory);
  const state = { ...emptyBookmarkCheck(), revision: 2, weekly: true, nextRun: 100 };
  expect(await store.read()).toEqual(emptyBookmarkCheck());
  await store.write(state);
  expect(await new BookmarkCheckStore(factory).read()).toEqual(state);
  const db = await new Promise<IDBDatabase>(resolve => {
    const q = factory.open('zhilan-bookmark-check');
    q.onsuccess = () => resolve(q.result);
  });
  await new Promise<void>(resolve => {
    const tx = db.transaction('state', 'readwrite');
    tx.objectStore('state').put({ version: 999 }, 'current');
    tx.oncomplete = () => resolve();
  });
  await expect(store.read()).rejects.toThrow('storage-invalid');
  db.close();
});

it('legacy page failures never become site failures, and live HTTP evidence outweighs same-origin network failures', async () => {
  expect(linkCategory({ status: 'broken', reason: 'http', code: 404, at: 1 })).toBe('missing');
  expect(linkCategory({ status: 'review', reason: 'timeout', at: 1 })).toBe('unknown');
  const tree = organizerTree();
  const state: BookmarkCheckState = {
    ...emptyBookmarkCheck(),
    job: {
      id: 'job',
      installationId: 'install',
      scopeId: null,
      status: 'completed',
      startedAt: 1,
      updatedAt: 2,
      duplicateGroups: 1,
      items: [
        {
          nativeId: 'a',
          url: 'https://x.test/?a#b',
          result: {
            status: 'review',
            reason: 'network',
            at: 1,
            site: { status: 'unreachable', reason: 'network', at: 1 },
          },
        },
        { nativeId: 'b', url: 'https://x.test/?a#b', result: { status: 'ok', reason: 'http', code: 200, at: 2 } },
      ],
    },
  };
  const store = new BookmarkCheckStore(new IDBFactory());
  await store.write(state);
  expect(linkCategory(currentCheckResults(tree, await store.read()).get('a')!)).toBe('temporary');
  tree.nodes.find(node => node.ref.nativeId === 'b')!.url = 'https://different.test/';
  expect(linkCategory(currentCheckResults(tree, state).get('a')!)).toBe('site');
  state.job!.items[1]!.result = { status: 'ok', reason: 'manual', at: 2 };
  expect(linkCategory(currentCheckResults(organizerTree(), state).get('a')!)).toBe('site');
});
