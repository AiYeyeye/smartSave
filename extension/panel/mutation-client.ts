import { confirmSchema, mutationResultSchema, type ConfirmMutation, type MutationResult } from '../schemas/messages';
export type SendMutation = (request: ConfirmMutation) => Promise<unknown>;
export const sendMutation: SendMutation = request => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ type: 'registerMutationPreview', request }, (registered: unknown) => {
    if (chrome.runtime.lastError || !registered || typeof registered !== 'object' || !('proposal' in registered)) { reject(Error('preview-unavailable')); return; }
    const proposal = confirmSchema.safeParse(registered.proposal);
    if (!proposal.success) { reject(Error('preview-unavailable')); return; }
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
