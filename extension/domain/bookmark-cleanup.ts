import type { TreeSnapshot } from './node-reference';
import { CHECK_DELETE_LIMIT, linkCategory, type LinkResult } from './bookmark-check';
import type { DuplicateGroup } from './suspected-duplicates';

export type CleanupPlan = { deleteIds: string[]; keepIds: string[]; total: number };

/** A user-chosen keeper in one reviewed group; protection always overrides removal. */
export function reviewedDuplicateCleanup(group: DuplicateGroup, keeperId: string): CleanupPlan {
  if (!group.items.some(node => node.ref.nativeId === keeperId)) throw Error('keep-required');
  const keep = group.items.filter(node => node.ref.nativeId === keeperId || node.readOnly);
  const remove = group.items.filter(node => node.ref.nativeId !== keeperId && !node.readOnly);
  return {
    keepIds: keep.map(node => node.ref.nativeId),
    deleteIds: remove.slice(0, CHECK_DELETE_LIMIT).map(node => node.ref.nativeId),
    total: remove.length,
  };
}

/** A reviewable default, never mutation authority. Raw URLs remain byte-for-byte identical. */
export function exactDuplicateCleanup(nodes: TreeSnapshot['nodes']): CleanupPlan {
  const byUrl = new Map<string, TreeSnapshot['nodes']>();
  for (const node of nodes) {
    if (node.ref.kind !== 'bookmark' || node.url === undefined) continue;
    const group = byUrl.get(node.url) ?? [];
    group.push(node);
    byUrl.set(node.url, group);
  }
  const plan: CleanupPlan = { deleteIds: [], keepIds: [], total: 0 };
  for (const group of byUrl.values()) {
    const keeper = group.find(node => node.readOnly) ?? group[0]!;
    const copies = group.filter(node => node !== keeper && !node.readOnly);
    plan.total += copies.length;
    const batch = copies.slice(0, CHECK_DELETE_LIMIT - plan.deleteIds.length);
    if (batch.length) {
      plan.keepIds.push(keeper.ref.nativeId);
      plan.deleteIds.push(...batch.map(node => node.ref.nativeId));
    }
  }
  return plan;
}

/** Page errors, login restrictions and unknown results never enter the default cleanup. */
export function unreachableSiteCleanup(nodes: TreeSnapshot['nodes'], checked: Map<string, LinkResult>): CleanupPlan {
  const ids = nodes
    .filter(node => {
      const result = checked.get(node.ref.nativeId);
      return node.ref.kind === 'bookmark' && !node.readOnly && result && linkCategory(result) === 'site';
    })
    .map(node => node.ref.nativeId);
  return { deleteIds: ids.slice(0, CHECK_DELETE_LIMIT), keepIds: [], total: ids.length };
}
