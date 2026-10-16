import { ORGANIZE_STYLE_IDS, ORGANIZE_SUB_STYLES } from './organize-preferences';
import { z } from 'zod';
import { nodeRefSchema, nodeSchema, type TreeSnapshot } from './node-reference';
import { organizeOutputSchema } from '../schemas/model-output';
import { scopeNodes } from './organize-proposal';
import { dependencyDigest, settingsIdentity } from './context-dependencies';
import type { ModelAuthority } from '../adapters/model-authority';
import { batchCommandSchema, organizerBindingSchema } from '../schemas/messages';

const id = z.string().min(1);
const ids = z.array(id);
const selection = z.strictObject({ selected: ids, targets: z.record(id, id) });
const folderPlan = selection.extend({ output: organizeOutputSchema }).strict();
const tree = z.strictObject({
  installationId: id,
  epoch: id,
  observedRevision: z.number().int().nonnegative(),
  roots: ids,
  nodes: z.array(nodeSchema.extend({ ref: nodeRefSchema.strict() }).strict()),
});
const batch = z.strictObject({
  id,
  itemIds: ids.min(1),
  status: z.enum(['pending', 'accepted', 'merged']),
  output: organizeOutputSchema.optional(),
});
/** Generation data plus a journal-owned submission association. Never credentials or live authority. */
export const organizeCheckpointSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id,
    revision: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    installationId: id,
    root: nodeRefSchema.strict(),
    baseline: tree,
    scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    settingsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    settingsRevision: id,
    requiresCredential: z.boolean(),
    preference: z.strictObject({
      style: z.enum(ORGANIZE_STYLE_IDS),
      instructions: z.string().max(1000),
      subStyle: z.enum(ORGANIZE_SUB_STYLES).optional(),
    }),
    options: z.strictObject({
      cleanupEmpty: z.boolean().optional(),
      allowRename: z.boolean().optional(),
      levels: z.literal([1, 2, 3]).optional(),
      unfiledOnly: z.boolean().optional(),
      protectedFolderIds: ids.optional(),
      rejectedSignatures: z.array(z.string()).max(500).optional(),
      batchSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }),
    stage: z.enum(['folders', 'bookmarks', 'complete']),
    status: z.enum(['running', 'review', 'paused', 'failed', 'invalid']),
    folderPlan: folderPlan.optional(),
    bookmarkIds: ids,
    batches: z.array(batch),
    selection,
    elapsedMs: z.number().nonnegative().finite(),
    submission: z
      .strictObject({
        requestId: id,
        binding: organizerBindingSchema,
        command: batchCommandSchema,
      })
      .optional(),
  })
  .superRefine((value, context) => {
    const invalid = () => context.addIssue({ code: 'custom', message: 'invalid-organize-checkpoint' });
    const unique = (values: string[]) => new Set(values).size === values.length;
    if (
      value.submission &&
      (value.stage !== 'complete' ||
        value.status !== 'review' ||
        value.submission.binding.checkpointId !== value.id ||
        value.submission.binding.checkpointRevision + 1 !== value.revision)
    )
      invalid();
    if (
      value.installationId !== value.baseline.installationId ||
      value.root.installationId !== value.installationId ||
      value.root.kind !== 'folder' ||
      !unique(value.baseline.nodes.map(node => node.ref.nativeId)) ||
      value.baseline.nodes.some(node => node.ref.installationId !== value.installationId) ||
      !unique(value.bookmarkIds) ||
      !unique(value.batches.map(item => item.id)) ||
      !unique(value.selection.selected) ||
      (value.folderPlan && !unique(value.folderPlan.selected)) ||
      (value.preference.style === 'custom' && !value.preference.instructions.trim())
    )
      invalid();
    try {
      const nodes = new Map(scopeNodes(value.baseline, value.root.nativeId).map(node => [node.ref.nativeId, node]));
      for (const itemId of value.bookmarkIds) {
        const node = nodes.get(itemId);
        if (
          !node ||
          node.ref.kind !== 'bookmark' ||
          node.readOnly ||
          (value.options.unfiledOnly && node.parentId !== value.root.nativeId)
        )
          invalid();
      }
    } catch {
      invalid();
    }
    if (value.stage === 'folders') {
      if (value.batches.length || (value.status === 'review' && !value.folderPlan)) invalid();
    } else {
      if (!value.folderPlan) invalid();
      const offered = new Set(value.bookmarkIds);
      const batched = value.batches.flatMap(item => item.itemIds);
      if (!unique(batched) || batched.length !== offered.size || batched.some(itemId => !offered.has(itemId)))
        invalid();
    }
    let unmerged = false;
    for (const item of value.batches) {
      if (!unique(item.itemIds) || (item.status === 'pending' ? item.output !== undefined : item.output === undefined))
        invalid();
      if (item.status !== 'merged') unmerged = true;
      if (unmerged && item.status === 'merged') invalid();
      if (item.output) {
        const offered = new Set(item.itemIds);
        const mentioned = [...item.output.moves.map(move => move.itemId), ...(item.output.unchangedIds ?? [])];
        if (
          !unique(mentioned) ||
          mentioned.some(itemId => !offered.has(itemId)) ||
          item.output.newFolders.length ||
          item.output.merges.length ||
          item.output.renames?.length ||
          item.output.removeFolders?.length
        )
          invalid();
      }
    }
    if (value.stage === 'complete' && value.batches.some(item => item.status !== 'merged')) invalid();
    if (value.options.unfiledOnly && (value.options.cleanupEmpty !== false || value.options.allowRename !== false))
      invalid();
  });

export type OrganizeCheckpoint = z.infer<typeof organizeCheckpointSchema>;

const sha256 = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
/**
 * A saved task depends on the scope's folders and on the bookmarks it is organizing. Bookmarks saved into the scope
 * later are simply not part of this run; moving, renaming or deleting a planned bookmark or any folder voids it.
 */
export async function organizeCheckpointContext(
  context: Awaited<ReturnType<ModelAuthority['read']>>,
  rootId: string,
  bookmarkIds: string[],
) {
  const hash = sha256;
  return {
    scopeDigest: await hash(
      dependencyDigest(context.tree, {
        task: 'organize',
        rootId,
        stage: 'bookmarks',
        itemIds: bookmarkIds,
        folderIds: [],
      }),
    ),
    settingsDigest: await hash(settingsIdentity(context)),
    settingsRevision: context.revision,
  };
}

/** Digest written by older versions, which covered every node in scope; still accepted for their saved tasks. */
export function legacyOrganizeScopeDigest(tree: TreeSnapshot, rootId: string) {
  return sha256(dependencyDigest(tree, { task: 'organize', rootId, itemIds: [], folderIds: [] }));
}
/** Running calls lack completion proof after a worker replacement and never restart automatically. */
export function interruptedOrganizeCheckpoint(value: OrganizeCheckpoint): OrganizeCheckpoint {
  return value.status === 'running' ? { ...value, status: 'paused' } : value;
}
