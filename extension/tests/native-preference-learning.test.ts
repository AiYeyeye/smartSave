import { expect, it, vi } from 'vitest';
import {
  startNativePreferenceLearning,
  type MoveInfo,
  type ChangeInfo,
} from '../background/native-preference-learning';
import { OwnWriteGuard } from '../background/own-write-guard';
import { organizerTree } from './fixtures/organizer-tree';
import type { BookmarkWriter } from '../adapters/bookmarks-write';

function event<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>();
  return {
    addListener: (fn: (...args: Args) => void) => {
      listeners.add(fn);
    },
    removeListener: (fn: (...args: Args) => void) => {
      listeners.delete(fn);
    },
    emit: (...args: Args) => listeners.forEach(fn => fn(...args)),
  };
}
function harness(cold = false) {
  const tree = organizerTree(),
    before = structuredClone(tree);
  const bookmarks = {
    onMoved: event<[string, MoveInfo]>(),
    onChanged: event<[string, ChangeInfo]>(),
    onImportBegan: event<[]>(),
    onImportEnded: event<[]>(),
  };
  const guard = new OwnWriteGuard();
  const learn = vi.fn(async () => {});
  const privacy = { fullUrl: false, bodyEnabled: false, excludedFolders: [] as (typeof tree.nodes)[number]['ref'][] };
  const stop = startNativePreferenceLearning({
    bookmarks,
    guard,
    learn,
    settings: {
      snapshot: async () => ({ version: 1, revision: '', sessionRevision: 0, key: '', privacy }),
      subscribe: () => () => {},
    },
    projection: {
      subscribe: listener => {
        if (!cold) listener({ status: 'ready', snapshot: before });
        return () => {};
      },
      fresh: async () => structuredClone(tree),
    },
  });
  const move = () => {
    tree.nodes.find(node => node.ref.nativeId === 'a')!.parentId = 'right';
    bookmarks.onMoved.emit('a', { oldParentId: 'left', parentId: 'right', index: 0, oldIndex: 0 });
  };
  return { tree, bookmarks, guard, learn, privacy, stop, move };
}
it('records native manager moves and title changes, including cold-start destination events', async () => {
  const h = harness(true);
  h.move();
  await vi.waitFor(() => expect(h.learn).toHaveBeenCalledTimes(1));
  expect(h.learn.mock.calls[0]).toMatchObject([
    expect.stringMatching(/^native:/),
    'install',
    [{ source: 'choice', scopes: ['search', 'organize', 'save', 'import'] }],
  ]);
  h.tree.nodes.find(node => node.ref.nativeId === 'a')!.title = 'Chosen title';
  h.bookmarks.onChanged.emit('a', { title: 'Chosen title' });
  await vi.waitFor(() => expect(h.learn).toHaveBeenCalledTimes(2));
  h.stop();
});
it('skips own writes but records a following manual edit immediately', async () => {
  const h = harness();
  const writer: BookmarkWriter = {
    move: async () => {
      h.move();
      return { id: 'a', parentId: 'right', index: 0, title: 'A', syncing: false };
    },
    update: async () => {
      throw Error('unused');
    },
    create: async () => {
      throw Error('unused');
    },
    remove: async () => {},
  };
  await h.guard.wrap(writer).move('a', { parentId: 'right', index: 0 });
  expect(h.learn).not.toHaveBeenCalled();
  h.tree.nodes.find(node => node.ref.nativeId === 'a')!.title = 'Manual title';
  h.bookmarks.onChanged.emit('a', { title: 'Manual title' });
  await vi.waitFor(() => expect(h.learn).toHaveBeenCalledTimes(1));
  h.stop();
});
it('does not learn imports, reorder-only, excluded old locations or stale events', async () => {
  const h = harness(true);
  h.bookmarks.onImportBegan.emit();
  h.move();
  h.bookmarks.onImportEnded.emit();
  h.bookmarks.onMoved.emit('a', { parentId: 'right', oldParentId: 'right', index: 1, oldIndex: 0 });
  h.privacy.excludedFolders.push(h.tree.nodes.find(node => node.ref.nativeId === 'left')!.ref);
  h.move();
  h.bookmarks.onChanged.emit('a', { title: 'Stale title' });
  // Drain the finite read/settings continuations without a timer-based race.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(h.learn).not.toHaveBeenCalled();
  h.stop();
});
