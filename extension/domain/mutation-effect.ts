import type { TreeSnapshot } from './node-reference';
import type { OperationRecord } from '../persistence/operation-schema';
import { sameNode, type SnapshotNode, type Step } from './single-plan';
export type TouchedNode = SnapshotNode & { removed?: true };
export function sameTree(expected: SnapshotNode[], actual: SnapshotNode[]) {
  const byId = new Map(actual.map(n => [n.ref.nativeId, n]));
  return (
    expected.length === actual.length &&
    expected.every(n => {
      const current = byId.get(n.ref.nativeId);
      return current !== undefined && sameNode(n, current);
    })
  );
}
/** After-state subset that differs from before (created, edited, reindexed); removed nodes keep their before-state plus `removed`, so applyTouched(before, touched) reproduces after exactly. */
export function touchedNodes(before: SnapshotNode[], after: SnapshotNode[]): TouchedNode[] {
  const previous = new Map(before.map(n => [n.ref.nativeId, n]));
  const kept = new Set(after.map(n => n.ref.nativeId));
  return [
    ...after.filter(n => {
      const old = previous.get(n.ref.nativeId);
      return !old || !sameNode(old, n);
    }),
    ...before.filter(n => !kept.has(n.ref.nativeId)).map(n => ({ ...n, removed: true as const })),
  ];
}
export function applyTouched(before: SnapshotNode[], touched: TouchedNode[]): SnapshotNode[] {
  const nodes = new Map(before.map(n => [n.ref.nativeId, n]));
  for (const { removed, ...node } of touched) {
    if (removed) nodes.delete(node.ref.nativeId);
    else nodes.set(node.ref.nativeId, node);
  }
  return [...nodes.values()];
}
/** Order-independent SHA-256 over exactly the fields sameNode compares, so digest equality means sameTree without retaining the tree. */
export async function treeDigest(nodes: SnapshotNode[]): Promise<string> {
  const canonical = [...nodes]
    .sort((a, b) => (a.ref.nativeId < b.ref.nativeId ? -1 : a.ref.nativeId > b.ref.nativeId ? 1 : 0))
    .map(n => ({
      ref: { installationId: n.ref.installationId, nativeId: n.ref.nativeId, kind: n.ref.kind },
      parentId: n.parentId,
      index: n.index,
      title: n.title,
      url: n.url,
      childrenIds: n.childrenIds,
      readOnly: n.readOnly,
      childrenWritable: n.childrenWritable,
    }));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)))),
    b => b.toString(16).padStart(2, '0'),
  ).join('');
}
/** Tree after the last receipt: v1 retained it per step; v2 stores it once at completion, or replays touched deltas over the backup for interrupted batches. Empty once cleanup stripped the evidence. */
export function finalNodes(record: OperationRecord): SnapshotNode[] {
  if (record.schemaVersion === 1) return record.steps.filter(s => s.state === 'receipt').at(-1)?.after ?? [];
  if (record.final) return record.final.nodes;
  const receipts = record.steps.filter(s => s.state === 'receipt');
  return receipts.length && receipts.every(s => s.touched)
    ? receipts.reduce((nodes, s) => applyTouched(nodes, s.touched!), record.backup?.nodes ?? record.request.before)
    : [];
}
export function expectedAfter(
  before: TreeSnapshot,
  step: Step,
  returned?: chrome.bookmarks.BookmarkTreeNode,
): SnapshotNode[] {
  const nodes = structuredClone(before.nodes);
  const byId = new Map(nodes.map(n => [n.ref.nativeId, n]));
  const reindex = (parent: SnapshotNode) =>
    parent.childrenIds.forEach((id, index) => {
      byId.get(id)!.index = index;
    });
  if (step.type === 'create') {
    if (
      !returned ||
      byId.has(returned.id) ||
      returned.parentId !== step.parentId ||
      returned.title !== step.title ||
      returned.url !== step.url
    )
      throw Error('ambiguous-create');
    const parent = byId.get(step.parentId)!;
    const node: SnapshotNode = {
      ref: {
        installationId: before.installationId,
        nativeId: returned.id,
        kind: step.url === undefined ? 'folder' : 'bookmark',
      },
      parentId: step.parentId,
      index: parent.childrenIds.length,
      title: step.title,
      url: step.url,
      childrenIds: [],
      readOnly: false,
      childrenWritable: step.url === undefined,
      observedRevision: before.observedRevision,
    };
    if (returned.index !== undefined && returned.index !== node.index) throw Error('unexpected-index');
    parent.childrenIds.push(returned.id);
    nodes.push(node);
  } else {
    const node = byId.get(step.id)!;
    if (step.type === 'update') Object.assign(node, step.changes);
    else {
      const oldParent = byId.get(node.parentId!)!;
      oldParent.childrenIds = oldParent.childrenIds.filter(id => id !== step.id);
      reindex(oldParent);
      if (step.type === 'remove') return nodes.filter(n => n.ref.nativeId !== step.id);
      const parent = byId.get(step.parentId)!;
      node.parentId = step.parentId;
      parent.childrenIds.splice(Math.min(step.index, parent.childrenIds.length), 0, step.id);
      reindex(parent);
    }
    if (
      !returned ||
      returned.id !== step.id ||
      returned.parentId !== node.parentId ||
      returned.title !== node.title ||
      returned.url !== node.url ||
      (returned.index !== undefined && returned.index !== node.index)
    )
      throw Error('unexpected-receipt');
  }
  return nodes;
}
