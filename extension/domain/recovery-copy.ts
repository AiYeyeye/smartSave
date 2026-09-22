import type { OperationRecord } from '../persistence/operations';
import type { NodeRef, TreeSnapshot } from './node-reference';
import type { RecoveryPreview } from './recovery-preview';
import { validateUrl } from './preflight';
export function prepareRecoveryCopy(
  record: OperationRecord,
  tree: TreeSnapshot,
  destination: NodeRef,
  selectedNativeIds: string[],
): RecoveryPreview {
  const parent = tree.nodes.find(
    n =>
      n.ref.nativeId === destination.nativeId &&
      n.ref.installationId === destination.installationId &&
      n.ref.kind === destination.kind,
  );
  if (!parent?.childrenWritable) throw Error('invalid-copy-destination');
  const source = new Map((record.backup?.nodes ?? record.request.before).map(n => [n.ref.nativeId, n]));
  const preview: RecoveryPreview = {
    command: { type: 'batch', operations: [], selectedOperationIds: [] },
    conflicts: [],
  };
  const visited = new Set<string>();
  const append = (id: string, target: NodeRef, dependsOn: string[]) => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = source.get(id);
    if (!node) throw Error('missing-copy-source');
    if (node.url !== undefined) {
      try {
        validateUrl(node.url);
      } catch {
        preview.conflicts.push({ nativeId: id, reason: 'unsupported-recovery-url' });
        return;
      }
    }
    const operationId = `copy-${id}`;
    preview.command.operations.push({
      id: operationId,
      dependsOn,
      command: { type: 'create', parent: target, title: node.title, url: node.url },
    });
    preview.command.selectedOperationIds.push(operationId);
    const ref: NodeRef = {
      installationId: tree.installationId,
      nativeId: `$batch:${operationId}:$created`,
      kind: node.ref.kind,
    };
    node.childrenIds.forEach(child => append(child, ref, [operationId]));
  };
  const selected = new Set(selectedNativeIds);
  for (const id of selected) {
    let ancestor = source.get(id)?.parentId;
    let covered = false;
    while (ancestor) {
      if (selected.has(ancestor)) {
        covered = true;
        break;
      }
      ancestor = source.get(ancestor)?.parentId;
    }
    if (!covered) append(id, destination, []);
  }
  return preview;
}
