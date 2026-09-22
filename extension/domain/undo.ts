import { placeRecoveryMoves } from './recovery-placement';
import { finalNodes } from './mutation-effect';
import type { OperationRecord } from '../persistence/operations';
import type { TreeSnapshot, NodeRef } from './node-reference';
import { sameNode, validateUrl, type SnapshotNode } from './preflight';
import type { z } from 'zod';
import type { singleCommandSchema } from '../schemas/messages';
import type { RecoveryPreview } from './recovery-preview';
type SingleCommand = z.infer<typeof singleCommandSchema>;

/** Recovery is a proposal only. Applying it always goes through normal confirmation/preflight. */
export function prepareRecovery(record: OperationRecord, tree: TreeSnapshot, mode: 'undo' | 'merge', history: OperationRecord[] = []): RecoveryPreview {
  const preview: RecoveryPreview = { command: { type: 'batch', operations: [], selectedOperationIds: [] }, conflicts: [] };
  const current = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
  const backup = record.backup?.nodes ?? record.request.before;
  const old = new Map(backup.map(n => [n.ref.nativeId, n]));
  const final = new Map(finalNodes(record).map(n => [n.ref.nativeId, n]));
  const priorRestorations = new Map<string, string>();
  for (const recovery of history) {
    if (recovery.request.recovery?.sourceRequestId !== record.requestId || recovery.request.recovery.mode === 'copy') continue;
    for (const [temporary, nativeId] of Object.entries(recovery.mapping)) {
      const match = /^\$batch:restore-(.*):\$created$/.exec(temporary);
      if (match) priorRestorations.set(match[1]!, nativeId);
    }
  }
  const matchesReceipt = (now: SnapshotNode, expected: SnapshotNode): boolean => {
    if (sameNode(now, expected)) {
      if (now.parentId === undefined) return true;
      const siblings = final.get(now.parentId)?.childrenIds;
      const present = current.get(now.parentId)?.childrenIds;
      if (!siblings || !present) return false;
      const survivors = siblings.filter(id => current.get(id)?.parentId === now.parentId);
      const known = present.filter(id => siblings.includes(id));
      return survivors.join('\0') === known.join('\0');
    }
    if (!sameNode({ ...now, index: expected.index }, expected) || now.parentId === undefined) return false;
    const beforeParent = final.get(now.parentId); const currentParent = current.get(now.parentId);
    if (!beforeParent || !currentParent || beforeParent.childrenIds[expected.index] !== now.ref.nativeId || currentParent.childrenIds[now.index] !== now.ref.nativeId) return false;
    // Only removal from the receipt's complete sibling sequence explains drift.
    // This is structural evidence, not proof against an edit followed by its reversal.
    const survivors = beforeParent.childrenIds.filter(id => current.get(id)?.parentId === now.parentId);
    return survivors.length === currentParent.childrenIds.length && survivors.every((id, index) => id === currentParent.childrenIds[index]);
  };
  const restored = new Map<string, NodeRef>();
  const conflict = (id: string, reason: string) => preview.conflicts.push({ nativeId: id, reason });
  const add = (id: string, command: SingleCommand, dependsOn: string[] = []) => { preview.command.operations.push({ id, command, dependsOn }); preview.command.selectedOperationIds.push(id); };
  const restore = (node: SnapshotNode): NodeRef | undefined => {
    const id = node.ref.nativeId;
    if (priorRestorations.has(id)) {
      const mapped = current.get(priorRestorations.get(id)!);
      if (!mapped) conflict(id, 'previous-restoration-later-deleted');
      return mapped?.ref;
    }
    if (restored.has(id)) return restored.get(id);
    if (current.has(id)) return current.get(id)!.ref;
    if (node.readOnly) { conflict(id, 'protected-or-missing-root'); return; }
    // Missing identity is not enough: require a durable deletion receipt from this lineage.
    if (!record.steps.some(s => s.step.type === 'remove' && s.step.id === id && s.state === 'receipt')) { conflict(id, 'missing-without-deletion-evidence'); return; }
    const parent = node.parentId === undefined ? undefined : current.get(node.parentId)?.ref ?? (old.has(node.parentId) ? restore(old.get(node.parentId)!) : undefined);
    if (!parent) { conflict(id, 'parent-unavailable'); return; }
    if (node.url !== undefined && tree.nodes.some(n => n.url === node.url)) { conflict(id, 'same-url-is-not-identity-review-required'); return; }
    if (node.url !== undefined) {
      try { validateUrl(node.url); } catch { conflict(id, 'unsupported-recovery-url'); return; }
    }
    const operationId = `restore-${id}`;
    const parentOperation = node.parentId && restored.has(node.parentId) ? `restore-${node.parentId}` : undefined;
    add(operationId, { type: 'create', parent, title: node.title, url: node.url }, parentOperation ? [parentOperation] : []);
    const ref: NodeRef = { installationId: tree.installationId, nativeId: `$batch:${operationId}:$created`, kind: node.ref.kind };
    restored.set(id, ref); return ref;
  };
  if (record.request.installationId !== tree.installationId) {
    backup.forEach(n => conflict(n.ref.nativeId, 'different-lineage-requires-explicit-copy-destination'));
    return preview;
  }
  if (mode === 'merge') {
    for (const n of backup) {
      const now = current.get(n.ref.nativeId);
      if (now) { if (!sameNode(n, now)) conflict(n.ref.nativeId, 'current-content-preserved'); }
      else restore(n);
    }
    return preview;
  }
  const moves: Parameters<typeof placeRecoveryMoves>[2] = [];
  const handled = new Set<string>();
  for (const entry of [...record.steps].reverse()) {
    const step = entry.step;
    const id = step.type === 'create' ? entry.returnedNativeId : step.id;
    if (!id || handled.has(id)) continue;
    handled.add(id);
    if (entry.state !== 'receipt') { conflict(id, 'operation-not-proven'); continue; }
    if (step.type === 'remove') { const node = old.get(id); if (node && !current.has(id)) restore(node); else conflict(id, 'deleted-identity-now-present'); continue; }
    const now = current.get(id); const expected = final.get(id);
    if (!now || !expected || !matchesReceipt(now, expected)) { conflict(id, 'later-change-or-missing'); continue; }
    if (step.type === 'create') {
      // Never remove a directory containing data, even if its own create receipt was valid.
      const dependencies = now.childrenIds.map(child => `undo-${child}`);
      if (dependencies.some(dependency => !preview.command.operations.some(o => o.id === dependency && o.command.type === 'remove'))) { conflict(id, 'created-folder-not-empty'); continue; }
      add(`undo-${id}`, { type: 'remove', target: now.ref }, dependencies);
    } else {
      const before = old.get(id);
      if (!before) { conflict(id, 'before-unavailable'); continue; }
      const updates = record.steps.flatMap(s => s.state === 'receipt' && s.step.type === 'update' && s.step.id === id ? [s.step.changes] : []);
      const changes: { title?: string; url?: string } = {};
      if (updates.some(c => c.title !== undefined) && before.title !== now.title) changes.title = before.title;
      if (updates.some(c => c.url !== undefined) && before.url !== now.url && before.url !== undefined) {
        try { validateUrl(before.url); changes.url = before.url; } catch { conflict(id, 'unsupported-recovery-url'); }
      }
      const changedFields = Object.keys(changes).length > 0;
      if (changedFields) add(`undo-update-${id}`, { type: 'update', target: now.ref, changes });
      const ownedMove = record.steps.some(s => s.state === 'receipt' && s.step.type === 'move' && s.step.id === id);
      if (ownedMove && (before.parentId !== now.parentId || before.index !== now.index)) {
        const parent = before.parentId === undefined ? undefined : current.get(before.parentId)?.ref ?? (old.has(before.parentId) ? restore(old.get(before.parentId)!) : undefined);
        if (!parent) { conflict(id, 'parent-unavailable'); continue; }
        const dependencies = before.parentId && restored.has(before.parentId) ? [`restore-${before.parentId}`] : [];
        if (changedFields) dependencies.push(`undo-update-${id}`);
        moves.push({ id: `undo-move-${id}`, target: now.ref, parent, before, dependsOn: dependencies });
      }
    }
  }
  const aliases = new Map(restored);
  for (const [id, nativeId] of priorRestorations) { const node = current.get(nativeId); if (node) aliases.set(id, node.ref); }
  placeRecoveryMoves(preview, tree, moves, backup, aliases);
  return preview;
}
