import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bookmark, Search, X } from 'lucide-react';
import { CommandMenu } from './CommandMenu';
import type { SettingsPage } from './SettingsNav';

export type Workbench = 'browse' | 'organize' | 'import' | 'settings';

export function PanelChrome({ page, workbench, settingsPage, onWorkbench, onSettingsPage, onBatch, onExport, onSettings, onQuery }: {
  page: 'panel' | 'options';
  workbench: Workbench;
  settingsPage: SettingsPage;
  onWorkbench: (workbench: Workbench) => void;
  onSettingsPage: (page: SettingsPage) => void;
  onBatch: () => void;
  onExport: () => void;
  onSettings: () => void;
  onQuery: (query: string) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchOpen) input.current?.focus(); }, [searchOpen]);
  function setOpen(next: boolean) { setSearchOpen(next); onQuery(next ? query : ''); }
  function setSearch(value: string) { setQuery(value); if (searchOpen) onQuery(value); }
  const settingsDetail = workbench === 'settings' && settingsPage !== 'overview';
  const titles: Record<SettingsPage, string> = { overview: '设置', appearance: '外观', model: 'AI 模型', privacy: '隐私', 'export-backup': '导出与备份' };
  function back() {
    if (settingsDetail) onSettingsPage('overview');
    else onWorkbench('browse');
  }
  const showBack = (page === 'panel' && workbench !== 'browse') || (page === 'options' && settingsDetail);
  return <>
    <header className="brand">
      {showBack ? <button type="button" className="header-back" aria-label={settingsDetail ? '返回设置' : '返回书签'} onClick={back}><ArrowLeft aria-hidden="true" /></button> : <Bookmark aria-hidden="true" />}
      <h1>{workbench === 'settings' ? titles[settingsPage] : workbench === 'organize' ? 'AI 整理' : workbench === 'import' ? '导入书签' : '智栏'}</h1>
      {page === 'panel' && workbench === 'browse' && <>
        <button type="button" className="chrome-icon" aria-label="搜索" aria-expanded={searchOpen} onClick={() => setOpen(!searchOpen)}><Search aria-hidden="true" /></button>
        <CommandMenu label="更多操作" items={[
          { id: 'organize', label: 'AI 整理', onSelect: () => onWorkbench('organize') },
          { id: 'import', label: '导入', onSelect: () => onWorkbench('import') },
          { id: 'export', label: '导出', onSelect: onExport },
          { id: 'batch', label: '批量管理', onSelect: () => { onWorkbench('browse'); onBatch(); } },
          { id: 'settings', label: '设置', onSelect: onSettings },
        ]}>⋯</CommandMenu>
      </>}
    </header>
    {page === 'panel' && searchOpen && <div className="search" hidden={workbench !== 'browse'}>
      <Search aria-hidden="true" />
      <input ref={input} type="search" aria-label="搜索书签" placeholder="搜索书签" value={query} onChange={event => setSearch(event.target.value)} onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (query) setSearch('');
          else setOpen(false);
        }
      }} />
      <button type="button" className="search-dismiss" aria-label="收起搜索" onClick={() => setOpen(false)}><X aria-hidden="true" /></button>
    </div>}
  </>;
}
