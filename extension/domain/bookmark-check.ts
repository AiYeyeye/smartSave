import { z } from 'zod';
import type { TreeSnapshot } from './node-reference';
import { preflight } from './preflight';
import type { ConfirmMutation } from '../schemas/messages';
import { groupDuplicateNodes } from './suspected-duplicates';
import type { DuplicateChoice } from './exact-duplicates';

export const CHECK_ORIGINS = ['https://*/*', 'http://*/*'];
export const CHECK_ALARM = 'zhilan.bookmark-check.weekly.v1';
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CHECK_ITEMS = 50_000;
const id = z.string().min(1).max(256);
const scope = id.nullable();
export const linkResultSchema = z.strictObject({
  status: z.enum(['ok', 'broken', 'review', 'skipped']),
  reason: z.enum(['http', 'network', 'timeout', 'redirect', 'unsupported', 'restricted', 'changed', 'manual']),
  code: z.number().int().min(100).max(599).optional(),
  at: z.number().finite().nonnegative(),
});
export type LinkResult = z.infer<typeof linkResultSchema>;
export const checkItemSchema = z.strictObject({ nativeId: id, url: z.string(), result: linkResultSchema.optional() });
export const bookmarkCheckStateSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  installationId: z.string(),
  scopeId: scope,
  weekly: z.boolean(),
  verified: z
    .array(z.strictObject({ installationId: id, nativeId: id, url: z.string(), at: z.number().finite().nonnegative() }))
    .max(MAX_CHECK_ITEMS)
    .optional(),
  nextRun: z.number().finite().nonnegative().optional(),
  notice: z.string().optional(),
  job: z
    .strictObject({
      id,
      installationId: id,
      scopeId: scope,
      status: z.enum(['running', 'paused', 'completed', 'error']),
      startedAt: z.number().finite().nonnegative(),
      updatedAt: z.number().finite().nonnegative(),
      duplicateGroups: z.number().int().nonnegative(),
      items: z.array(checkItemSchema).max(MAX_CHECK_ITEMS),
    })
    .optional(),
});
export type BookmarkCheckState = z.infer<typeof bookmarkCheckStateSchema>;
export const emptyBookmarkCheck = (): BookmarkCheckState => ({
  version: 1,
  revision: 0,
  installationId: '',
  scopeId: null,
  weekly: false,
});
export const bookmarkCheckMessageSchema = z.discriminatedUnion('action', [
  z.strictObject({ type: z.literal('bookmarkCheck'), action: z.literal('get') }),
  z.strictObject({ type: z.literal('bookmarkCheck'), action: z.literal('start'), installationId: id, scopeId: scope }),
  z.strictObject({
    type: z.literal('bookmarkCheck'),
    action: z.literal('configure'),
    installationId: id,
    scopeId: scope,
    weekly: z.boolean(),
  }),
  z.strictObject({ type: z.literal('bookmarkCheck'), action: z.literal('pause') }),
  z.strictObject({ type: z.literal('bookmarkCheck'), action: z.literal('resume') }),
  z.strictObject({
    type: z.literal('bookmarkCheck'),
    action: z.literal('verify'),
    installationId: id,
    nativeId: id,
    url: z.string(),
    available: z.boolean(),
  }),
]);
export type BookmarkCheckMessage = z.infer<typeof bookmarkCheckMessageSchema>;
export const bookmarkCheckResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), state: bookmarkCheckStateSchema }),
  z.strictObject({ status: z.literal('error'), reason: z.string() }),
]);

/** A read-only scope can include protected native roots; it never grants deletion authority. */
export function checkScopeNodes(tree: TreeSnapshot, scopeId: string | null): TreeSnapshot['nodes'] {
  if (scopeId === null) return tree.nodes.filter(node => node.ref.kind === 'bookmark');
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  if (nodes.get(scopeId)?.ref.kind !== 'folder') throw Error('invalid-scope');
  return tree.nodes.filter(node => {
    if (node.ref.kind !== 'bookmark') return false;
    let parent = node.parentId;
    const seen = new Set<string>();
    while (parent !== undefined) {
      if (parent === scopeId) return true;
      if (seen.has(parent)) throw Error('invalid-tree');
      seen.add(parent);
      parent = nodes.get(parent)?.parentId;
    }
    return false;
  });
}

/** Match advisory results to current native identity. Deleted/edited URLs never inherit old verdicts. */
export function currentCheckResults(tree: TreeSnapshot, state: BookmarkCheckState) {
  const results = new Map<string, LinkResult>();
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  for (const item of state.job?.installationId === tree.installationId ? state.job.items : []) {
    const node = nodes.get(item.nativeId);
    if (node?.ref.kind === 'bookmark' && node.url === item.url && item.result && item.result.reason !== 'changed')
      results.set(item.nativeId, item.result);
  }
  for (const item of state.verified ?? []) {
    const node = nodes.get(item.nativeId);
    if (item.installationId === tree.installationId && node?.ref.kind === 'bookmark' && node.url === item.url)
      results.set(item.nativeId, { status: 'ok', reason: 'manual', at: item.at });
  }
  return results;
}

/** Preserve the existing explicit-keeper rule for both exact and suspected duplicate groups. */
export function checkedDuplicateDeletions(nodes: TreeSnapshot['nodes'], choices: Record<string, DuplicateChoice>) {
  const groups = groupDuplicateNodes(nodes);
  const members = new Set(groups.flatMap(group => group.items.map(node => node.ref.nativeId)));
  if (Object.keys(choices).some(key => !members.has(key))) throw Error('stale-selection');
  const ids: string[] = [];
  for (const group of groups) {
    const deleted = group.items.filter(node => choices[node.ref.nativeId] === 'delete');
    if (deleted.length && !group.items.some(node => choices[node.ref.nativeId] === 'keep'))
      throw Error('keep-required');
    ids.push(...deleted.map(node => node.ref.nativeId));
  }
  return ids;
}

/** One explicit deletion batch through the existing preview, coordinator, backup and recovery path. */
export function compileCheckDeletion(tree: TreeSnapshot, scopeId: string | null, ids: string[]): ConfirmMutation {
  if (!ids.length || new Set(ids).size !== ids.length || ids.length > 500) throw Error('invalid-selection');
  const scoped = new Map(checkScopeNodes(tree, scopeId).map(node => [node.ref.nativeId, node]));
  const byId = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  const chains = ids.map(id => {
    const node = scoped.get(id);
    if (!node || node.readOnly) throw Error('invalid-selection');
    const chain: string[] = [];
    let parent = node.parentId;
    while (parent !== undefined) {
      if (chain.includes(parent)) throw Error('invalid-tree');
      chain.push(parent);
      parent = byId.get(parent)?.parentId;
    }
    return chain;
  });
  const ancestor = chains[0]!.find(id => chains.every(chain => chain.includes(id)));
  const root = ancestor === undefined ? undefined : byId.get(ancestor);
  if (root?.ref.kind !== 'folder') throw Error('invalid-scope');
  const operations = ids.map(id => ({
    id: `remove:${id}`,
    dependsOn: [],
    command: { type: 'remove' as const, target: scoped.get(id)!.ref },
  }));
  const request: ConfirmMutation = structuredClone({
    version: 1,
    type: 'confirmMutation',
    requestId: crypto.randomUUID(),
    installationId: tree.installationId,
    epoch: tree.epoch,
    observedRevision: tree.observedRevision,
    scope: root.ref,
    before: tree.nodes,
    command: { type: 'batch', operations, selectedOperationIds: operations.map(operation => operation.id) },
  });
  preflight(request, tree);
  return request;
}
