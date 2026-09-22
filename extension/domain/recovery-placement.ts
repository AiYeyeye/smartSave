import type { NodeRef, TreeSnapshot } from './node-reference';
import type { SnapshotNode } from './single-plan';
import { planBatch } from './batch-plan';
import type { RecoveryPreview } from './recovery-preview';

type InverseMove = { id: string; target: NodeRef; parent: NodeRef; before: SnapshotNode; dependsOn: string[] };

/** Propose only uniquely evidenced slots; execution/preflight remain with the batch owner. */
export function placeRecoveryMoves(
  preview: RecoveryPreview,
  tree: TreeSnapshot,
  moves: InverseMove[],
  backup: SnapshotNode[],
  aliases: Map<string, NodeRef> = new Map(),
) {
  const scope = tree.nodes.find(n => n.parentId === undefined && n.ref.kind === 'folder')!.ref;
  const simulate = () =>
    planBatch(
      {
        version: 1,
        type: 'confirmMutation',
        requestId: 'recovery-placement',
        installationId: tree.installationId,
        epoch: tree.epoch,
        observedRevision: tree.observedRevision,
        scope,
        before: tree.nodes,
        command: preview.command,
      },
      tree,
    );
  let plan = simulate();
  const groups = new Map<string, InverseMove[]>();
  for (const move of moves) groups.set(move.parent.nativeId, [...(groups.get(move.parent.nativeId) ?? []), move]);
  for (const [parentId, group] of groups) {
    const original = backup
      .find(n => n.ref.nativeId === group[0]!.before.parentId)
      ?.childrenIds.map(id => aliases.get(id)?.nativeId ?? id);
    const fail = (move: InverseMove) =>
      preview.conflicts.push({ nativeId: move.target.nativeId, reason: 'placement-conflict' });
    if (
      !original ||
      new Set(original).size !== original.length ||
      group.some(m => original[m.before.index] !== m.target.nativeId)
    ) {
      group.forEach(fail);
      continue;
    }
    group.sort((a, b) => original.indexOf(a.target.nativeId) - original.indexOf(b.target.nativeId));
    let previous: string | undefined;
    for (const move of group) {
      const parent = plan.simulated.nodes.find(n => n.ref.nativeId === parentId);
      const children = parent?.childrenIds.filter(id => id !== move.target.nativeId);
      if (!children) {
        fail(move);
        continue;
      }
      const known = children.filter(id => original.includes(id));
      if (known.some((id, i) => i > 0 && original.indexOf(known[i - 1]!) > original.indexOf(id))) {
        fail(move);
        continue;
      }
      const rank = original.indexOf(move.target.nativeId);
      const left = known.filter(id => original.indexOf(id) < rank).at(-1);
      const right = known.find(id => original.indexOf(id) > rank);
      const lower = left === undefined ? 0 : children.indexOf(left) + 1;
      const upper = right === undefined ? children.length : children.indexOf(right);
      // New unrelated nodes inside the historical interval make placement ambiguous.
      if (
        lower !== upper ||
        (known.length === 0 &&
          original.some(id => id !== move.target.nativeId && !group.some(m => m.target.nativeId === id)))
      ) {
        fail(move);
        continue;
      }
      const anchorDependencies = [left, right].flatMap(id => {
        const owner = id === undefined ? undefined : plan.temporaryOwners.get(id);
        return owner ? [owner] : [];
      });
      const dependsOn = [...new Set([...move.dependsOn, ...anchorDependencies, ...(previous ? [previous] : [])])];
      preview.command.operations.push({
        id: move.id,
        dependsOn,
        command: { type: 'move', target: move.target, parent: move.parent, index: lower },
      });
      preview.command.selectedOperationIds.push(move.id);
      plan = simulate();
      previous = move.id;
    }
  }
}
