import { ExportSettings } from '../options/ExportSettings';
import { ImportWorkbench } from '../panel/ImportWorkbench';
import { OrganizeWorkbench } from '../panel/OrganizeWorkbench';
import { SearchResults } from '../panel/SearchResults';
import { CurrentPageSave } from '../panel/CurrentPageSave';
import { ModelSettings } from '../options/ModelSettings';
import { RecoveryWorkbench } from '../options/RecoveryWorkbench';
import { useEffect, useState } from 'react';
import { SettingsStore } from '../persistence/settings';
import { SiteRulesSettings } from '../options/SiteRulesSettings';
import { Bookmark, FolderOpen, Search, Settings, SlidersHorizontal, ArrowDownToLine } from 'lucide-react';
import { ThemePicker, ThemeProvider } from './ThemeProvider';
import './theme.css';
import { BookmarkTree } from '../panel/BookmarkTree';
import { SidebarPosition } from './SidebarPosition';

export function App({ page }: { page: 'panel' | 'options' }) {
  const [settingsStore] = useState(() => typeof chrome !== 'undefined' && chrome.storage?.local ? new SettingsStore(chrome.storage.local) : undefined);
  useEffect(() => () => settingsStore?.dispose(), [settingsStore]);
  const [appearance, setAppearance] = useState(page === 'options');
  const [organize, setOrganize] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(page === 'options');
  const [search, setSearch] = useState('');
  return <ThemeProvider><div className={`shell ${page}`}>
    <a className="skip-link" href="#main">跳到主要内容</a>
    <header className="brand"><Bookmark aria-hidden="true" /><h1>智栏<span>书签助手</span></h1>
      {page === 'panel' && <button aria-label="外观设置" aria-expanded={appearance} onClick={() => setAppearance(!appearance)}><Settings aria-hidden="true" /></button>}
    </header>
    {page === 'panel' && <>
      <div className="search"><Search aria-hidden="true" /><input type="search" aria-label="搜索书签" placeholder="搜索书签" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <CurrentPageSave settings={settingsStore} />
    </>}
    <main id="main" tabIndex={-1}>
      {appearance && <section className="surface" aria-label="外观设置"><h2>外观</h2><ThemePicker /><SidebarPosition /></section>}
      {page === 'panel' && <SearchResults query={search} settings={settingsStore} onOrganize={() => setOrganize(true)} />}
      {page === 'panel' && <section className="directory" aria-label="书签目录"><h2><FolderOpen aria-hidden="true" />书签目录</h2>
        <BookmarkTree />
      </section>}
      {page === 'panel' && <OrganizeWorkbench visible={organize} settings={settingsStore} />}
      {page === 'panel' && <ImportWorkbench visible={importing} settings={settingsStore} />}
      <button aria-expanded={exporting} onClick={() => setExporting(!exporting)}>导出</button>
      <ExportSettings visible={exporting} />
      {page === 'options' && <RecoveryWorkbench />}
      {(page === 'options' || appearance) && <><ModelSettings store={settingsStore} /><SiteRulesSettings /></>}
    </main>
    <footer><span className="hint">智栏 · 原生书签</span>{page === 'panel' && <div className="tools"><button aria-expanded={organize} onClick={() => setOrganize(!organize)}><SlidersHorizontal aria-hidden="true" />整理</button><button aria-expanded={importing} onClick={() => setImporting(!importing)}><ArrowDownToLine aria-hidden="true" />导入</button></div>}</footer>
  </div></ThemeProvider>;
}
