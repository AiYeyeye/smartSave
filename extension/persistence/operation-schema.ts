import { z } from 'zod';
import { durableMutationRequestSchema } from '../schemas/messages';
import { nodeSchema } from '../domain/node-reference';
/** Leaf owner of the journal record schema: the journal and import checkpoints validate records without importing each other's stores. */
const stepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update'), id: z.string(), changes: z.object({ title: z.string().optional(), url: z.string().optional() }).strict() }).strict(),
  z.object({ type: z.literal('move'), id: z.string(), parentId: z.string(), index: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('remove'), id: z.string() }).strict(),
  z.object({ type: z.literal('create'), parentId: z.string(), title: z.string(), url: z.string().optional(), temporaryId: z.string() }).strict(),
]);
const resultSchema = z.object({ requestId: z.string(), status: z.enum(['rejected', 'failed', 'partial', 'unknown', 'completed']), needsReconcile: z.boolean(), completedSteps: z.number().int().nonnegative(), remainingSteps: z.number().int().nonnegative(), reason: z.string().optional(), evidence: z.array(z.object({ stepIndex: z.number().int().nonnegative(), state: z.enum(['checkpointed', 'not-issued', 'unknown']), nativeId: z.string().optional(), currentMatchesReceipt: z.boolean() }).strict()).optional() }).strict();
const stepEntry = { step: stepSchema, state: z.enum(['planned', 'intent', 'receipt']), returnedNativeId: z.string().optional() };
const record = { requestId: z.string(), request: durableMutationRequestSchema, affected: z.array(nodeSchema), createdAt: z.string().optional(), backup: z.object({ installationId: z.string(), nodes: z.array(nodeSchema) }).strict().optional(), quarantine: z.object({ acknowledgedAt: z.string(), epoch: z.string(), observedRevision: z.number() }).strict().optional(), mapping: z.record(z.string(), z.string()), result: resultSchema.optional() };
const digest = z.string().regex(/^[a-f0-9]{64}$/).optional();
/** v2 touched entries are the after-state nodes that differ from before; a removed node keeps its before-state plus `removed`, so replaying touched over the backup rebuilds any receipt tree. */
export const touchedNodeSchema = nodeSchema.extend({ removed: z.literal(true).optional() });
// v1 keeps three full trees per step; v2 keeps SHA-256 digests of those trees, the touched delta, and one final snapshot per batch. Both stay readable.
export const operationSchema = z.discriminatedUnion('schemaVersion', [
  z.object({ schemaVersion: z.literal(1), ...record, steps: z.array(z.object({ ...stepEntry, before: z.array(nodeSchema).optional(), expectedAfter: z.array(nodeSchema).optional(), after: z.array(nodeSchema).optional() }).strict()) }).strict(),
  z.object({ schemaVersion: z.literal(2), ...record, steps: z.array(z.object({ ...stepEntry, beforeDigest: digest, expectedAfterDigest: digest, afterDigest: digest, touched: z.array(touchedNodeSchema).optional() }).strict()), final: z.object({ nodes: z.array(nodeSchema) }).strict().optional() }).strict(),
]);
export type OperationRecord = z.infer<typeof operationSchema>;
export type OperationRecordV2 = Extract<OperationRecord, { schemaVersion: 2 }>;
