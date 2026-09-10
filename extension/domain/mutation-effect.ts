import type { TreeSnapshot } from './node-reference';
import { sameNode, type SnapshotNode, type Step } from './single-plan';
export function sameTree(expected: SnapshotNode[], actual: SnapshotNode[]) {
  const byId = new Map(actual.map(n => [n.ref.nativeId, n]));
  return expected.length === actual.length && expected.every(n => { const current = byId.get(n.ref.nativeId); return current !== undefined && sameNode(n, current); });
}
export function expectedAfter(before: TreeSnapshot, step: Step, returned?: chrome.bookmarks.BookmarkTreeNode): SnapshotNode[] {
  const nodes = structuredClone(before.nodes);
  const byId = new Map(nodes.map(n => [n.ref.nativeId, n]));
  const reindex = (parent: SnapshotNode) => parent.childrenIds.forEach((id, index) => { byId.get(id)!.index = index; });
  if (step.type === 'create') {
    if (!returned || byId.has(returned.id) || returned.parentId !== step.parentId || returned.title !== step.title || returned.url !== step.url) throw Error('ambiguous-create');
    const parent = byId.get(step.parentId)!;
    const node: SnapshotNode = { ref: { installationId: before.installationId, nativeId: returned.id, kind: step.url === undefined ? 'folder' : 'bookmark' }, parentId: step.parentId, index: parent.childrenIds.length, title: step.title, url: step.url, childrenIds: [], readOnly: false, childrenWritable: step.url === undefined, observedRevision: before.observedRevision };
    if (returned.index !== undefined && returned.index !== node.index) throw Error('unexpected-index');
    parent.childrenIds.push(returned.id); nodes.push(node);
  } else {
    const node = byId.get(step.id)!;
    if (step.type === 'update') Object.assign(node, step.changes);
    else {
      const oldParent = byId.get(node.parentId!)!;
      oldParent.childrenIds = oldParent.childrenIds.filter(id => id !== step.id); reindex(oldParent);
      if (step.type === 'remove') return nodes.filter(n => n.ref.nativeId !== step.id);
      const parent = byId.get(step.parentId)!;
      node.parentId = step.parentId;
      parent.childrenIds.splice(Math.min(step.index, parent.childrenIds.length), 0, step.id); reindex(parent);
    }
    if ((!returned || returned.id !== step.id || returned.parentId !== node.parentId || returned.title !== node.title || returned.url !== node.url || (returned.index !== undefined && returned.index !== node.index))) throw Error('unexpected-receipt');
  }
  return nodes;
}

