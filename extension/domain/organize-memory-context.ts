import type { OrganizeCheckpoint } from './organize-checkpoint';
import type { TreeSnapshot } from './node-reference';
import { scopeNodes } from './organize-proposal';

/** New protection affects the retained scope or its ancestor path; unrelated preferences do not stale a task. */
export function organizeProtectionChanged(checkpoint: OrganizeCheckpoint, tree: TreeSnapshot, protectedIds: string[]) {
  const covered = new Set(scopeNodes(tree, checkpoint.root.nativeId).map(node => node.ref.nativeId));
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  let parentId = nodes.get(checkpoint.root.nativeId)?.parentId;
  while (parentId && !covered.has(parentId)) {
    covered.add(parentId);
    parentId = nodes.get(parentId)?.parentId;
  }
  return protectedIds.some(
    id =>
      covered.has(id) && nodes.get(id)?.ref.kind === 'folder' && !checkpoint.options.protectedFolderIds?.includes(id),
  );
}
