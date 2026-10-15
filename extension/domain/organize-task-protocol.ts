import { z } from 'zod';
import { organizeCheckpointSchema } from './organize-checkpoint';
import type { OrganizeTaskView } from '../background/organize-task-owner';
import type { OrganizeCheckpointMetadata } from '../persistence/organize-checkpoints';
import { nodeSchema, treeStateSchema } from './node-reference';
import { mutationResultSchema } from '../schemas/messages';
import { ORGANIZE_REPAIR_LIMIT } from './organize-partial-repair';

export const ORGANIZE_TASK_PORT = 'zhilan.organize-task.v1';
const id = z.string().min(1).max(256);
const credential = z.strictObject({
  revision: z.string().max(4096),
  identity: z.string().max(65536),
  key: z.string().max(8192),
});
const base = z.strictObject({ version: z.literal(1), type: z.literal('organizeTask') });
const task = base.extend({ id, expectedRevision: z.number().int().nonnegative() });
export const organizeTaskMessageSchema = z.discriminatedUnion('action', [
  base.extend({
    action: z.literal('start'),
    scopeId: id,
    preference: organizeCheckpointSchema.shape.preference,
    options: organizeCheckpointSchema.shape.options,
    credential: credential.optional(),
  }),
  base.extend({ action: z.literal('get'), id, credential: credential.optional() }),
  base.extend({ action: z.literal('list') }),
  task.extend({
    action: z.enum(['confirmFolders', 'resume', 'repair', 'pause', 'cancel', 'returnToFolders']),
    credential: credential.optional(),
  }),
  task.extend({ action: z.literal('select'), ids: z.array(id), selected: z.boolean() }),
  task.extend({ action: z.literal('target'), actionId: id, targetId: id }),
]);
const subscription = z.strictObject({
  version: z.literal(1),
  type: z.literal('subscribe'),
  id: id.optional(),
});
export const organizeTaskSubscriptionSchema = z.discriminatedUnion('type', [
  subscription,
  z.strictObject({ version: z.literal(1), type: z.literal('seen'), id, revision: z.number().int().nonnegative() }),
]);
export type OrganizeTaskMessage = z.infer<typeof organizeTaskMessageSchema>;
export type OrganizeTaskReply =
  | { ok: true; task: OrganizeTaskView }
  | { ok: true; tasks: OrganizeCheckpointMetadata[] }
  | { ok: false; reason: string };

const strings = z.array(z.string());
const count = z.number().int().nonnegative();
const tree = organizeCheckpointSchema.shape.baseline;
/** Display-only worker response. No field here grants native mutation authority. */
export const organizeTaskViewSchema = z.strictObject({
  id,
  revision: count,
  needsCredential: z.boolean(),
  submission: z.strictObject({ requestId: z.string().min(1) }).optional(),
  state: z.strictObject({
    tree: treeStateSchema,
    scopeId: z.string(),
    selected: strings,
    targets: z.record(z.string(), z.string()),
    duplicates: z.array(
      z.strictObject({ url: z.string(), items: z.array(nodeSchema), suspected: z.boolean().optional() }),
    ),
    choices: z.record(z.string(), z.enum(['keep', 'delete', 'unselected'])),
    invalid: z.boolean(),
    busy: z.boolean(),
    message: z.string(),
    repair: z.strictObject({ count: count.min(1).max(ORGANIZE_REPAIR_LIMIT), retained: count }).optional(),
    proposal: z
      .strictObject({
        tree,
        scope: organizeCheckpointSchema.shape.root,
        targetIds: strings,
        protectedFolderIds: strings.optional(),
        actions: z.array(
          z.strictObject({
            id: z.string(),
            kind: z.enum(['create', 'move', 'merge', 'delete', 'rename']),
            sourceId: z.string(),
            targetId: z.string().optional(),
            title: z.string(),
            children: strings,
            reason: z.string().optional(),
            newTitle: z.string().optional(),
            dependsOn: strings.optional(),
          }),
        ),
      })
      .optional(),
    pipeline: z
      .strictObject({
        stage: z.enum(['folders', 'bookmarks', 'complete']),
        status: z.enum(['review', 'running', 'paused', 'failed', 'invalid']),
        total: count,
        batchSize: count,
        folderCount: count,
        completed: count,
        analyzed: count.optional(),
        concurrency: count.optional(),
        elapsedMs: z.number().nonnegative().optional(),
        activeSince: z.number().nonnegative().optional(),
        batchCount: count,
        finished: z.array(z.strictObject({ count, actionIds: strings })),
        lockedActionIds: strings,
      })
      .optional(),
    failure: z
      .strictObject({
        code: z.string(),
        phase: z.enum(['准备整理', '模型生成', '方案校验', '书签请求准备']),
        elapsedSeconds: z.number().nonnegative(),
        bookmarkCount: count.optional(),
        outputTokenLimit: count.optional(),
      })
      .optional(),
    result: mutationResultSchema.optional(),
    progress: z
      .strictObject({
        phase: z.enum(['waiting', 'receiving', 'validating']),
        streaming: z.boolean(),
        receivedChars: count,
        preview: strings,
        timeoutSeconds: z.number().nonnegative(),
        bookmarkCount: count,
        outputTokenLimit: count.optional(),
      })
      .optional(),
  }),
});
export const organizeTaskMetadataSchema = z.object({
  id,
  updatedAt: count,
  stage: z.string(),
  status: z.string(),
  readable: z.boolean(),
  requestId: z.string().optional(),
});
export const organizeTaskReplySchema = z.union([
  z.strictObject({ ok: z.literal(true), task: organizeTaskViewSchema }),
  z.strictObject({ ok: z.literal(true), tasks: z.array(organizeTaskMetadataSchema) }),
  z.strictObject({ ok: z.literal(false), reason: z.string() }),
]);

const reasons = new Set([
  'organize-task-unavailable',
  'organize-task-conflict',
  'organize-task-busy',
  'organize-checkpoint-unavailable',
  'unsupported-organize-checkpoint',
  'organize-checkpoint-conflict',
  'organize-credential-required',
  'stale-context',
  'model-unconfigured',
]);
export function organizeTaskError(error: unknown) {
  return error instanceof Error && reasons.has(error.message) ? error.message : 'organize-task-unavailable';
}
