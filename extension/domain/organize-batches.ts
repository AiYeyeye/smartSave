import type { AiRequest, OrganizeDestination } from './ai-payload';
import type { OrganizeProposal } from './organize-proposal';
import { organizeCompilation } from './organize-proposal';

export const ORGANIZE_BATCH_SIZE = 100;
/** Preferred batch size in bytes, NOT the transport limit or remote model's context window. */
export const ORGANIZE_REQUEST_BYTES = 48 * 1024;
export type OrganizeRequest = Extract<AiRequest, { task: 'organize' }>;

export function partitionOrganizeItems(
  ids: string[],
  size: (items: string[]) => number,
  maxItems = ORGANIZE_BATCH_SIZE,
  maxRequestBytes = ORGANIZE_REQUEST_BYTES,
) {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) throw Error('invalid-batch-size');
  if (size([]) > maxRequestBytes) throw Error('folder-context-too-large');
  const batches: string[][] = [];
  let pending: string[] = [];
  for (const id of ids) {
    if (pending.length && (pending.length >= maxItems || size([...pending, id]) > ORGANIZE_REQUEST_BYTES)) {
      batches.push(pending);
      pending = [];
    }
    pending.push(id);
    // An indivisible item can exceed the preferred batch size while still fitting
    // the transport. Keep it intact in its own batch instead of rejecting the run.
    if (size(pending) > maxRequestBytes) throw Error('bookmark-context-too-large');
  }
  if (pending.length) batches.push(pending);
  return batches;
}

/** Freeze selected folder actions; model IDs are aliases for compiler-owned temporary native IDs. */
export function approvedOrganizeFolders(
  proposal: OrganizeProposal,
  selected: string[],
  targets: Record<string, string>,
) {
  const simulated = selected.length
    ? organizeCompilation(proposal, selected, targets, 'folder-review').plan.simulated
    : proposal.tree;
  const aliases = new Map(
    proposal.actions
      .filter(a => a.kind === 'create' && selected.includes(a.id))
      .map(a => [`$batch:${a.id}:$created`, a.sourceId]),
  );
  const alias = (id: string) => aliases.get(id) ?? id;
  const available = new Set(proposal.targetIds);
  const destinations: OrganizeDestination[] = simulated.nodes
    .filter(n => n.childrenWritable && available.has(alias(n.ref.nativeId)))
    .map(n => ({ id: alias(n.ref.nativeId), parentId: n.parentId ? alias(n.parentId) : undefined, title: n.title }));
  return {
    destinations,
    placements: new Map(
      simulated.nodes
        .filter(n => n.ref.kind === 'bookmark')
        .map(n => [n.ref.nativeId, n.parentId ? alias(n.parentId) : undefined]),
    ),
    proposal: {
      ...proposal,
      actions: proposal.actions
        .filter(a => selected.includes(a.id))
        .map(a => ({ ...a, targetId: targets[a.id] ?? a.targetId })),
      targetIds: destinations.map(f => f.id),
    },
  };
}
