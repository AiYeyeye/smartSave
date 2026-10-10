import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Download,
  FolderKanban,
  Search,
  Settings,
  Upload,
  X,
} from 'lucide-react';
import { CommandMenu } from './CommandMenu';
import type { SettingsPage } from './SettingsNav';

export type Workbench = 'browse' | 'organize' | 'import' | 'settings' | 'ai-services';

export function PanelChrome({
  page,
  workbench,
  settingsPage,
  onWorkbench,
  onSettingsPage,
  onBatch,
  onExport,
  onSettings,
  onQuery,
}: {
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
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const browse = workbench === 'browse';
  const settingsDetail = workbench === 'settings' && settingsPage !== 'overview';
  const titles: Record<SettingsPage, string> = {
    overview: '设置',
    appearance: '外观',
    model: 'AI 模型',
    privacy: '隐私',
    'export-backup': '导出与备份',
  };
  // The popup returns to browsing; the options page returns to its settings hub.
  const home: Workbench = page === 'panel' ? 'browse' : 'settings';
  function back() {
    if (settingsDetail) onSettingsPage('overview');
    else onWorkbench(home);
  }
  const showBack = settingsDetail || workbench !== home;
  const backLabel = settingsDetail || home === 'settings' ? '返回设置' : '返回书签';

  function setSearch(value: string) {
    setQuery(value);
    if (browse) onQuery(value);
  }

  useEffect(() => {
    if (!browse) onQuery('');
    else onQuery(query);
  }, [browse]); // eslint-disable-line react-hooks/exhaustive-deps -- only clear/restore when leaving browse

  const headerTitle =
    workbench === 'settings'
      ? titles[settingsPage]
      : workbench === 'organize'
        ? 'AI 整理'
        : workbench === 'import'
          ? '导入书签'
          : workbench === 'ai-services'
            ? 'AI 服务管理'
            : '智栏';

  return (
    <>
      <header className={`brand${browse && page === 'panel' ? ' brand-zh' : ''}`}>
        {showBack ? (
          <button type="button" className="header-back" aria-label={backLabel} onClick={back}>
            <ArrowLeft aria-hidden="true" />
          </button>
        ) : browse && page === 'panel' ? (
          <span className="zh-logo" aria-hidden="true" />
        ) : (
          <span className="zh-logo" aria-hidden="true" />
        )}
        <h1>{headerTitle}</h1>
        {browse && (
          <>
            {page === 'options' && (
              <CommandMenu
                label="更多操作"
                items={[
                  { id: 'organize', label: 'AI 整理', onSelect: () => onWorkbench('organize') },
                  { id: 'import', label: '导入', onSelect: () => onWorkbench('import') },
                  { id: 'export', label: '导出', onSelect: onExport },
                  {
                    id: 'batch',
                    label: '批量管理',
                    onSelect: () => {
                      onWorkbench('browse');
                      onBatch();
                    },
                  },
                  { id: 'settings', label: '设置', onSelect: onSettings },
                ]}
              >
                ⋯
              </CommandMenu>
            )}
            {page === 'panel' && (
              <button type="button" className="chrome-icon zh-gear" aria-label="设置" title="设置" onClick={onSettings}>
                <Settings aria-hidden="true" />
              </button>
            )}
          </>
        )}
      </header>
      {browse && (
        <div className={`search zh-search${query ? ' has-query' : ''}`}>
          <Search aria-hidden="true" />
          <input
            ref={input}
            type="search"
            aria-label="搜索书签"
            placeholder="搜索书签或描述你要找的网站"
            value={query}
            onChange={event => setSearch(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                if (query) setSearch('');
              }
            }}
          />
          {query ? (
            <button type="button" className="search-dismiss" aria-label="清空搜索" onClick={() => setSearch('')}>
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}


export function PanelFooter({
  onOrganize,
  onImport,
  onExport,
}: {
  onOrganize: () => void;
  onImport: () => void;
  onExport: () => void;
}) {
  return (
    <footer className="zh-footer" aria-label="书签工具">
      <button type="button" title="整理" onClick={onOrganize}>
        <FolderKanban aria-hidden="true" />
        整理
      </button>
      <button type="button" title="导入" onClick={onImport}>
        <Upload aria-hidden="true" />
        导入
      </button>
      <button type="button" title="导出" onClick={onExport}>
        <Download aria-hidden="true" />
        导出
      </button>
    </footer>
  );
}
