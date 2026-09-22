import { z } from 'zod';
import { nodeRefSchema, nodeSchema } from '../domain/node-reference';
import { confirmSchema, recoveryConflictSchema } from './messages';
import { operationSchema } from '../persistence/operations';
const recoveryPreviewRequest = { version: z.literal(1), type: z.literal('recoveryPreview'), requestId: z.string(), sourceRequestId: z.string() };
export const recoveryMessageSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), type: z.literal('recoveryDiscard'), requestId: z.string(), proposalRequestId: z.string() }).strict(),
  z.object({ version: z.literal(1), type: z.literal('recoveryList'), requestId: z.string() }).strict(),
  // Only copy writes into a caller-chosen folder, so only copy carries (and requires) a destination.
  z.discriminatedUnion('mode', [
    z.object({ ...recoveryPreviewRequest, mode: z.enum(['undo', 'merge']) }).strict(),
    z.object({ ...recoveryPreviewRequest, mode: z.literal('copy'), destination: nodeRefSchema, selectedNativeIds: z.array(z.string()).optional() }).strict(),
  ]),
  z.object({ version: z.literal(1), type: z.literal('recoveryCleanup'), requestId: z.string(), sourceRequestId: z.string(), confirmed: z.literal(true) }).strict(),
]);
export const recoveryResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), requestId: z.string(), records: z.array(operationSchema), destinations: z.array(nodeSchema), usage: z.number().optional(), quota: z.number().optional() }),
  z.object({ status: z.literal('preview'), requestId: z.string(), proposal: confirmSchema.optional(), conflicts: z.array(recoveryConflictSchema), warning: z.string() }),
  z.object({ status: z.literal('cleaned'), requestId: z.string() }),
  z.object({ status: z.literal('error'), requestId: z.string(), reason: z.string() }),
]);
export type RecoveryResponse = z.infer<typeof recoveryResponseSchema>;
