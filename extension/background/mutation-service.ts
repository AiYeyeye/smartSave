import { z } from 'zod';
import { importSelectionSchema } from '../domain/import-preview';
import type { ImportAuthority } from './import-authority';
import type { OrganizerAuthority } from './organizer-authority';
import type { ConfirmMutation } from '../schemas/messages';
import { bookmarksWrite } from '../adapters/bookmarks-write';
import { OperationsStore, type OperationJournal } from '../persistence/operations';
import { MutationCoordinator } from './mutation-coordinator';
import type { TreeProjection } from './tree-projection';
export function startMutationService(projection: TreeProjection, validateSaveContext?: (request: ConfirmMutation) => boolean, organizerAuthority?: OrganizerAuthority, importAuthority?: ImportAuthority, journal: OperationJournal = new OperationsStore()) {
  const coordinator = new MutationCoordinator(projection, bookmarksWrite(chrome.bookmarks), journal, chrome.runtime.id, validateSaveContext, organizerAuthority, importAuthority);
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    const importPreview = z.object({ type: z.literal('registerImportPreview'), version: z.literal(1), importContext: z.string().min(1), checkpointId: z.string().min(1), checkpointRevision: z.number().int().nonnegative(), selection: importSelectionSchema }).strict().safeParse(message);
    if (importPreview.success) {
      const m = importPreview.data;
      void coordinator.registerImportPreview(m.importContext, m.checkpointId, m.checkpointRevision, m.selection, sender).then(proposal => respond(proposal ? { status: 'preview', proposal } : { status: 'empty' })).catch(error => respond({ status: 'rejected', reason: error instanceof Error && ['privacy-excluded', 'invalid-import-folder', 'invalid-import-target', 'invalid-import-selection', 'stale-import-authority', 'invalid-import-authority', 'import-reclassification-required', 'import-checkpoint-unavailable', 'unsupported-import-checkpoint'].includes(error.message) ? error.message : 'import-preview-rejected' }));
      return true;
    }
    if (message && typeof message === 'object' && 'type' in message && message.type === 'registerMutationPreview' && 'request' in message) {
      if (message.request && typeof message.request === 'object' && 'organizerContext' in message.request) {
        void coordinator.registerOrganizerPreview(message.request, sender).then(proposal => respond({ status: 'preview', proposal })).catch(() => respond({ status: 'rejected' }));
        return true;
      }
      try { respond({ status: 'preview', proposal: coordinator.registerPreview(message.request, sender) }); } catch { respond({ status: 'rejected' }); }
      return false;
    }
    if (message && typeof message === 'object' && 'type' in message && ['recoveryDiscard', 'recoveryList', 'recoveryPreview', 'recoveryCleanup'].includes(String(message.type))) {
      void coordinator.recovery(message, sender).then(respond).catch(() => respond({ status: 'error', requestId: '', reason: 'recovery-unavailable' }));
      return true;
    }
    if (!message || typeof message !== 'object' || !('type' in message) || !['confirmMutation', 'mutationStatus', 'reconcileMutation', 'quarantineMutation', 'cancelMutation'].includes(String(message.type))) return false;
    void coordinator.submit(message, sender).then(respond).catch(() => respond({ requestId: '', status: 'unknown', needsReconcile: true, completedSteps: 0, remainingSteps: 0, reason: 'coordinator-unavailable' }));
    return true;
  });
  return coordinator;
}
