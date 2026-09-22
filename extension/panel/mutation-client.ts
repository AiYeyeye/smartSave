import { confirmSchema, mutationResultSchema, type ConfirmMutation, type MutationResult } from '../schemas/messages';
export type SendMutation = (request: ConfirmMutation) => Promise<unknown>;
// An explicit worker reply without a usable proposal never issued a native write, so it is a retryable rejection; any lastError may already have reached the worker and stays unknown.
export const sendMutation: SendMutation = request => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ type: 'registerMutationPreview', request }, (registered: unknown) => {
    if (chrome.runtime.lastError) { reject(Error('transport-unavailable')); return; }
    const proposal = confirmSchema.safeParse(registered && typeof registered === 'object' && 'proposal' in registered ? registered.proposal : undefined);
    if (!proposal.success) { resolve({ requestId: request.requestId, status: 'rejected', needsReconcile: false, completedSteps: 0, remainingSteps: 0, reason: 'preview-unavailable' } satisfies MutationResult); return; }
    chrome.runtime.sendMessage(proposal.data, (response: unknown) => {
    if (chrome.runtime.lastError) reject(Error('transport-unavailable')); else resolve(response);
    });
  });
});
export async function submitMutation(request: ConfirmMutation, send: SendMutation = sendMutation): Promise<MutationResult> {
  try {
    const result = mutationResultSchema.parse(await send(request));
    if (result.requestId !== request.requestId) throw Error('mismatched-response');
    return result;
  } catch {
    return { requestId: request.requestId, status: 'unknown', needsReconcile: true, completedSteps: 0, remainingSteps: 0, reason: 'transport-unavailable' };
  }
}
