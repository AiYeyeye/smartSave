import { useEffect, useRef, useState } from 'react';
import { browserModelAuthority } from '../adapters/model-authority';
import { searchModelAuthority } from '../adapters/search-model-authority';
import type { AiServicesStore } from '../persistence/ai-services';
import { ModelTransport } from '../adapters/model-transport';
import type { SettingsStore } from '../persistence/settings';
import { connectTree } from './tree-client';
import { SearchController, type SearchState } from './search-controller';
import type { TreeSnapshot, TreeState } from '../domain/node-reference';
import { TreeRows } from './BookmarkTree';
import './search-results.css';
import { BusyIndicator } from '../ui/BusyIndicator';
import { useI18n } from '../ui/i18n';
import { searchStatusText } from './search-status-text';
import { watchBookmarkKeywords } from '../persistence/bookmark-keywords';
export function SearchResults({
  query,
  settings,
  services,
  onOrganize,
}: {
  query: string;
  settings?: SettingsStore;
  services?: AiServicesStore;
  onOrganize?: () => void;
}) {
  const { t, language } = useI18n();
  const statusText = (text: string) => searchStatusText(language, text);
  const [snapshot, setSnapshot] = useState<TreeSnapshot>();
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
  if (!query.trim()) return null;
  const writeIntent = /整理|移动|删除|重命名|合并|^(organize|move|delete|rename|merge)\b/i.test(query.trim());
  return (
    <section
      className="surface search-results"
      aria-label={t('搜索结果')}
      aria-busy={!state.connectionReady || state.reranking}
    >
      <h2>{t('搜索结果')}</h2>
      {writeIntent && (
        <p role="note">
          {t('写操作请前往整理工作台，预览并确认后应用。搜索不会执行写操作。')}
          {onOrganize && (
            <button type="button" onClick={onOrganize}>
              {t('前往整理工作台')}
            </button>
          )}
        </p>
      )}
      {state.status === 'loading' && <p role="status">{t('正在建立本地搜索索引…')}</p>}
      {state.connectionMessage && (
        <p role={state.connectionFailed ? 'alert' : 'status'}>{statusText(state.connectionMessage)}</p>
      )}
      {!state.connectionReady && (
        <button type="button" onClick={() => retry.current()}>
          {t('重试读取')}
        </button>
      )}
      {state.status === 'ready' && (
        <>
          <button
            type="button"
            disabled={!settings || !state.connectionReady || state.reranking}
            onClick={() => void controller.current?.rerank()}
          >
            {t('AI 帮我找')}
          </button>
          <button
            type="button"
            disabled={!settings || !state.connectionReady || state.reranking}
            onClick={() => void controller.current?.rerank('deep')}
          >
            {t('深度搜索')}
          </button>
          {state.reranking && (
            <>
              <BusyIndicator label={t('AI 正在理解描述并查找相关书签…')} />
              {state.message && <p role="status">{statusText(state.message)}</p>}
              <button type="button" onClick={() => controller.current?.cancel()}>
                {t('取消 AI 搜索')}
              </button>
            </>
          )}
          {!state.reranking && state.message && <p role="status">{statusText(state.message)}</p>}
          {!state.hits.length ? (
            <p role="status">{t('没有匹配的关键词结果。可以点击“AI 帮我找”，或换个描述。')}</p>
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
        </>
      )}
    </section>
  );
}
