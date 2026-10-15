import type { NodeRef } from '../domain/node-reference';
import { mutationResultSchema, type MutationResult } from '../schemas/messages';
export type ReconcileSave = (requestId: string) => Promise<unknown>;
export const reconcileSave: ReconcileSave = requestId =>
  chrome.runtime.sendMessage({ version: 1, type: 'reconcileMutation', requestId });
/** Save commands always end in the bookmark create/update/move; require reconciled identity, never URL guessing. */
export function completedSaveBookmark(result: unknown, requestId: string): string {
  const parsed = mutationResultSchema.parse(result);
  const receipt = parsed.evidence?.find(entry => entry.stepIndex === parsed.completedSteps - 1);
  if (
    parsed.requestId !== requestId ||
    parsed.status !== 'completed' ||
    receipt?.state !== 'checkpointed' ||
    !receipt.currentMatchesReceipt ||
    !receipt.nativeId
  )
    throw Error('unproven-bookmark');
  return receipt.nativeId;
}
export function completedSaveFolder(
  result: MutationResult,
  requestId: string,
  installationId: string,
  stepIndex: number,
): NodeRef {
  const parsed = mutationResultSchema.parse(result);
  const receipt = parsed.evidence?.find(e => e.stepIndex === stepIndex && e.state === 'checkpointed' && e.nativeId);
  if (
    parsed.requestId !== requestId ||
    parsed.status !== 'completed' ||
    !parsed.evidence?.at(-1)?.currentMatchesReceipt ||
    !receipt?.nativeId
  )
    throw Error('unproven-folder');
  return { installationId, nativeId: receipt.nativeId, kind: 'folder' };
}
