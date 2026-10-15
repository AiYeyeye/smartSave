import type { ExportScope } from './export-projection';
import type { TreeSnapshot } from './node-reference';

/** Selection units are bookmarks and empty folders. Ancestors only preserve their displayed hierarchy. */
export function exportSelection(tree: TreeSnapshot, scope: ExportScope) {
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  const matches = (refs: ExportScope['roots']) =>
    new Set(
      refs
        .filter(ref => {
          const node = nodes.get(ref.nativeId);
          return node?.ref.kind === ref.kind && ref.installationId === tree.installationId;
        })
        .map(ref => ref.nativeId),
    );
  const roots = matches(scope.roots);
  const excluded = matches([...scope.excludedFolders, ...(scope.excludedBookmarks ?? [])]);
  const selected = new Set<string>();
  const pending = tree.roots.map(id => ({ id, included: false, excluded: false }));
  const seen = new Set<string>();
  while (pending.length) {
    const entry = pending.pop()!;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const node = nodes.get(entry.id);
    if (!node) continue;
    const blocked = entry.excluded || excluded.has(entry.id);
    const included = !blocked && (entry.included || roots.has(entry.id));
    if (included && !node.childrenIds.length) selected.add(entry.id);
    node.childrenIds.forEach(id => pending.push({ id, included, excluded: blocked }));
  }
  return selected;
}

/** Compile leaf choices to existing folder roots plus branch/leaf exclusions; public v1 roots stay folders. */
export function toggleExportSelection(
  tree: TreeSnapshot,
  scope: ExportScope,
  id: string,
  checked: boolean,
): ExportScope {
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  const selected = exportSelection(tree, scope);
  const pending = [id];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const node = nodes.get(current);
    if (!node) continue;
    if (!node.childrenIds.length) {
      if (checked) selected.add(current);
      else selected.delete(current);
    }
    pending.push(...node.childrenIds);
  }
  const included = new Set(selected);
  for (const leaf of selected) {
    let parent = nodes.get(leaf)?.parentId;
    while (parent !== undefined && !included.has(parent)) {
      included.add(parent);
      parent = nodes.get(parent)?.parentId;
    }
  }
  const roots: ExportScope['roots'][number][] = [];
  const excludedFolders: ExportScope['roots'][number][] = [];
  const excludedBookmarks: ExportScope['roots'][number][] = [];
  for (const node of tree.nodes) {
    if (node.parentId === undefined) continue;
    if (included.has(node.ref.nativeId) && nodes.get(node.parentId)?.parentId === undefined) roots.push(node.ref);
    else if (!included.has(node.ref.nativeId) && included.has(node.parentId)) {
      (node.ref.kind === 'folder' ? excludedFolders : excludedBookmarks).push(node.ref);
    }
  }
  return { roots, excludedFolders, ...(excludedBookmarks.length ? { excludedBookmarks } : {}) };
}
