import { expect, it } from 'vitest';
import { dependencyDigest } from '../domain/context-dependencies';
import { organizerTree } from './fixtures/organizer-tree';

const folders = { task: 'organize' as const, rootId: 'bar', itemIds: [], folderIds: [], stage: 'folders' as const };
const batch = { ...folders, stage: 'bookmarks' as const, itemIds: ['a'] };
const everything = { task: 'organize' as const, rootId: 'bar', itemIds: [], folderIds: [] };

/** A bookmark saved into the scope while a long organize call runs (e.g. by auto-classify). */
function withNewBookmark() {
  const tree = organizerTree();
  const a = tree.nodes.find(n => n.ref.nativeId === 'a')!;
  tree.nodes.push({ ...structuredClone(a), ref: { ...a.ref, nativeId: 'new' }, parentId: 'right', title: 'new' });
  tree.nodes.find(n => n.ref.nativeId === 'right')!.childrenIds.push('new');
  return tree;
}

it('ignores bookmarks saved into the scope for the folder stage and other batches', () => {
  const before = organizerTree(),
    after = withNewBookmark();
  expect(dependencyDigest(after, folders)).toBe(dependencyDigest(before, folders));
  expect(dependencyDigest(after, batch)).toBe(dependencyDigest(before, batch));
  // Unstaged requests and duplicate scans still cover every node.
  expect(dependencyDigest(after, everything)).not.toBe(dependencyDigest(before, everything));
});

it('still voids a run when a folder or a bookmark of the batch changes', () => {
  const before = organizerTree();
  const renamed = organizerTree();
  renamed.nodes.find(n => n.ref.nativeId === 'right')!.title = 'renamed';
  expect(dependencyDigest(renamed, folders)).not.toBe(dependencyDigest(before, folders));
  const moved = organizerTree();
  moved.nodes.find(n => n.ref.nativeId === 'a')!.parentId = 'right';
  expect(dependencyDigest(moved, batch)).not.toBe(dependencyDigest(before, batch));
  expect(dependencyDigest(moved, folders)).toBe(dependencyDigest(before, folders));
});
