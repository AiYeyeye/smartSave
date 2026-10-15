import type { AiPrivacy, AiRequest } from './ai-payload';
import type { ModelConfig } from './model-route';
import type { TreeSnapshot } from './node-reference';

type Node = TreeSnapshot['nodes'][number];
type Projection =
  | { nativeId: string; parentId?: string; title: string; childrenWritable?: boolean; readOnly: boolean }
  | { nativeId: string; parentId?: string; title: string; url?: string }
  | { nativeId: string; missing: true };

/** Index, children order and observation clocks are not model inputs; only identity, placement, labels and protection are. */
function project(id: string, node: Node | undefined): Projection {
  if (!node) return { nativeId: id, missing: true };
  return node.ref.kind === 'folder'
    ? {
        nativeId: id,
        parentId: node.parentId,
        title: node.title,
        childrenWritable: node.childrenWritable,
        readOnly: node.readOnly,
      }
    : { nativeId: id, parentId: node.parentId, title: node.title, url: node.url };
}
function descends(nodes: Map<string, Node>, node: Node, rootId: string): boolean {
  const seen = new Set<string>();
  let cursor: Node | undefined = node;
  while (cursor && !seen.has(cursor.ref.nativeId)) {
    if (cursor.ref.nativeId === rootId) return true;
    seen.add(cursor.ref.nativeId);
    cursor = cursor.parentId === undefined ? undefined : nodes.get(cursor.parentId);
  }
  return false;
}
/** Nodes a request depends on: save/import targets and offered folders, search candidates, the whole organize scope. */
export function dependencyIds(tree: TreeSnapshot, request: AiRequest): string[] {
  const ids = new Set<string>();
  switch (request.task) {
    case 'save':
      ids.add(request.targetId);
      request.folderIds.forEach(id => ids.add(id));
      if (request.item.source === 'bookmark') ids.add(request.item.id);
      break;
    case 'search': {
      request.itemIds.forEach(id => ids.add(id));
      request.folderIds.forEach(id => ids.add(id));
      // Folder paths are part of the semantic search input too.
      const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
      for (const id of [...ids]) {
        const seen = new Set<string>();
        let parent = nodes.get(id)?.parentId;
        while (parent !== undefined && !seen.has(parent)) {
          seen.add(parent);
          ids.add(parent);
          parent = nodes.get(parent)?.parentId;
        }
      }
      break;
    }
    case 'organize': {
      ids.add(request.rootId);
      const nodes = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
      for (const node of tree.nodes) if (descends(nodes, node, request.rootId)) ids.add(node.ref.nativeId);
      break;
    }
    default:
      ids.add(request.targetId);
      request.folderIds.forEach(id => ids.add(id));
  }
  return [...ids].sort();
}
/** Deterministic canonical JSON of the dependency projection; unrelated nodes never change it, deleted dependencies do. */
export function dependencyDigest(tree: TreeSnapshot, request: AiRequest): string {
  const nodes = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
  return JSON.stringify(dependencyIds(tree, request).map(id => project(id, nodes.get(id))));
}
/** Non-secret settings that shape a model call; the key is compared separately and never serialized. */
export function settingsIdentity(context: { config?: ModelConfig; privacy: AiPrivacy }): string {
  return JSON.stringify({ config: context.config, privacy: context.privacy });
}
