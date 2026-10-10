import type { TreeSnapshot } from './node-reference';

export type NewFolder = { id: string; parentId: string; title: string };

export type NativeSavePlan =
  | { status: 'noop'; reason: 'already-there' | 'same-parent' }
  | { status: 'invalid'; reason: string }
  | {
      status: 'apply';
      /** Existing writable folder under which any new folders are created (in order). */
      anchorParentId: string;
      /** Folder titles to create under anchorParentId, root-first. */
      createTitles: string[];
      /** Final destination folder id once creates resolve (existing id when createTitles empty). */
      destinationFolderId: string;
      bookmarkId: string;
    };

/**
 * Resolve a TASKS.save model assignment into create-folder + move steps for an already-native bookmark.
 * Does not rename; never changes URL. Reuses the same newFolders chain walk as panel saveSuggestionPath.
 */
export function planNativeSaveApply(
  tree: TreeSnapshot,
  bookmarkId: string,
  folderId: string,
  newFolders: NewFolder[],
): NativeSavePlan {
  const bookmark = tree.nodes.find(n => n.ref.nativeId === bookmarkId && n.ref.kind === 'bookmark');
  if (!bookmark?.url) return { status: 'invalid', reason: 'missing-bookmark' };

  const proposed = new Map(newFolders.map(f => [f.id, f]));
  if (proposed.size !== newFolders.length) return { status: 'invalid', reason: 'duplicate-new-folder' };
  if (newFolders.some(f => tree.nodes.some(n => n.ref.nativeId === f.id)))
    return { status: 'invalid', reason: 'new-folder-collides' };

  const titles: string[] = [];
  const seen = new Set<string>();
  let cursor = folderId;
  while (proposed.has(cursor)) {
    if (seen.has(cursor)) return { status: 'invalid', reason: 'cycle' };
    seen.add(cursor);
    const folder = proposed.get(cursor)!;
    if (!folder.title.trim()) return { status: 'invalid', reason: 'empty-title' };
    titles.unshift(folder.title);
    cursor = folder.parentId;
  }

  const anchor = tree.nodes.find(n => n.ref.nativeId === cursor && n.childrenWritable);
  if (!anchor) return { status: 'invalid', reason: 'invalid-anchor' };

  const destinationFolderId = titles.length ? folderId : cursor;
  if (!titles.length) {
    const dest = tree.nodes.find(n => n.ref.nativeId === destinationFolderId && n.childrenWritable);
    if (!dest) return { status: 'invalid', reason: 'invalid-destination' };
    if (bookmark.parentId === destinationFolderId) return { status: 'noop', reason: 'already-there' };
  }

  return {
    status: 'apply',
    anchorParentId: anchor.ref.nativeId,
    createTitles: titles,
    destinationFolderId,
    bookmarkId,
  };
}
