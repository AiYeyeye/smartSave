import { z } from 'zod';
import { organizeCheckpointSchema } from './organize-checkpoint';
import type { OrganizeTaskView } from '../background/organize-task-owner';
import type { OrganizeCheckpointMetadata } from '../persistence/organize-checkpoints';

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
    action: z.enum(['confirmFolders', 'resume', 'pause', 'cancel', 'returnToFolders']),
    credential: credential.optional(),
  }),
  task.extend({ action: z.literal('select'), ids: z.array(id), selected: z.boolean() }),
  task.extend({ action: z.literal('target'), actionId: id, targetId: id }),
]);
export const organizeTaskSubscriptionSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal('subscribe'),
  id: id.optional(),
});
export type OrganizeTaskMessage = z.infer<typeof organizeTaskMessageSchema>;
export type OrganizeTaskReply =
  | { ok: true; task: OrganizeTaskView }
  | { ok: true; tasks: OrganizeCheckpointMetadata[] }
  | { ok: false; reason: string };

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
