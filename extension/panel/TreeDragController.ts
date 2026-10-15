import type { TreeSnapshot } from '../domain/node-reference';
import type { ConfirmMutation } from '../schemas/messages';
import { prepareMutation } from '../domain/prepare-mutation';
export { prepareMutation } from '../domain/prepare-mutation';
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
