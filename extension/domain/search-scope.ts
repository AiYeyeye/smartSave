import type { NodeRef, TreeSnapshot } from './node-reference';

/** Read scope only: managed folders are searchable even when they cannot accept writes. */
export function searchScope(tree: TreeSnapshot, folder?: NodeRef) {
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  const ancestorIds = new Set<string>();
  if (!folder) return { ids: new Set(nodes.keys()), ancestorIds };
  const root = nodes.get(folder.nativeId);
  if (
    folder.installationId !== tree.installationId ||
    folder.kind !== 'folder' ||
    root?.ref.kind !== 'folder' ||
    root.ref.installationId !== folder.installationId
  )
    throw Error('invalid-search-folder');
  let parent = root.parentId;
  while (parent !== undefined) {
    const node = nodes.get(parent);
    if (parent === folder.nativeId || ancestorIds.has(parent) || node?.ref.kind !== 'folder')
      throw Error('invalid-search-folder');
    ancestorIds.add(parent);
    parent = node.parentId;
  }
  const children = new Map<string, string[]>();
  for (const node of tree.nodes) {
    if (node.parentId === undefined) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.ref.nativeId);
    children.set(node.parentId, siblings);
  }
  const ids = new Set<string>();
  const pending = [folder.nativeId];
  while (pending.length) {
    const id = pending.pop()!;
    if (ids.has(id)) throw Error('invalid-search-folder');
    ids.add(id);
    if (nodes.get(id)?.ref.kind === 'folder') pending.push(...(children.get(id) ?? []));
  }
  return { ids, ancestorIds };
}

/** Native folder order and full labels, omitting only the browser's untitled container root. */
export function searchFolderOptions(tree: TreeSnapshot, rootLabel: string) {
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  const result: { ref: NodeRef; label: string }[] = [];
  const seen = new Set<string>();
  const pending = tree.roots.map(id => ({ id, path: '' })).reverse();
  while (pending.length) {
    const { id, path } = pending.pop()!;
    const node = nodes.get(id);
    if (seen.has(id) || node?.ref.kind !== 'folder') continue;
    seen.add(id);
    const hidden = tree.roots.length === 1 && !node.title && node.parentId === undefined && !node.childrenWritable;
    const label = hidden ? path : [path, node.title || rootLabel].filter(Boolean).join(' / ');
    if (!hidden) result.push({ ref: node.ref, label });
    for (const child of [...node.childrenIds].reverse()) pending.push({ id: child, path: label });
  }
  return result;
}
