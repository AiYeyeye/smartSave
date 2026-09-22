import { startFileOutput } from './file-output';
import { ImportPersistenceStore } from '../persistence/import-persistence';
import { startImportAuthority } from './import-authority';
import { SettingsStore } from '../persistence/settings';
import { startOrganizerAuthority } from './organizer-authority';
import { startSaveEntrypoints } from './save-entrypoints';
import { startTreeService } from './tree-service';
import { startMutationService } from './mutation-service';
import { extractSaveBodyForUi } from './extract-coordinator';
import { trustedMutationSender } from '../domain/trusted-sender';

const { validateSaveContext, livePageForSender } = startSaveEntrypoints(() => coordinator?.purgeSavePreviews());
const projection = startTreeService();
startFileOutput(projection);
const settings = new SettingsStore(chrome.storage.local);
const persistence = new ImportPersistenceStore();
const coordinator = startMutationService(
  projection,
  validateSaveContext,
  startOrganizerAuthority(settings),
  startImportAuthority(settings, projection, persistence.importCheckpoints),
  persistence,
);

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'extractSaveBody')
    return false;
  if (!trustedMutationSender(sender, chrome.runtime.id)) return false;
  const page = livePageForSender(sender);
  if (!page) {
    reply({ status: 'error', reason: 'no-live-save' });
    return false;
  }
  void extractSaveBodyForUi(sender, page, () => livePageForSender(sender))
    .then(reply)
    .catch(error => reply({ status: 'error', reason: String(error && (error as Error).message) }));
  return true;
});
