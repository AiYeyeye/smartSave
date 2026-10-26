import { z } from 'zod';
import type { SaveReceipt } from '../persistence/save-receipts';

export const saveRetryMessageSchema = z.strictObject({
  type: z.literal('nativeSaveRetry'),
  receiptId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256),
});
export type SaveRetryMessage = z.infer<typeof saveRetryMessageSchema>;
export const saveRetryResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('started') }),
  z.strictObject({ status: z.literal('error'), reason: z.string() }),
]);

const UNWRITTEN_FAILURES = new Set([
  'save-feature-unconfigured',
  'service-missing',
  'no-key',
  'settings-unavailable',
  'permission',
  'timeout',
  'http-401',
  'http-403',
  'http-429',
  'http-error',
  'provider-error',
  'refused',
  'schema',
  'empty',
  'incomplete',
  'connection-or-configuration',
  'payload-too-large',
  'json-mode-input-required',
]);

/** Unknown native writes and prior explicit reviews are never retried by this read-only entrypoint. */
export function canRetrySave(receipt: SaveReceipt): boolean {
  return (
    !!receipt.installationId &&
    ['failed', 'skipped'].includes(receipt.status) &&
    UNWRITTEN_FAILURES.has(receipt.reason ?? '') &&
    !receipt.reviewedAt &&
    receipt.dismissedAt === undefined &&
    !receipt.reviewRequestId &&
    !receipt.nameRequestId &&
    !receipt.correction &&
    !receipt.createdFolderIds?.length
  );
}
