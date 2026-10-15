import { z } from 'zod';

export const ORGANIZER_HEARTBEAT_MS = 20_000;
export const ORGANIZER_HEARTBEAT_SILENCE_MS = 60_000;
const diagnosticId = z.string().regex(/^[\w-]{1,80}$/);
export const organizerGreeting = z.strictObject({
  version: z.literal(1),
  organizerContext: z.string().min(1),
  connectionId: diagnosticId.optional(),
  workerInstance: diagnosticId.optional(),
  heartbeatOwner: z.literal('worker').optional(),
});
export const organizerHeartbeatControl = z.strictObject({
  version: z.literal(1),
  type: z.literal('heartbeat-control'),
  active: z.boolean(),
});
export const organizerHeartbeatPing = z.strictObject({
  version: z.literal(1),
  type: z.literal('keepalive-ping'),
  sequence: z.number().int().positive().safe(),
  workerInstance: diagnosticId,
});
export const organizerHeartbeat = z.strictObject({
  version: z.literal(1),
  type: z.literal('keepalive'),
  sequence: z.number().int().positive().safe(),
});
export const organizerHeartbeatAck = z.strictObject({
  version: z.literal(1),
  type: z.literal('keepalive-ack'),
  sequence: z.number().int().positive().safe(),
  workerInstance: diagnosticId,
});
