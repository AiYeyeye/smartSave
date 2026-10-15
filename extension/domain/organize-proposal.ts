import type { NodeRef, TreeSnapshot } from './node-reference';
import type { AiPrivacy } from './ai-payload';
import { serializeAiPayload } from './ai-payload';
import { parseModelOutput } from '../schemas/model-output';
import type { Command, ConfirmMutation } from '../schemas/messages';
import { planBatch } from './batch-plan';
import { expectedAfter } from './mutation-effect';
export type OrganizeAction = {
  id: string;
  kind: 'create' | 'move' | 'merge' | 'delete' | 'rename';
  sourceId: string;
  targetId?: string;
  title: string;
  children: string[];
  reason?: string;
  newTitle?: string;
  dependsOn?: string[];
};
export interface OrganizeProposal {
  tree: TreeSnapshot;
  scope: NodeRef;
  actions: OrganizeAction[];
  targetIds: string[];
  protectedFolderIds?: string[];
}
export interface OrganizeOptions {
  unfiledOnly?: boolean;
  cleanupEmpty?: boolean;
  protectedFolderIds?: string[];
  allowRename?: boolean;
}
export function organizePrivacy(tree: TreeSnapshot, privacy: AiPrivacy, protectedFolderIds: string[] = []): AiPrivacy {
  const protectedIds = new Set(protectedFolderIds);
  return {
    ...privacy,
    excludedFolders: [
      ...privacy.excludedFolders,
      ...tree.nodes.filter(n => protectedIds.has(n.ref.nativeId) && n.ref.kind === 'folder').map(n => n.ref),
    ],
  };
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
  options: OrganizeOptions = {},
): OrganizeProposal {
  privacy = organizePrivacy(tree, privacy, options.protectedFolderIds);
  const context = organizeCandidates(tree, rootId, privacy);
  const output = parseModelOutput(raw, context);
  if (!('merges' in output)) throw Error('invalid-output');
  if (output.newFolders.some(f => tree.nodes.some(n => n.ref.nativeId === f.id))) throw Error('invalid-output');
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
      reason: f.reason || undefined,
    })),
    ...output.moves.map(m => ({
      id: `move:${m.itemId}`,
      kind: 'move' as const,
      sourceId: m.itemId,
      targetId: m.folderId,
      title: byId.get(m.itemId)!.title,
      children: [],
      reason: m.reason || undefined,
    })),
    ...output.merges.map(m => ({
      id: `merge:${m.sourceId}`,
      kind: 'merge' as const,
      sourceId: m.sourceId,
      targetId: m.targetId,
      title: byId.get(m.sourceId)!.title,
      children: [...byId.get(m.sourceId)!.childrenIds],
      reason: m.reason || undefined,
    })),
    ...(options.allowRename === false ? [] : (output.renames ?? [])).map(r => ({
      id: `rename:${r.folderId}`,
      kind: 'rename' as const,
      sourceId: r.folderId,
      title: byId.get(r.folderId)!.title,
      newTitle: r.title,
      children: [],
      reason: r.reason || undefined,
    })),
  ];
  const allowed = new Set([...context.items.map(i => i.id), ...context.folders.map(f => f.id)]);
  for (const merge of actions.filter(a => a.kind === 'merge')) {
    const descendants = new Set(scopeNodes(tree, merge.sourceId).map(n => n.ref.nativeId));
    if (actions.some(a => a !== merge && (a.kind === 'move' || a.kind === 'merge') && descendants.has(a.sourceId)))
      throw Error('overlapping-merge');
  }
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
  const proposal: OrganizeProposal = {
    tree: structuredClone(tree),
    scope: structuredClone(byId.get(rootId)!.ref),
    actions,
    targetIds: [...context.folders.map(f => f.id), ...output.newFolders.map(f => f.id)],
    protectedFolderIds: options.protectedFolderIds,
  };
  return organizeCleanup(proposal, privacy, options, output.removeFolders ?? []);
}
/** Derive safe empty-folder cleanup after the complete selected taxonomy and bookmark moves. */
export function organizeCleanup(
  proposal: OrganizeProposal,
  privacy: AiPrivacy,
  options: OrganizeOptions = {},
  removals: { folderId: string; reason?: string }[] = [],
): OrganizeProposal {
  proposal = { ...proposal, actions: [...proposal.actions] };
  const { tree, actions } = proposal;
  const rootId = proposal.scope.nativeId;
  privacy = organizePrivacy(tree, privacy, options.protectedFolderIds);
  const context = organizeCandidates(tree, rootId, privacy);
  const allowed = new Set([...context.items.map(i => i.id), ...context.folders.map(f => f.id)]);
  const nodes = scopeNodes(tree, rootId);
  const byId = new Map(nodes.map(n => [n.ref.nativeId, n]));
  let simulated = actions.length
    ? organizeCompilation(
        proposal,
        actions.map(a => a.id),
        {},
        'validation',
      ).plan.simulated
    : tree;
  const explicit = new Map((options.cleanupEmpty === false ? [] : removals).map(r => [r.folderId, r.reason]));
  const depth = (id: string) => {
    let n = byId.get(id);
    let result = 0;
    while (n?.parentId && byId.has(n.parentId)) {
      result++;
      n = byId.get(n.parentId);
    }
    return result;
  };
  const cleanup = nodes
    .filter(
      n =>
        explicit.has(n.ref.nativeId) ||
        (options.cleanupEmpty &&
          n.ref.kind === 'folder' &&
          !actions.some(a => a.kind === 'rename' && a.sourceId === n.ref.nativeId)),
    )
    .sort((a, b) => depth(b.ref.nativeId) - depth(a.ref.nativeId));
  for (const node of cleanup) {
    const id = node.ref.nativeId;
    const current = simulated.nodes.find(n => n.ref.nativeId === id);
    const safe =
      id !== rootId &&
      !node.readOnly &&
      node.ref.kind === 'folder' &&
      allowed.has(id) &&
      current?.childrenIds.length === 0;
    if (!safe) {
      if (explicit.has(id)) throw Error('unsafe-folder-removal');
      else continue;
    }
    // Only original folders are cleaned; empty user-created destinations are never silently undone.
    const dependsOn = node.childrenIds.flatMap(child =>
      actions.filter(a => a.sourceId === child && ['move', 'merge', 'delete'].includes(a.kind)).map(a => a.id),
    );
    actions.push({
      id: `delete:${id}`,
      kind: 'delete',
      sourceId: id,
      title: node.title,
      children: [],
      dependsOn,
      reason: explicit.get(id) || undefined,
    });
    simulated = { ...simulated, nodes: expectedAfter(simulated, { type: 'remove', id }) };
  }
  if (cleanup.length && actions.length)
    organizeCompilation(
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
  return organizeCompilation(proposal, selected, targets, organizerContext).request;
}
export function actionDependencies(
  proposal: OrganizeProposal,
  action: OrganizeAction,
  targets: Record<string, string>,
) {
  const destination = targets[action.id] ?? action.targetId;
  const created = proposal.actions.find(a => a.kind === 'create' && a.sourceId === destination);
  return [...new Set([...(action.dependsOn ?? []), ...(created ? [created.id] : [])])];
}
/** Remove dependents of an unchecked action, never silently restore an explicit refusal. */
export function pruneOrganizeSelection(
  proposal: OrganizeProposal,
  selected: string[],
  targets: Record<string, string>,
) {
  const chosen = new Set(selected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of proposal.actions)
      if (chosen.has(a.id) && actionDependencies(proposal, a, targets).some(id => !chosen.has(id))) {
        chosen.delete(a.id);
        changed = true;
      }
  }
  return proposal.actions.filter(a => chosen.has(a.id)).map(a => a.id);
}
export function reconcileOrganizeSelection(
  proposal: OrganizeProposal,
  selected: string[],
  targets: Record<string, string>,
) {
  selected = pruneOrganizeSelection(proposal, selected, targets);
  const folders = new Set(proposal.tree.nodes.filter(n => n.ref.kind === 'folder').map(n => n.ref.nativeId));
  const removals = proposal.actions.filter(
    a => selected.includes(a.id) && a.kind === 'delete' && folders.has(a.sourceId),
  );
  if (!removals.length) return selected;
  const base = selected.filter(id => !removals.some(a => a.id === id));
  try {
    const tree = base.length
      ? organizeCompilation(proposal, base, targets, 'preview-only').plan.simulated
      : proposal.tree;
    const nodes = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
    const removed = new Set(removals.map(a => a.sourceId));
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of removed)
        if (nodes.get(id)?.childrenIds.some(child => !removed.has(child))) {
          removed.delete(id);
          changed = true;
        }
    }
    return pruneOrganizeSelection(
      proposal,
      selected.filter(id => !removals.some(a => a.id === id && !removed.has(a.sourceId))),
      targets,
    );
  } catch {
    return selected;
  } // Other invalid edits are explained by the compiled preview, never auto-applied.
}
export function organizeCompilation(
  proposal: OrganizeProposal,
  selected: string[],
  targets: Record<string, string>,
  organizerContext: string,
) {
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
    const dependsOn = actionDependencies(proposal, a, targets);
    if (dependsOn.some(id => !chosen.has(id))) throw Error('unselected-dependency');
    if (a.kind === 'create')
      operations.push({ id: a.id, dependsOn, command: { type: 'create', parent: ref(destination!), title: a.title } });
    if (a.kind === 'move')
      operations.push({
        id: a.id,
        dependsOn,
        command: { type: 'move', target: ref(a.sourceId), parent: ref(destination!), index: 0 },
      });
    if (a.kind === 'delete')
      operations.push({ id: a.id, dependsOn, command: { type: 'remove', target: ref(a.sourceId) } });
    if (a.kind === 'rename') {
      if (!a.newTitle?.trim()) throw Error('invalid-title');
      operations.push({
        id: a.id,
        dependsOn,
        command: { type: 'update', target: ref(a.sourceId), changes: { title: a.newTitle } },
      });
    }
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
  const plan = planBatch(request, tree);
  // Protect both a folder's contents and its path. Sibling reindexing outside it is harmless.
  const after = new Map(plan.simulated.nodes.map(n => [n.ref.nativeId, n]));
  for (const protectedId of proposal.protectedFolderIds ?? []) {
    const protectedNode = tree.nodes.find(n => n.ref.nativeId === protectedId);
    if (!protectedNode) continue;
    const protectedNodes = scopeNodes(tree, protectedId);
    const ancestors = [];
    let parentId = protectedNode.parentId;
    while (parentId) {
      const parent = tree.nodes.find(n => n.ref.nativeId === parentId);
      if (!parent) break;
      ancestors.push(parent);
      parentId = parent.parentId;
    }
    for (const n of [...protectedNodes, ...ancestors]) {
      const next = after.get(n.ref.nativeId);
      if (
        !next ||
        next.title !== n.title ||
        next.parentId !== n.parentId ||
        next.url !== n.url ||
        (protectedNodes.includes(n) && JSON.stringify(next.childrenIds) !== JSON.stringify(n.childrenIds))
      )
        throw Error('protected-folder');
    }
  }
  return { request, plan };
}
