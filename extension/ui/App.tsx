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
import { SettingsNav, type SettingsJump, type SettingsPage } from './SettingsNav';

export function App({ page }: { page: 'panel' | 'options' }) {
  const [settingsStore] = useState(() => typeof chrome !== 'undefined' && chrome.storage?.local ? new SettingsStore(chrome.storage.local) : undefined);
  useEffect(() => () => settingsStore?.dispose(), [settingsStore]);
  const [workbench, setWorkbench] = useState<Workbench>(page === 'options' ? 'settings' : 'browse');
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('overview');
  const [batchNonce, setBatchNonce] = useState(0);
  const [settingsJump, setSettingsJump] = useState<SettingsJump>();
  const [query, setQuery] = useState('');
  const onSettingsPage = useCallback((next: SettingsPage) => setSettingsPage(next), []);
  function openSettings(pageName: SettingsPage = 'overview', extra?: Pick<SettingsJump, 'recovery'>) {
    setSettingsPage(pageName);
    setSettingsJump({ page: pageName, nonce: Date.now(), ...extra });
    setWorkbench('settings');
  }
  return <ThemeProvider><div className={`shell ${page}`}>
    <a className="skip-link" href="#main">跳到主要内容</a>
    <PanelChrome page={page} workbench={workbench} settingsPage={settingsPage} onWorkbench={setWorkbench} onSettingsPage={onSettingsPage} onBatch={() => setBatchNonce(value => value + 1)} onExport={() => openSettings('export-backup', { recovery: false })} onSettings={() => openSettings('overview')} onQuery={setQuery} />
    <main id="main" tabIndex={-1}>
      {page === 'panel' && <div hidden={workbench !== 'browse'}><CurrentPageSave settings={settingsStore} /></div>}
      {page === 'panel' && <div hidden={workbench !== 'browse'}><SearchResults query={query} settings={settingsStore} onOrganize={() => setWorkbench('organize')} /></div>}
      {page === 'panel' && <section className="directory" hidden={workbench !== 'browse'} aria-label="书签目录"><BookmarkTree batchNonce={batchNonce} /></section>}
      {page === 'panel' && <OrganizeWorkbench visible={workbench === 'organize'} settings={settingsStore} />}
      {page === 'panel' && <ImportWorkbench visible={workbench === 'import'} settings={settingsStore} />}
      <SettingsNav visible={workbench === 'settings'} store={settingsStore} jump={settingsJump} page={settingsPage} onPage={onSettingsPage} />
    </main>
  </div></ThemeProvider>;
}
