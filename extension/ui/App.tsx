import { ImportWorkbench } from '../panel/ImportWorkbench';
import { OrganizeWorkbench } from '../panel/OrganizeWorkbench';
import { SearchResults } from '../panel/SearchResults';
import { CurrentPageSave } from '../panel/CurrentPageSave';
import { useCallback, useEffect, useState } from 'react';
import { SettingsStore } from '../persistence/settings';
import { ThemeProvider } from './ThemeProvider';
import './theme.css';
import { BookmarkTree } from '../panel/BookmarkTree';
import { PanelChrome, type Workbench } from './PanelChrome';
import { SettingsNav, type SettingsJump, type SettingsPage, type WorkbenchLink } from './SettingsNav';

export type Page = 'panel' | 'options';
/** Long-running workbenches live in the options page; the popup opens them there through a routing hash. */
export type OptionsRoute = 'browse' | 'organize' | 'import' | 'export' | 'settings';
const OPTIONS_PAGE = 'options/index.html';

/** The options page starts from its `#hash`; no hash is the settings hub. The popup always starts browsing. */
export function initialRoute(page: Page, hash: string): { workbench: Workbench; settingsPage: SettingsPage } {
  if (page === 'panel') return { workbench: 'browse', settingsPage: 'overview' };
  switch (hash.replace(/^#/, '')) {
    case 'browse':
    case 'organize':
    case 'import':
      return { workbench: hash.replace(/^#/, '') as Workbench, settingsPage: 'overview' };
    case 'export':
      return { workbench: 'settings', settingsPage: 'export-backup' };
    default:
      return { workbench: 'settings', settingsPage: 'overview' };
  }
}
/** Opens the options page at a route in a new tab; false means the browser boundary is unavailable (jsdom). */
function openOptionsRoute(route: Exclude<OptionsRoute, 'settings'>): boolean {
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
  const [batchNonce, setBatchNonce] = useState(0);
  const [settingsJump, setSettingsJump] = useState<SettingsJump>();
  const [query, setQuery] = useState('');
  const onSettingsPage = useCallback((next: SettingsPage) => setSettingsPage(next), []);
  function openSettings(pageName: SettingsPage = 'overview', extra?: Pick<SettingsJump, 'recovery'>) {
    setSettingsPage(pageName);
    setSettingsJump({ page: pageName, nonce: Date.now(), ...extra });
    setWorkbench('settings');
  }
  /** The popup hands organize/import to the options page; the options page (or a jsdom popup) switches in place. */
  function selectWorkbench(next: Workbench) {
    if (page === 'panel' && (next === 'organize' || next === 'import') && openOptionsRoute(next)) return;
    setWorkbench(next);
  }
  function exportBackup() {
    if (page === 'panel' && openOptionsRoute('export')) return;
    openSettings('export-backup', { recovery: page === 'options' });
  }
  return (
    <ThemeProvider>
      <div className={`shell ${page}`}>
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
          <SettingsNav
            visible={workbench === 'settings'}
            store={settingsStore}
            jump={settingsJump}
            page={settingsPage}
            onPage={onSettingsPage}
            workbenches={page === 'options' ? WORKBENCH_LINKS : undefined}
            onWorkbench={setWorkbench}
          />
        </main>
      </div>
    </ThemeProvider>
  );
}
