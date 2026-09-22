import type { TreeSnapshot } from '../domain/node-reference';
import { preflight } from '../domain/preflight';
import type { Command, ConfirmMutation } from '../schemas/messages';
export function prepareMutation(snapshot: TreeSnapshot, command: Command): ConfirmMutation {
  const ids = 'target' in command ? [command.target.nativeId] : [];
  if ('parent' in command) ids.push(command.parent.nativeId);
  const byId = new Map(snapshot.nodes.map(n => [n.ref.nativeId, n]));
  function ancestors(id: string): string[] {
    const result: string[] = [];
    let node = byId.get(id);
    if (!node) throw Error('invalid-reference');
    while (node) {
      if (result.includes(node.ref.nativeId)) throw Error('cycle');
      result.push(node.ref.nativeId);
      node = node.parentId === undefined ? undefined : byId.get(node.parentId);
    }
    return result;
  }
  const chains = ids.map(ancestors);
  const scopeId = chains[0]?.find(
    id => byId.get(id)?.ref.kind === 'folder' && chains.every(chain => chain.includes(id)),
  );
  const scope = scopeId === undefined ? undefined : byId.get(scopeId);
  if (!scope) throw Error('invalid-scope');
  const request: ConfirmMutation = structuredClone({
    version: 1,
    type: 'confirmMutation',
    requestId: crypto.randomUUID(),
    installationId: snapshot.installationId,
    epoch: snapshot.epoch,
    observedRevision: snapshot.observedRevision,
    scope: scope.ref,
    before: snapshot.nodes,
    command,
  });
  preflight(request, snapshot);
  return request;
}
export function prepareMove(
  snapshot: TreeSnapshot,
  sourceId: string,
  parentId: string,
  index: number,
): ConfirmMutation {
  const target = snapshot.nodes.find(n => n.ref.nativeId === sourceId);
  const parent = snapshot.nodes.find(n => n.ref.nativeId === parentId);
  if (!target || !parent) throw Error('invalid-reference');
  return prepareMutation(snapshot, { type: 'move', target: target.ref, parent: parent.ref, index });
}

export type DropPlacement = 'before' | 'after' | 'inside';
export type DropTarget = { parentId: string; index: number };
// UI affordance only, never write authority. O(ancestor depth), no UUID or tree clone.
export function resolveDropTarget(
  byId: ReadonlyMap<string, TreeSnapshot['nodes'][number]>,
  sourceId: string,
  targetId: string,
  placement: DropPlacement,
): DropTarget | undefined {
  const source = byId.get(sourceId);
  const target = byId.get(targetId);
  if (!source || !target || source.readOnly || source.parentId === undefined || sourceId === targetId) return;
  const parentId = placement === 'inside' ? targetId : target.parentId;
  if (parentId === undefined) return;
  const parent = byId.get(parentId);
  if (!parent || parent.ref.kind !== 'folder' || !parent.childrenWritable) return;
  const seen = new Set<string>();
  let ancestor: typeof parent | undefined = parent;
  while (ancestor) {
    const id = ancestor.ref.nativeId;
    if (id === sourceId || seen.has(id)) return;
    seen.add(id);
    if (ancestor.parentId === undefined) break;
    ancestor = byId.get(ancestor.parentId);
    if (!ancestor) return;
  }
  const rawIndex = placement === 'inside' ? parent.childrenIds.length : target.index + (placement === 'after' ? 1 : 0);
  const index = rawIndex - (source.parentId === parentId && source.index < rawIndex ? 1 : 0);
  return { parentId, index };
}
