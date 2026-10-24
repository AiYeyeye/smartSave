import { useEffect, useState } from 'react';
import { SearchResults } from './SearchResults';
import { HistorySearch } from './HistorySearch';
import type { SearchSource } from '../domain/history-search';
import type { SettingsStore } from '../persistence/settings';
import type { AiServicesStore } from '../persistence/ai-services';
import { useI18n } from '../ui/i18n';
export function SearchWorkspace({
  query,
  source,
  onSource,
  recentBookmarks = false,
  onRecentBookmarks,
  settings,
  services,
  onOrganize,
  visible = true,
}: {
  query: string;
  source: SearchSource;
  onSource: (source: SearchSource) => void;
  recentBookmarks?: boolean;
  onRecentBookmarks?: (value: boolean) => void;
  settings?: SettingsStore;
  services?: AiServicesStore;
  onOrganize?: () => void;
  visible?: boolean;
}) {
  const { t } = useI18n();
  const [historyOpened, setHistoryOpened] = useState(false);
  useEffect(() => {
    if (source !== 'bookmarks') setHistoryOpened(true);
  }, [source]);
  return (
    <>
      <div className="search-scopes" role="group" aria-label={t('搜索范围')}>
        <button
          type="button"
          aria-pressed={source === 'bookmarks' && !recentBookmarks}
          onClick={() => {
            onRecentBookmarks?.(false);
            onSource('bookmarks');
          }}
        >
          {t('目录')}
        </button>
        {onRecentBookmarks && (
          <button
            type="button"
            aria-pressed={source === 'bookmarks' && recentBookmarks}
            onClick={() => {
              onRecentBookmarks(true);
              onSource('bookmarks');
            }}
          >
            {t('最近收藏')}
          </button>
        )}
        <button type="button" aria-pressed={source === 'history'} onClick={() => onSource('history')}>
          {t('历史')}
        </button>
      </div>
      <div hidden={source === 'history'}>
        <SearchResults
          query={query}
          recentView={recentBookmarks}
          settings={settings}
          services={services}
          onOrganize={onOrganize}
          active={visible && source !== 'history'}
        />
      </div>
      {(historyOpened || source !== 'bookmarks') && (
        <HistorySearch
          query={query}
          active={visible && source !== 'bookmarks'}
          settings={settings}
          services={services}
        />
      )}
    </>
  );
}
