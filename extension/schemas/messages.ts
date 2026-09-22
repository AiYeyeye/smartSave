import { z } from 'zod';
import { nodeRefSchema, nodeSchema } from '../domain/node-reference';
export { trustedMutationSender } from '../background/ui-identity';
const ref = nodeRefSchema.strict();
const changes = z.object({ title: z.string().optional(), url: z.string().optional() }).strict().refine(v => v.title !== undefined || v.url !== undefined);
export const singleCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update'), target: ref, changes }).strict(),
  z.object({ type: z.literal('move'), target: ref, parent: ref, index: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('create'), parent: ref, title: z.string(), url: z.string().optional() }).strict(),
  z.object({ type: z.literal('remove'), target: ref }).strict(),
  z.object({ type: z.literal('deleteSubtree'), target: ref }).strict(),
  z.object({ type: z.literal('createFolderAndBookmark'), parent: ref, folderTitle: z.string(), title: z.string(), url: z.string() }).strict(),
]);
export const batchCommandSchema = z.object({ type: z.literal('batch'), operations: z.array(z.object({ id: z.string().min(1), dependsOn: z.array(z.string()), command: singleCommandSchema }).strict()).min(1), selectedOperationIds: z.array(z.string()).min(1) }).strict();
export const commandSchema = z.union([singleCommandSchema, batchCommandSchema]);
// Explicit durable allowlist: legacy envelope extras are stripped, never recovered as authority.
export const importBindingSchema = z.object({ checkpointId: z.string().min(1), checkpointRevision: z.number().int().nonnegative(), contextDigest: z.string().regex(/^[a-f0-9]{64}$/), selectedSourceOrdinals: z.array(z.number().int().nonnegative()), destinationEdits: z.array(z.object({ sourceOrdinal: z.number().int().nonnegative(), folderId: z.string().min(1) }).strict()).optional(), titleEdits: z.array(z.object({ sourceOrdinal: z.number().int().nonnegative(), title: z.string() }).strict()) }).strict();
/** Single source for skipped-coverage entries: durable requests, recovery responses and domain previews share it. */
export const recoveryConflictSchema = z.object({ nativeId: z.string(), reason: z.string() }).strict();
export const durableMutationRequestSchema = z.object({ version: z.literal(1), type: z.literal('confirmMutation'), requestId: z.string().min(1), installationId: z.string().min(1), epoch: z.string().min(1), observedRevision: z.number().int().nonnegative(), scope: ref, before: z.array(nodeSchema.strict()), command: commandSchema, importBinding: importBindingSchema.optional(), recovery: z.object({ sourceRequestId: z.string(), mode: z.enum(['undo', 'merge', 'copy']), conflicts: z.array(recoveryConflictSchema).optional() }).strict().optional() });
export type DurableMutationRequest = z.infer<typeof durableMutationRequestSchema>;
export const confirmSchema = durableMutationRequestSchema.extend({ importContext: z.string().min(1).optional(), organizerContext: z.string().min(1).optional(), saveContext: z.string().min(1).optional(), previewId: z.string().min(1).optional() }).strict();
export const mutationMessageSchema = z.union([confirmSchema, z.object({ version: z.literal(1), type: z.enum(['mutationStatus', 'reconcileMutation', 'cancelMutation']), requestId: z.string().min(1) }).strict(), z.object({ version: z.literal(1), type: z.literal('quarantineMutation'), requestId: z.string().min(1), confirmed: z.literal(true) }).strict()]);
export type ConfirmMutation = z.infer<typeof confirmSchema>;
export type Command = z.infer<typeof commandSchema>;
export const mutationResultSchema = z.object({ requestId: z.string(), status: z.enum(['rejected', 'failed', 'partial', 'unknown', 'completed']), needsReconcile: z.boolean(), completedSteps: z.number().int().nonnegative(), remainingSteps: z.number().int().nonnegative(), reason: z.string().optional(), evidence: z.array(z.object({ stepIndex: z.number().int().nonnegative(), state: z.enum(['checkpointed', 'not-issued', 'unknown']), nativeId: z.string().optional(), currentMatchesReceipt: z.boolean() })).optional() }).refine(result => result.status !== 'completed' || (!result.needsReconcile && result.remainingSteps === 0 && result.completedSteps > 0));
export type MutationResult = z.infer<typeof mutationResultSchema>;

