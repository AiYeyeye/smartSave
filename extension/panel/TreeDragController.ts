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
  const scopeId = chains[0]?.find(id => byId.get(id)?.ref.kind === 'folder' && chains.every(chain => chain.includes(id)));
  const scope = scopeId === undefined ? undefined : byId.get(scopeId);
  if (!scope) throw Error('invalid-scope');
  const request: ConfirmMutation = structuredClone({ version: 1, type: 'confirmMutation', requestId: crypto.randomUUID(), installationId: snapshot.installationId, epoch: snapshot.epoch, observedRevision: snapshot.observedRevision, scope: scope.ref, before: snapshot.nodes, command });
  preflight(request, snapshot);
  return request;
}
export function prepareMove(snapshot: TreeSnapshot, sourceId: string, parentId: string, index: number): ConfirmMutation {
  const target = snapshot.nodes.find(n => n.ref.nativeId === sourceId);
  const parent = snapshot.nodes.find(n => n.ref.nativeId === parentId);
  if (!target || !parent) throw Error('invalid-reference');
  return prepareMutation(snapshot, { type: 'move', target: target.ref, parent: parent.ref, index });
}
