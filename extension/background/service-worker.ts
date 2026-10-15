import { bookmarksWrite } from '../adapters/bookmarks-write';
import { startFileOutput } from './file-output';
import { ImportPersistenceStore } from '../persistence/import-persistence';
import { startImportAuthority } from './import-authority';
import { SettingsStore } from '../persistence/settings';
import { AiServicesStore } from '../persistence/ai-services';
import { featureModelSettings } from '../adapters/feature-model-settings';
import { startOrganizerAuthority } from './organizer-authority';
import { openSaveUi, startSaveEntrypoints } from './save-entrypoints';
import {
  isClaimedOverlayDocument,
  overlayTrustRestored,
  overlayInjectable,
  panelMode,
  startOverlayHost,
  toggleOverlay,
  watchPanelMode,
} from './overlay-host';
import { startTreeService } from './tree-service';
import { startMutationService } from './mutation-service';
import { extractSaveBodyForUi } from './extract-coordinator';
import { setOverlayDocumentTrust, withTrustedSender } from '../domain/trusted-sender';
import { OwnWriteGuard } from './own-write-guard';
import { nativeSaveBadge, startNativeBookmarkIngress } from './native-bookmark-ingress';
import { SaveReceiptLog } from '../persistence/save-receipts';
import { startWorkerDiagnostics } from './worker-diagnostics';

const workerDiagnostics = startWorkerDiagnostics();

// Toolbar click: overlay sidebar sliding in from the left (default) or the browser's native side panel.
void Promise.resolve(chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })).catch(() => {});
startOverlayHost();
setOverlayDocumentTrust(
  sender => isClaimedOverlayDocument(sender as Parameters<typeof isClaimedOverlayDocument>[0]),
  overlayTrustRestored,
);
watchPanelMode();
chrome.action.onClicked.addListener(tab => {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  if (panelMode() === 'sidepanel' || !overlayInjectable(tab.url)) {
    // Must stay synchronous inside the click gesture.
    void Promise.resolve(chrome.sidePanel?.open?.({ tabId })).catch(() => {});
    return;
  }
  void toggleOverlay(tabId, tab.url).then(ok => {
    if (!ok) void Promise.resolve(chrome.sidePanel?.open?.({ tabId })).catch(() => {});
  });
});

/** Shortcut / page menu saves: show the UI for the captured tab in the chosen mode. */
async function openSaveSurface(tabId: number) {
  if (panelMode() === 'overlay') {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab && (await toggleOverlay(tabId, tab.url, true))) return;
  }
  await openSaveUi(tabId);
}

const { validateSaveContext, livePageForSender } = startSaveEntrypoints(
  () => coordinator?.purgeSavePreviews(),
  openSaveSurface,
);
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
  startOrganizerAuthority(featureModelSettings(settings, aiServices, 'organize'), workerDiagnostics),
  startImportAuthority(featureModelSettings(settings, aiServices, 'import'), projection, persistence.importCheckpoints),
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
  return withTrustedSender(sender, chrome.runtime.id, () => {
    const receiptId = 'receiptId' in message && typeof message.receiptId === 'string' ? message.receiptId : '';
    void nativeSaves
      .undo(receiptId)
      .then(reply)
      .catch(error => reply({ status: 'refused', reason: String(error && (error as Error).message) }));
  });
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'extractSaveBody')
    return false;
  return withTrustedSender(sender, chrome.runtime.id, () => {
    const page = livePageForSender(sender);
    if (!page) {
      reply({ status: 'error', reason: 'no-live-save' });
      return false;
    }
    void extractSaveBodyForUi(sender, page, () => livePageForSender(sender))
      .then(reply)
      .catch(error => reply({ status: 'error', reason: String(error && (error as Error).message) }));
  });
});
