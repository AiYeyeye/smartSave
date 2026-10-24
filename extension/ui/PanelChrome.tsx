import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';
import {
  ArrowLeft,
  Download,
  FolderKanban,
  ListChecks,
  PanelLeftClose,
  Search,
  Settings,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';

/** Popup views. Long-running workbenches live in the options page. */
export type PopupView = 'browse' | 'settings';

export function SearchBox({
  value,
  onChange,
  autoFocus,
  focusRequest = 0,
  source = 'bookmarks',
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  focusRequest?: number;
  source?: 'bookmarks' | 'history';
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus || focusRequest > 0) input.current?.focus();
  }, [autoFocus, focusRequest]);
  return (
    <div className={`search zh-search${value ? ' has-query' : ''}`}>
      <Search aria-hidden="true" />
      <input
        ref={input}
        type="search"
        aria-label={t(source === 'history' ? '搜索历史' : '搜索书签')}
        placeholder={t(source === 'history' ? '搜索历史，或描述你浏览过的网页' : '搜索书签，或描述你要找的网站')}
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
        <button type="button" className="search-dismiss" aria-label={t('清空搜索')} onClick={() => onChange('')}>
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
  onClose,
  focusRequest,
  searchSource,
}: {
  view: PopupView;
  query: string;
  onQuery: (query: string) => void;
  onSettings: () => void;
  onBack: () => void;
  /** Overlay sidebar only: slide the sidebar away. */
  onClose?: () => void;
  focusRequest?: number;
  searchSource?: 'bookmarks' | 'history';
}) {
  const { t } = useI18n();
  const browse = view === 'browse';
  return (
    <>
      <header className="brand">
        {browse ? (
          <span className="zh-logo" aria-hidden="true" />
        ) : (
          <button type="button" className="header-back" aria-label={t('返回书签')} onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
          </button>
        )}
        <h1>{browse ? t('智栏') : t('快速设置')}</h1>
        {browse ? (
          <button
            type="button"
            className="chrome-icon zh-gear"
            aria-label={t('设置')}
            title={t('设置')}
            onClick={onSettings}
          >
            <Settings aria-hidden="true" />
          </button>
        ) : null}
        {onClose ? (
          <button
            type="button"
            className="chrome-icon"
            aria-label={t('收起侧栏')}
            title={t('收起（Esc）')}
            onClick={onClose}
          >
            <PanelLeftClose aria-hidden="true" />
          </button>
        ) : null}
      </header>
      {browse && (
        <SearchBox value={query} onChange={onQuery} autoFocus focusRequest={focusRequest} source={searchSource} />
      )}
    </>
  );
}

export function PanelFooter({
  onOrganize,
  onCheck,
  onImport,
  onExport,
  onBatch,
}: {
  onOrganize: () => void;
  onCheck?: () => void;
  onImport: () => void;
  onExport: () => void;
  onBatch: () => void;
}) {
  const { t } = useI18n();
  return (
    <footer className="zh-footer" aria-label={t('书签工具')}>
      <button type="button" title={t('在设置页中用 AI 整理选定目录')} onClick={onOrganize}>
        <FolderKanban aria-hidden="true" />
        {t('整理')}
      </button>
      {onCheck && (
        <button type="button" title={t('书签检查')} onClick={onCheck}>
          <ShieldCheck aria-hidden="true" />
          {t('检查')}
        </button>
      )}
      <button type="button" title={t('在设置页中导入书签文件')} onClick={onImport}>
        <Upload aria-hidden="true" />
        {t('导入')}
      </button>
      <button type="button" title={t('在设置页中导出与备份')} onClick={onExport}>
        <Download aria-hidden="true" />
        {t('导出')}
      </button>
      <button type="button" title={t('批量选择书签')} onClick={onBatch}>
        <ListChecks aria-hidden="true" />
        {t('批量')}
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
