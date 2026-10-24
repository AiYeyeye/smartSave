import { useEffect, useMemo, useRef, useState } from 'react';
import { browserModelAuthority } from '../adapters/model-authority';
import { searchModelAuthority } from '../adapters/search-model-authority';
import type { AiServicesStore } from '../persistence/ai-services';
import { ModelTransport } from '../adapters/model-transport';
import type { SettingsStore } from '../persistence/settings';
import { connectTree } from './tree-client';
import { SearchController, type SearchState } from './search-controller';
import type { NodeRef, TreeSnapshot, TreeState } from '../domain/node-reference';
import { TreeRows } from './BookmarkTree';
import './search-results.css';
import { BusyIndicator } from '../ui/BusyIndicator';
import { DeferredNotice } from '../ui/DeferredNotice';
import { useI18n } from '../ui/i18n';
import { searchStatusText } from './search-status-text';
import { watchBookmarkKeywords } from '../persistence/bookmark-keywords';
import { BOOKMARK_PERIODS, type BookmarkPeriod } from '../domain/bookmark-recency';
import { searchFolderOptions } from '../domain/search-scope';
export function SearchResults({
  query,
  settings,
  services,
  onOrganize,
  active = true,
  recentView = false,
}: {
  query: string;
  settings?: SettingsStore;
  services?: AiServicesStore;
  onOrganize?: () => void;
  active?: boolean;
  recentView?: boolean;
}) {
  const { t, language } = useI18n();
  const statusText = (text: string) => searchStatusText(language, text);
  const [snapshot, setSnapshot] = useState<TreeSnapshot>();
  const [period, setPeriod] = useState<BookmarkPeriod>('auto');
  const [folderScope, setFolderScope] = useState<NodeRef>();
  const folders = useMemo(() => (snapshot ? searchFolderOptions(snapshot, t('根目录')) : []), [snapshot, t]);
  const folderValue = folderScope ? JSON.stringify(folderScope) : '';
  const [state, setState] = useState<SearchState>({
    query,
    hits: [],
    status: 'loading',
    message: '',
    reranking: false,
    connectionReady: false,
    connectionFailed: false,
    connectionMessage: '',
  });
  const controller = useRef<SearchController | undefined>(undefined);
  const retry = useRef<() => void>(() => {});
  const latestQuery = useRef(query);
  const latestFilter = useRef({ period, recentView, folderScope });
  latestFilter.current = { period, recentView, folderScope };
  latestQuery.current = query;
  useEffect(() => {
    const authority =
      settings && typeof chrome !== 'undefined'
        ? searchModelAuthority(browserModelAuthority(settings), services)
        : undefined;
    const transport = authority
      ? new ModelTransport(
          { fetch: (...args) => fetch(...args), contains: request => chrome.permissions.contains(request) },
          authority,
        )
      : undefined;
    const owner = new SearchController(setState, authority, transport);
    const stopKeywords = watchBookmarkKeywords(records => owner.setKeywords(records));
    controller.current = owner;
    owner.setCollectionFilter(latestFilter.current.period, latestFilter.current.recentView);
    owner.setFolderScope(latestFilter.current.folderScope);
    owner.setQuery(latestQuery.current);
    const receiveTree = (tree: TreeState) => {
      if (tree.status === 'ready') setSnapshot(tree.snapshot);
      owner.setTree(tree);
    };
    let stop =
      typeof chrome !== 'undefined' && typeof chrome.runtime?.connect === 'function'
        ? connectTree(chrome.runtime, receiveTree)
        : undefined;
    if (!stop) owner.setTree({ status: 'error', message: '书签服务不可用。' });
    retry.current = () => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return;
      stop?.();
      stop = connectTree(chrome.runtime, receiveTree);
    };
    return () => {
      stopKeywords();
      stop?.();
      owner.dispose();
      controller.current = undefined;
      retry.current = () => {};
    };
  }, [settings, services]);
  useEffect(() => {
    controller.current?.setQuery(query);
  }, [query]);
  useEffect(() => {
    controller.current?.setCollectionFilter(period, recentView);
  }, [period, recentView]);
  useEffect(() => {
    controller.current?.setFolderScope(folderScope);
  }, [folderScope]);
  useEffect(() => {
    if (!active) controller.current?.cancel();
  }, [active]);
  if (!query.trim() && !recentView) return null;
  const labels = {
    auto: '自动范围',
    today: '今天',
    '7': '近 7 天',
    '30': '近 30 天',
    '90': '近 90 天',
    '360': '近 360 天',
    all: '全部时间',
  } as const;
  const writeIntent = /整理|移动|删除|重命名|合并|^(organize|move|delete|rename|merge)\b/i.test(query.trim());
  return (
    <section
      className={`surface search-results${!state.connectionReady && !state.connectionFailed ? ' is-refreshing' : ''}`}
      aria-label={t(query.trim() ? '搜索结果' : '最近收藏')}
      aria-busy={!state.connectionReady || state.reranking}
    >
      <div className="search-filters">
        <label className="bookmark-folder-filter">
          {t('搜索文件夹')}
          <select
            aria-label={t('搜索文件夹')}
            value={folderValue}
            disabled={!state.connectionReady}
            onChange={event => {
              const value = folders.find(folder => JSON.stringify(folder.ref) === event.target.value)?.ref;
              controller.current?.setFolderScope(value);
              setFolderScope(value);
            }}
          >
            <option value="">{t('全部文件夹')}</option>
            {state.folderUnavailable && (
              <option value={folderValue} disabled>
                {t('文件夹不可用')}
              </option>
            )}
            {folders
              .filter(folder => !state.folderUnavailable || JSON.stringify(folder.ref) !== folderValue)
              .map(folder => (
                <option key={JSON.stringify(folder.ref)} value={JSON.stringify(folder.ref)}>
                  {folder.label}
                </option>
              ))}
          </select>
        </label>
        <label className="bookmark-time-filter">
          {t('收藏时间')}
          <select
            aria-label={t('收藏时间')}
            value={period}
            onChange={event => {
              const value = BOOKMARK_PERIODS.find(value => value === event.target.value);
              if (value) setPeriod(value);
            }}
          >
            {BOOKMARK_PERIODS.map(value => (
              <option key={value} value={value}>
                {t(labels[value])}
              </option>
            ))}
          </select>
        </label>
      </div>
      {state.folderUnavailable && <p role="alert">{t('所选文件夹已不可用，请重新选择。')}</p>}
      {writeIntent && onOrganize && (
        <button type="button" onClick={onOrganize}>
          {t('前往整理工作台')}
        </button>
      )}
      <DeferredNotice show={!state.connectionReady && !state.connectionFailed} delayMs={snapshot ? 1500 : 250}>
        <p role="status">{statusText(state.connectionMessage)}</p>
      </DeferredNotice>
      {state.connectionFailed && (
        <>
          <p role="alert">{statusText(state.connectionMessage)}</p>
          <button type="button" onClick={() => retry.current()}>
            {t('重试读取')}
          </button>
        </>
      )}
      {state.status === 'ready' && (
        <>
          <div className="search-actions">
            {query.trim() && (
              <button
                type="button"
                disabled={!settings || !state.connectionReady || state.reranking || state.folderUnavailable}
                onClick={() => void controller.current?.rerank()}
              >
                {t('AI 帮我找')}
              </button>
            )}
            {state.reranking && (
              <button type="button" onClick={() => controller.current?.cancel()}>
                {t('取消 AI 搜索')}
              </button>
            )}
            {state.canContinue && !state.reranking && (
              <button
                type="button"
                disabled={!state.connectionReady}
                onClick={() => void controller.current?.continueSearch()}
              >
                {t('继续搜索剩余书签')}
              </button>
            )}
          </div>
          {state.reranking && <BusyIndicator label={t('正在搜索…')} />}
          {state.message && <p role="status">{statusText(state.message)}</p>}
          <h2 className="search-results-heading">{t(query.trim() ? '搜索结果' : '最近收藏')}</h2>
          {state.progress && (
            <>
              <p role="status">
                {t('已检查 {checked} / {total} 条 · 匹配 {matched} 条 · 无法确定 {uncertain} 条', {
                  checked: state.progress.checked,
                  total: state.progress.total,
                  matched: state.progress.checked ? state.hits.length : 0,
                  uncertain: state.uncertainHits?.length ?? 0,
                })}
              </p>
              {state.progress.changed && state.reranking && (
                <p>{t('书签已变化，当前结果尚未覆盖最新书签，请重新搜索。')}</p>
              )}
            </>
          )}
          {!state.hits.length ? (
            !state.folderUnavailable && (
              <p role="status">
                {t(
                  !query.trim()
                    ? '所选时间内没有记录收藏时间的书签，可切换到全部时间。'
                    : state.progress
                      ? '当前没有已确认的匹配结果。'
                      : '没有匹配的关键词结果。',
                )}
              </p>
            )
          ) : (
            <>
              {snapshot && (
                <TreeRows
                  snapshot={snapshot}
                  connectionReady={state.connectionReady}
                  results={{ ids: state.hits.map(hit => hit.id), onOpen: id => controller.current?.open(id) }}
                />
              )}
            </>
          )}
          {snapshot && !!state.uncertainHits?.length && (
            <details>
              <summary>{t('无法确定是否相关（{count}）', { count: state.uncertainHits.length })}</summary>
              <TreeRows
                snapshot={snapshot}
                connectionReady={state.connectionReady}
                results={{ ids: state.uncertainHits.map(hit => hit.id), onOpen: id => controller.current?.open(id) }}
              />
            </details>
          )}
          {snapshot && !!state.localOnlyHits?.length && (
            <details>
              <summary>{t('仅本地匹配，未发送 AI（{count}）', { count: state.localOnlyHits.length })}</summary>
              <TreeRows
                snapshot={snapshot}
                connectionReady={state.connectionReady}
                results={{ ids: state.localOnlyHits.map(hit => hit.id), onOpen: id => controller.current?.open(id) }}
              />
            </details>
          )}
        </>
      )}
    </section>
  );
}
