import { createExportProjection, type ExportScope } from './export-projection';
import type { TreeSnapshot } from './node-reference';

/** Bind selected and excluded folder ancestry, not names or an epoch that expires on restart. */
export function fileOutputAncestry(tree: TreeSnapshot, scope: ExportScope): string[][] {
  createExportProjection(tree, scope, new Date().toISOString());
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  return [...scope.roots, ...scope.excludedFolders].map(ref => {
    const path: string[] = []; let node = nodes.get(ref.nativeId);
    while (node) { path.push(node.ref.nativeId); node = node.parentId === undefined ? undefined : nodes.get(node.parentId); }
    return path;
  });
}
