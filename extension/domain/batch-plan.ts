import type { ConfirmMutation } from '../schemas/messages';
import type { TreeSnapshot } from './node-reference';
import { planSingle, sameNode, type Step } from './single-plan';
import { expectedAfter } from './mutation-effect';

export function planBatch(request: ConfirmMutation, tree: TreeSnapshot) {
  if (request.command.type !== 'batch') throw Error('not-batch');
  if (request.installationId !== tree.installationId || request.epoch !== tree.epoch || request.observedRevision !== tree.observedRevision) throw Error('stale-preview');
  // A batch owns a fixed complete baseline; no per-item rebasing of external changes.
  const saved = new Map(request.before.map(n => [n.ref.nativeId, n]));
  if (saved.size !== tree.nodes.length || saved.size !== request.before.length || tree.nodes.some(n => !saved.has(n.ref.nativeId) || !sameNode(saved.get(n.ref.nativeId)!, n) || saved.get(n.ref.nativeId)!.observedRevision !== n.observedRevision)) throw Error('changed-before');
  const { operations, selectedOperationIds } = request.command;
  const byId = new Map(operations.map(o => [o.id, o]));
  const selected = new Set(selectedOperationIds);
  if (byId.size !== operations.length || selected.size !== selectedOperationIds.length) throw Error('duplicate-operation');
  const ordered: typeof operations = [];
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    const op = byId.get(id);
    if (!op || !selected.has(id) || visiting.has(id)) throw Error('invalid-dependency');
    visiting.add(id); op.dependsOn.forEach(visit); visiting.delete(id); visited.add(id); ordered.push(op);
  };
  selectedOperationIds.forEach(visit);
  let simulated = structuredClone(tree);
  const steps: Step[] = [];
  const temporaryOwners = new Map<string, string>();
  for (const op of ordered) {
    const refs = 'parent' in op.command ? [op.command.parent] : [];
    if ('target' in op.command) refs.push(op.command.target);
    for (const ref of refs) {
      const owner = temporaryOwners.get(ref.nativeId);
      if (owner && !op.dependsOn.includes(owner)) throw Error('missing-temporary-dependency');
    }
    const plan = planSingle({ ...request, before: simulated.nodes, command: op.command }, simulated);
    const locals = new Map<string, string>();
    for (const source of plan.steps) {
      const step: Step = source.type === 'create' ? { ...source, parentId: locals.get(source.parentId) ?? source.parentId, temporaryId: `$batch:${op.id}:${source.temporaryId}` } : source;
      if (step.type === 'create') {
        if (simulated.nodes.some(n => n.ref.nativeId === step.temporaryId)) throw Error('temporary-id-collision');
        temporaryOwners.set(step.temporaryId, op.id);
        locals.set(source.type === 'create' ? source.temporaryId : '', step.temporaryId);
      }
      const existing = step.type === 'create' ? undefined : simulated.nodes.find(n => n.ref.nativeId === step.id)!;
      let returned: chrome.bookmarks.BookmarkTreeNode | undefined;
      if (step.type === 'create') returned = { id: step.temporaryId, parentId: step.parentId, title: step.title, url: step.url, syncing: false };
      else if (step.type !== 'remove') returned = { id: step.id, parentId: step.type === 'move' ? step.parentId : existing!.parentId, title: step.type === 'update' ? step.changes.title ?? existing!.title : existing!.title, url: step.type === 'update' ? step.changes.url ?? existing!.url : existing!.url, syncing: false };
      simulated = { ...simulated, nodes: expectedAfter(simulated, step, returned) };
      steps.push(step);
    }
  }
  return { steps, affected: structuredClone(tree.nodes), simulated, temporaryOwners };
}
