import { startFileOutput } from './file-output';
import { ImportPersistenceStore } from '../persistence/import-persistence';
import { startImportAuthority } from './import-authority';
import { SettingsStore } from '../persistence/settings';
import { startOrganizerAuthority } from './organizer-authority';
import { startSaveEntrypoints } from './save-entrypoints';
import { startTreeService } from './tree-service';
import { startMutationService } from './mutation-service';
function configurePanel() {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch((error: unknown) => {
    console.error('智栏侧栏入口配置失败', error);
  });
}
chrome.runtime.onInstalled.addListener(configurePanel);
chrome.runtime.onStartup.addListener(configurePanel);
// Reassert the single custom toolbar owner on every worker evaluation, including wakeups.
configurePanel();
const validateSaveContext = startSaveEntrypoints(() => coordinator?.purgeSavePreviews());
const projection = startTreeService();
startFileOutput(projection);
const settings = new SettingsStore(chrome.storage.local);
const persistence = new ImportPersistenceStore();
const coordinator = startMutationService(projection, validateSaveContext, startOrganizerAuthority(settings), startImportAuthority(settings, projection, persistence.importCheckpoints), persistence);
