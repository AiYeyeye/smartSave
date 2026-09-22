import type { NodeRef, TreeSnapshot } from './node-reference';
import type { AiPrivacy } from './ai-payload';
import { serializeAiPayload } from './ai-payload';
import { parseModelOutput } from '../schemas/model-output';
import type { Command, ConfirmMutation } from '../schemas/messages';
import { preflight } from './preflight';
export type OrganizeAction = {
  id: string;
  kind: 'create' | 'move' | 'merge' | 'delete';
  sourceId: string;
  targetId?: string;
  title: string;
  children: string[];
};
export interface OrganizeProposal {
  tree: TreeSnapshot;
  scope: NodeRef;
  actions: OrganizeAction[];
  targetIds: string[];
}
export function scopeNodes(tree: TreeSnapshot, rootId: string) {
  const nodes = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
  const root = nodes.get(rootId);
  if (!root?.childrenWritable || root.ref.kind !== 'folder') throw Error('invalid-scope');
  return tree.nodes.filter(node => {
    let current: typeof node | undefined = node;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.ref.nativeId)) throw Error('invalid-tree');
      seen.add(current.ref.nativeId);
      if (current.ref.nativeId === rootId) return true;
      current = nodes.get(current.parentId ?? '');
    }
    return false;
  });
}
export function organizeCandidates(tree: TreeSnapshot, rootId: string, privacy: AiPrivacy) {
  const nodes = scopeNodes(tree, rootId);
  return JSON.parse(
    serializeAiPayload(tree, privacy, {
      task: 'organize',
      rootId,
      itemIds: nodes.filter(n => !n.readOnly && n.ref.nativeId !== rootId).map(n => n.ref.nativeId),
      folderIds: nodes.filter(n => n.childrenWritable).map(n => n.ref.nativeId),
    }),
  ) as Parameters<typeof parseModelOutput>[1];
}
// privacy is mandatory: a caller that forgets the configured exclusions must fail to compile, never silently expose them.
export function organizeProposal(
  tree: TreeSnapshot,
  rootId: string,
  raw: unknown,
  privacy: AiPrivacy,
): OrganizeProposal {
  const context = organizeCandidates(tree, rootId, privacy);
  const output = parseModelOutput(raw, context);
  if (!('merges' in output)) throw Error('invalid-output');
  const nodes = scopeNodes(tree, rootId);
  const byId = new Map(nodes.map(n => [n.ref.nativeId, n]));
  const actions: OrganizeAction[] = [
    ...output.newFolders.map(f => ({
      id: `create:${f.id}`,
      kind: 'create' as const,
      sourceId: f.id,
      targetId: f.parentId,
      title: f.title,
      children: [],
    })),
    ...output.moves.map(m => ({
      id: `move:${m.itemId}`,
      kind: 'move' as const,
      sourceId: m.itemId,
      targetId: m.folderId,
      title: byId.get(m.itemId)!.title,
      children: [],
    })),
    ...output.merges.map(m => ({
      id: `merge:${m.sourceId}`,
      kind: 'merge' as const,
      sourceId: m.sourceId,
      targetId: m.targetId,
      title: byId.get(m.sourceId)!.title,
      children: [...byId.get(m.sourceId)!.childrenIds],
    })),
  ];
  const allowed = new Set([...context.items.map(i => i.id), ...context.folders.map(f => f.id)]);
  for (const action of actions.filter(a => a.kind === 'merge' || a.kind === 'move')) {
    const pending = [action.sourceId];
    while (pending.length) {
      const node = byId.get(pending.pop()!);
      if (!node || !allowed.has(node.ref.nativeId)) throw Error('privacy-excluded-descendant');
      pending.push(...node.childrenIds);
    }
  }
  if (actions.some(a => a.kind !== 'create' && (a.sourceId === rootId || byId.get(a.sourceId)?.readOnly)))
    throw Error('protected-source');
  const proposal = {
    tree: structuredClone(tree),
    scope: structuredClone(byId.get(rootId)!.ref),
    actions,
    targetIds: [...context.folders.map(f => f.id), ...output.newFolders.map(f => f.id)],
  };
  if (actions.length)
    organizeRequest(
      proposal,
      actions.map(a => a.id),
      {},
      'validation',
    );
  return proposal;
}
export function organizeRequest(
  proposal: OrganizeProposal,
  selected: string[],
  targets: Record<string, string>,
  organizerContext: string,
): ConfirmMutation {
  const { tree, scope, actions } = proposal;
  const operations: Extract<Command, { type: 'batch' }>['operations'] = [];
  const scoped = new Map(scopeNodes(tree, scope.nativeId).map(n => [n.ref.nativeId, n]));
  const actionIds = new Set(actions.map(a => a.id));
  const chosen = new Set(selected);
  if (chosen.size !== selected.length || selected.some(id => !actionIds.has(id))) throw Error('invalid-selection');
  const creates = new Map(actions.filter(a => a.kind === 'create').map(a => [a.sourceId, a]));
  const ref = (id: string): NodeRef => {
    const created = creates.get(id);
    if (created) {
      if (!chosen.has(created.id)) throw Error('unselected-dependency');
      return { installationId: tree.installationId, nativeId: `$batch:${created.id}:$created`, kind: 'folder' };
    }
    const node = scoped.get(id);
    if (!node) throw Error('outside-scope');
    return node.ref;
  };
  for (const a of actions.filter(a => chosen.has(a.id))) {
    const destination = targets[a.id] ?? a.targetId;
    if (destination && !proposal.targetIds.includes(destination)) throw Error('invalid-target');
    const dependency = destination && creates.get(destination)?.id;
    const dependsOn = dependency ? [dependency] : [];
    if (a.kind === 'create')
      operations.push({ id: a.id, dependsOn, command: { type: 'create', parent: ref(destination!), title: a.title } });
    if (a.kind === 'move')
      operations.push({
        id: a.id,
        dependsOn,
        command: { type: 'move', target: ref(a.sourceId), parent: ref(destination!), index: 0 },
      });
    if (a.kind === 'delete')
      operations.push({ id: a.id, dependsOn: [], command: { type: 'remove', target: ref(a.sourceId) } });
    if (a.kind === 'merge') {
      const moves = a.children.map((id, index) => ({
        id: `${a.id}:child:${id}`,
        dependsOn,
        command: { type: 'move' as const, target: ref(id), parent: ref(destination!), index },
      }));
      operations.push(...moves, {
        id: a.id,
        dependsOn: [...dependsOn, ...moves.map(m => m.id)],
        command: { type: 'remove', target: ref(a.sourceId) },
      });
    }
  }
  const request: ConfirmMutation = {
    version: 1,
    type: 'confirmMutation',
    requestId: crypto.randomUUID(),
    installationId: tree.installationId,
    epoch: tree.epoch,
    observedRevision: tree.observedRevision,
    scope,
    before: structuredClone(tree.nodes),
    organizerContext,
    command: { type: 'batch', operations, selectedOperationIds: operations.map(o => o.id) },
  };
  if (!operations.length) throw Error('empty-selection');
  preflight(request, tree);
  return request;
}
