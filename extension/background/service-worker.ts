import { bookmarksWrite } from '../adapters/bookmarks-write';
import { startFileOutput } from './file-output';
import { ImportPersistenceStore } from '../persistence/import-persistence';
import { startImportAuthority } from './import-authority';
import { SettingsStore } from '../persistence/settings';
import { AiServicesStore } from '../persistence/ai-services';
import { featureModelSettings } from '../adapters/feature-model-settings';
import { startOrganizerAuthority } from './organizer-authority';
import { startSaveEntrypoints } from './save-entrypoints';
import { SaveDialogHost, startSaveDialogService } from './save-dialog';
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
import { startSearchEntrypoints } from './search-entrypoints';
import { startMutationService } from './mutation-service';
import { extractSaveBodyForUi } from './extract-coordinator';
import { setOverlayDocumentTrust, withTrustedSender } from '../domain/trusted-sender';
import { OwnWriteGuard } from './own-write-guard';
import { nativeSaveBadge, startNativeBookmarkIngress } from './native-bookmark-ingress';
import { SiteRulesStore } from '../persistence/site-rules';
import { pendingSaveReceipts, readSaveReceipts, SaveReceiptLog } from '../persistence/save-receipts';
import { startWorkerDiagnostics } from './worker-diagnostics';
import { OrganizeTaskOwner } from './organize-task-owner';
import { startOrganizeTaskService } from './organize-task-service';
import { OrganizeMemoryStore } from '../persistence/organize-memory';
import { OrganizeTaskAuthority } from './organize-task-authority';
import { actionBadges } from './action-badge';
import { OrganizeTaskBadge } from './organize-task-badge';
import { SaveCorrectionOwner, startSaveCorrectionService } from './save-correction';
import { BookmarkKeywordsStore } from '../persistence/bookmark-keywords';
import { startBookmarkKeywords } from './bookmark-keywords';
import { CorrectionLearning } from './correction-learning';
import { saveNameSuggestions } from './save-name-suggestion';
import { startNativePreferenceLearning } from './native-preference-learning';
import { watchBrowserLanguage } from '../domain/browser-message';

watchBrowserLanguage();
const workerDiagnostics = startWorkerDiagnostics();
const badges = actionBadges();
if (badges) void badges.initialize(chrome.tabs);

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

const saveDialog = new SaveDialogHost({
  pending: async () =>
    pendingSaveReceipts(await readSaveReceipts(chrome.storage.local))
      .map(receipt => receipt.id)
      .reverse(),
  hint: (tabId, on) => void Promise.resolve(badges?.savePending(tabId, on)).catch(() => {}),
});
startSaveDialogService(saveDialog);

const { validateSaveContext, livePageForSender } = startSaveEntrypoints(
  () => coordinator?.purgeSavePreviews(),
  tabId =>
    saveDialog.openCapture(tabId).catch(async () => {
      await badges?.savePending(tabId, true);
    }),
  saveDialog,
);
const projection = startTreeService();
const bookmarkKeywords = new BookmarkKeywordsStore(chrome.storage.local, () => projection.fresh());
startBookmarkKeywords(bookmarkKeywords, projection);
startSearchEntrypoints(projection, chrome, () => bookmarkKeywords.read());
startFileOutput(projection);
const settings = new SettingsStore(chrome.storage.local);
// Complete first-install migration before a model task can retain its settings baseline.
// Native ingress also loads settings; a later first write must not revoke an otherwise unchanged organizer task.
const settingsReady = settings.load();
void settingsReady.catch(() => {});
const initializedSettings = {
  snapshot: async () => {
    await settingsReady;
    return settings.snapshot();
  },
  subscribe: (listener: () => void) => settings.subscribe(listener),
};
const aiServices = new AiServicesStore(chrome.storage.local);
const ownWrites = new OwnWriteGuard();
const writer = ownWrites.wrap(bookmarksWrite(chrome.bookmarks));
const persistence = new ImportPersistenceStore();
const organizeSettings = featureModelSettings(initializedSettings, aiServices, 'organize');
const correctionLearning = new CorrectionLearning(projection, organizeSettings, chrome.storage.local);
const learningReady = settingsReady.then(() => persistence.all()).then(records => correctionLearning.start(records));
void learningReady.catch(() => {});
startNativePreferenceLearning({
  projection,
  bookmarks: chrome.bookmarks,
  guard: ownWrites,
  settings: organizeSettings,
  learn: async (id, installationId, examples) => {
    await learningReady;
    await correctionLearning.enqueue(id, installationId, examples);
  },
});
const organizeMemory = new OrganizeMemoryStore(chrome.storage.local);
const organizerAuthority = startOrganizerAuthority(organizeSettings, workerDiagnostics);
const organizeTasks = new OrganizeTaskOwner({
  projection,
  settings: organizeSettings,
  store: persistence.organizeCheckpoints,
  memory: organizeMemory,
  learn: async (id, installationId, examples) => {
    await learningReady;
    await correctionLearning.enqueue(id, installationId, examples);
  },
});
const organizeBadge = badges ? new OrganizeTaskBadge(badges, chrome.storage.session) : undefined;
if (organizeBadge) {
  organizeTasks.subscribe(view => organizeBadge.observe(view));
  void organizeBadge.restore(persistence.organizeCheckpoints);
}
const organizeTaskAuthority = new OrganizeTaskAuthority(
  organizeSettings,
  projection,
  persistence.organizeCheckpoints,
  organizerAuthority,
  chrome.runtime.id,
  organizeMemory,
  checkpoint => organizeTasks.submitted(checkpoint),
);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of Object.keys(changes)) {
    if (!key.startsWith('organize.memory.')) continue;
    try {
      const installationId = decodeURIComponent(key.slice('organize.memory.'.length));
      organizeTaskAuthority.memoryChanged(installationId);
      void organizeTasks.refreshMemory(installationId).catch(() => {});
    } catch {
      /* An unrelated malformed storage key does not change task authority. */
    }
  }
});
const coordinator = startMutationService(
  projection,
  validateSaveContext,
  organizerAuthority,
  startImportAuthority(
    featureModelSettings(initializedSettings, aiServices, 'import'),
    projection,
    persistence.importCheckpoints,
  ),
  persistence,
  writer,
  organizeTaskAuthority,
);
const saveReceipts = new SaveReceiptLog(chrome.storage.local);
coordinator.onCompleted = async record => {
  await learningReady;
  await correctionLearning.observe(record);
};
const siteRules = new SiteRulesStore(chrome.storage.local);
const nativeSaves = startNativeBookmarkIngress({
  projection,
  settings,
  aiServices,
  writer,
  guard: ownWrites,
  receipts: saveReceipts,
  reviewWindow: async () => (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id,
  reviewReady: (receipt, windowId) => saveDialog.openAutomatic(receipt.id, windowId),
  suggestName: saveNameSuggestions(
    projection,
    featureModelSettings(initializedSettings, aiServices, 'save'),
    saveReceipts,
  ),
  rules: siteRules,
  keywords: bookmarkKeywords,
  badge: nativeSaveBadge,
});
startSaveCorrectionService(new SaveCorrectionOwner(projection, coordinator, saveReceipts, siteRules));

startOrganizeTaskService(organizeTasks, organizeBadge);

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
