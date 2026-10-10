import { ImportWorkbench } from '../panel/ImportWorkbench';
import { OrganizeWorkbench } from '../panel/OrganizeWorkbench';
import { SearchResults } from '../panel/SearchResults';
import { CurrentPageSave } from '../panel/CurrentPageSave';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsStore } from '../persistence/settings';
import { ThemeProvider } from './ThemeProvider';
import './theme.css';
import { BookmarkTree } from '../panel/BookmarkTree';
import { PanelChrome, PanelFooter, type Workbench } from './PanelChrome';
import { SettingsNav, type SettingsJump, type SettingsPage, type WorkbenchLink } from './SettingsNav';
import {
  AiServicesPage,
  parseAiServicesHash,
  TAB_HASH,
  useAiServices,
  type AiServicesTab,
} from '../options/ai-services';

export type Page = 'panel' | 'options';
/** Long-running workbenches live in the options page; the popup opens them there through a routing hash. */
export type OptionsRoute = 'browse' | 'organize' | 'import' | 'export' | 'settings' | 'ai-services';
const OPTIONS_PAGE = 'options/index.html';

/** The options page starts from its `#hash`; no hash is the settings hub. The popup always starts browsing. */
export function initialRoute(
  page: Page,
  hash: string,
): { workbench: Workbench; settingsPage: SettingsPage; aiTab: AiServicesTab } {
  if (page === 'panel') return { workbench: 'browse', settingsPage: 'overview', aiTab: 'connected' };
  const aiTab = parseAiServicesHash(hash);
  if (aiTab) return { workbench: 'ai-services', settingsPage: 'overview', aiTab };
  switch (hash.replace(/^#/, '')) {
    case 'browse':
    case 'organize':
    case 'import':
      return { workbench: hash.replace(/^#/, '') as Workbench, settingsPage: 'overview', aiTab: 'connected' };
    case 'export':
      return { workbench: 'settings', settingsPage: 'export-backup', aiTab: 'connected' };
    default:
      return { workbench: 'settings', settingsPage: 'overview', aiTab: 'connected' };
  }
}

/** Opens the options page at a route in a new tab; false means the browser boundary is unavailable (jsdom). */
function openOptionsRoute(route: string): boolean {
  if (typeof chrome === 'undefined' || typeof chrome.tabs?.create !== 'function' || !chrome.runtime?.getURL)
    return false;
  void Promise.resolve(chrome.tabs.create({ url: chrome.runtime.getURL(`${OPTIONS_PAGE}#${route}`) })).catch(() => {});
  return true;
}

const WORKBENCH_LINKS: WorkbenchLink[] = [
  { id: 'browse', title: '书签目录', hint: '浏览、搜索与批量管理书签' },
  { id: 'organize', title: 'AI 整理', hint: '范围内整理与精确去重' },
  { id: 'import', title: '导入书签', hint: '五种格式导入与分类' },
];

export function App({ page }: { page: Page }) {
  const [settingsStore] = useState(() =>
    typeof chrome !== 'undefined' && chrome.storage?.local ? new SettingsStore(chrome.storage.local) : undefined,
  );
  useEffect(() => () => settingsStore?.dispose(), [settingsStore]);
  const [route] = useState(() => initialRoute(page, typeof location === 'undefined' ? '' : location.hash));
  const [workbench, setWorkbench] = useState<Workbench>(route.workbench);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>(route.settingsPage);
  const [aiTab, setAiTab] = useState<AiServicesTab>(route.aiTab);
  const [batchNonce, setBatchNonce] = useState(0);
  const [settingsJump, setSettingsJump] = useState<SettingsJump>();
  const [query, setQuery] = useState('');
  const ai = useAiServices(settingsStore);
  const aiController = useMemo(
    () => ({
      services: ai.services,
      features: ai.features,
      persistService: ai.persistService,
      removeService: ai.removeService,
      assignFeature: ai.assignFeature,
      importConfig: ai.importConfig,
      exportConfig: ai.exportConfig,
      getCredential: ai.getCredential,
    }),
    [ai],
  );
  const onSettingsPage = useCallback((next: SettingsPage) => setSettingsPage(next), []);

  useEffect(() => {
    function onHash() {
      if (page !== 'options') return;
      const tab = parseAiServicesHash(location.hash);
      if (tab) {
        setAiTab(tab);
        setWorkbench('ai-services');
      }
    }
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [page]);

  function openSettings(pageName: SettingsPage = 'overview', extra?: Pick<SettingsJump, 'recovery'>) {
    setSettingsPage(pageName);
    setSettingsJump({ page: pageName, nonce: Date.now(), ...extra });
    setWorkbench('settings');
  }

  /** Open AI services management: panel → new options tab; options → in-place workbench. */
  function openAiServices(tab: AiServicesTab = 'connected') {
    const hash = TAB_HASH[tab];
    if (page === 'panel' && openOptionsRoute(hash)) return;
    setAiTab(tab);
    setWorkbench('ai-services');
    if (typeof location !== 'undefined' && location.hash.replace(/^#/, '') !== hash) location.hash = hash;
  }

  /** The popup hands organize/import to the options page; the options page (or a jsdom popup) switches in place. */
  function selectWorkbench(next: Workbench) {
    if (page === 'panel' && (next === 'organize' || next === 'import') && openOptionsRoute(next)) return;
    if (page === 'panel' && next === 'ai-services' && openOptionsRoute(TAB_HASH.connected)) return;
    setWorkbench(next);
  }

  function exportBackup() {
    if (page === 'panel' && openOptionsRoute('export')) return;
    openSettings('export-backup', { recovery: page === 'options' });
  }

  return (
    <ThemeProvider>
      <div className={`shell ${page}${workbench === 'ai-services' ? ' ai-services-wide' : ''}`}>
        <a className="skip-link" href="#main">
          跳到主要内容
        </a>
        <PanelChrome
          page={page}
          workbench={workbench}
          settingsPage={settingsPage}
          onWorkbench={selectWorkbench}
          onSettingsPage={onSettingsPage}
          onBatch={() => setBatchNonce(value => value + 1)}
          onExport={exportBackup}
          onSettings={() => openSettings('overview')}
          onQuery={setQuery}
        />
        <main id="main" tabIndex={-1}>
          {page === 'panel' && (
            <div hidden={workbench !== 'browse'}>
              <CurrentPageSave settings={settingsStore} />
            </div>
          )}
          <div hidden={workbench !== 'browse'}>
            <SearchResults query={query} settings={settingsStore} onOrganize={() => selectWorkbench('organize')} />
          </div>
          <section className="directory" hidden={workbench !== 'browse'} aria-label="书签目录">
            <BookmarkTree batchNonce={batchNonce} />
          </section>
          <OrganizeWorkbench visible={workbench === 'organize'} settings={settingsStore} />
          <ImportWorkbench visible={workbench === 'import'} settings={settingsStore} />
          <div hidden={workbench !== 'ai-services'}>
            {workbench === 'ai-services' && (
              <AiServicesPage tab={aiTab} onTab={setAiTab} controller={aiController} settings={settingsStore} />
            )}
          </div>
          <SettingsNav
            visible={workbench === 'settings'}
            store={settingsStore}
            jump={settingsJump}
            page={settingsPage}
            onPage={onSettingsPage}
            workbenches={page === 'options' ? WORKBENCH_LINKS : undefined}
            onWorkbench={setWorkbench}
            aiServices={{ services: ai.services, features: ai.features }}
            onOpenAiServices={openAiServices}
            onAssignFeature={(featureId, connId, modelId) => {
              void Promise.resolve(ai.assignFeature(featureId, connId, modelId));
            }}
          />
        </main>
        {page === 'panel' && workbench === 'browse' && (
          <PanelFooter
            onOrganize={() => selectWorkbench('organize')}
            onImport={() => selectWorkbench('import')}
            onExport={exportBackup}
          />
        )}
      </div>
    </ThemeProvider>
  );
}
