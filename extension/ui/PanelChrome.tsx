import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, FolderKanban, ListChecks, Search, Settings, Upload, X } from 'lucide-react';

/** Popup views. Long-running workbenches live in the options page. */
export type PopupView = 'browse' | 'settings';

export function SearchBox({
  value,
  onChange,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  return (
    <div className={`search zh-search${value ? ' has-query' : ''}`}>
      <Search aria-hidden="true" />
      <input
        ref={input}
        type="search"
        aria-label="搜索书签"
        placeholder="搜索书签，或描述你要找的网站"
        value={value}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape' && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange('');
          }
        }}
      />
      {value ? (
        <button type="button" className="search-dismiss" aria-label="清空搜索" onClick={() => onChange('')}>
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function PanelChrome({
  view,
  query,
  onQuery,
  onSettings,
  onBack,
}: {
  view: PopupView;
  query: string;
  onQuery: (query: string) => void;
  onSettings: () => void;
  onBack: () => void;
}) {
  const browse = view === 'browse';
  return (
    <>
      <header className="brand">
        {browse ? (
          <span className="zh-logo" aria-hidden="true" />
        ) : (
          <button type="button" className="header-back" aria-label="返回书签" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
          </button>
        )}
        <h1>{browse ? '智栏' : '快速设置'}</h1>
        {browse ? (
          <button type="button" className="chrome-icon zh-gear" aria-label="设置" title="设置" onClick={onSettings}>
            <Settings aria-hidden="true" />
          </button>
        ) : null}
      </header>
      {browse && <SearchBox value={query} onChange={onQuery} autoFocus />}
    </>
  );
}

export function PanelFooter({
  onOrganize,
  onImport,
  onExport,
  onBatch,
}: {
  onOrganize: () => void;
  onImport: () => void;
  onExport: () => void;
  onBatch: () => void;
}) {
  return (
    <footer className="zh-footer" aria-label="书签工具">
      <button type="button" title="在设置页中用 AI 整理选定目录" onClick={onOrganize}>
        <FolderKanban aria-hidden="true" />
        整理
      </button>
      <button type="button" title="在设置页中导入书签文件" onClick={onImport}>
        <Upload aria-hidden="true" />
        导入
      </button>
      <button type="button" title="在设置页中导出与备份" onClick={onExport}>
        <Download aria-hidden="true" />
        导出
      </button>
      <button type="button" title="批量选择书签" onClick={onBatch}>
        <ListChecks aria-hidden="true" />
        批量
      </button>
    </footer>
  );
}

/** Keeps a query local to the popup and clears it when leaving the browse view. */
export function usePopupQuery(view: PopupView) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (view !== 'browse') setQuery('');
  }, [view]);
  return [query, setQuery] as const;
}
