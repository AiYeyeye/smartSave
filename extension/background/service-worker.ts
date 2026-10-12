import { bookmarksWrite } from '../adapters/bookmarks-write';
import { startFileOutput } from './file-output';
import { ImportPersistenceStore } from '../persistence/import-persistence';
import { startImportAuthority } from './import-authority';
import { SettingsStore } from '../persistence/settings';
import { AiServicesStore } from '../persistence/ai-services';
import { startOrganizerAuthority } from './organizer-authority';
import { startSaveEntrypoints } from './save-entrypoints';
import { startTreeService } from './tree-service';
import { startMutationService } from './mutation-service';
import { extractSaveBodyForUi } from './extract-coordinator';
import { trustedMutationSender } from '../domain/trusted-sender';
import { OwnWriteGuard } from './own-write-guard';
import { nativeSaveBadge, startNativeBookmarkIngress } from './native-bookmark-ingress';
import { SaveReceiptLog } from '../persistence/save-receipts';

const { validateSaveContext, livePageForSender } = startSaveEntrypoints(() => coordinator?.purgeSavePreviews());
const projection = startTreeService();
startFileOutput(projection);
const settings = new SettingsStore(chrome.storage.local);
const aiServices = new AiServicesStore(chrome.storage.local);
const ownWrites = new OwnWriteGuard();
const writer = ownWrites.wrap(bookmarksWrite(chrome.bookmarks));
const persistence = new ImportPersistenceStore();
const coordinator = startMutationService(
  projection,
  validateSaveContext,
  startOrganizerAuthority(settings),
  startImportAuthority(settings, projection, persistence.importCheckpoints),
  persistence,
  writer,
);
const nativeSaves = startNativeBookmarkIngress({
  projection,
  settings,
  aiServices,
  writer,
  guard: ownWrites,
  receipts: new SaveReceiptLog(chrome.storage.local),
  badge: nativeSaveBadge,
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'nativeSaveUndo')
    return false;
  if (!trustedMutationSender(sender, chrome.runtime.id)) return false;
  const receiptId = 'receiptId' in message && typeof message.receiptId === 'string' ? message.receiptId : '';
  void nativeSaves
    .undo(receiptId)
    .then(reply)
    .catch(error => reply({ status: 'refused', reason: String(error && (error as Error).message) }));
  return true;
});

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
