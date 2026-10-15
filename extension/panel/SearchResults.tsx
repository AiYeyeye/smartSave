import { useEffect, useRef, useState } from 'react';
import { browserModelAuthority } from '../adapters/model-authority';
import { searchModelAuthority } from '../adapters/search-model-authority';
import type { AiServicesStore } from '../persistence/ai-services';
import { ModelTransport } from '../adapters/model-transport';
import type { SettingsStore } from '../persistence/settings';
import { connectTree } from './tree-client';
import { SearchController, type SearchState } from './search-controller';
import { canOpenUrl } from '../domain/open-url';
import './search-results.css';
import { BusyIndicator } from '../ui/BusyIndicator';
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
    controller.current = owner;
    owner.setQuery(latestQuery.current);
    let stop =
      typeof chrome !== 'undefined' && typeof chrome.runtime?.connect === 'function'
        ? connectTree(chrome.runtime, tree => owner.setTree(tree))
        : undefined;
    if (!stop) owner.setTree({ status: 'error', message: '书签服务不可用。' });
    retry.current = () => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return;
      stop?.();
      stop = connectTree(chrome.runtime, tree => owner.setTree(tree));
    };
    return () => {
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
      aria-label="搜索结果"
      aria-busy={!state.connectionReady || state.reranking}
    >
      <h2>
        搜索结果 <small>本地优先</small>
      </h2>
      {writeIntent && (
        <p role="note">
          写操作请前往整理工作台，预览并确认后应用。搜索不会执行写操作。
          {onOrganize && (
            <button type="button" onClick={onOrganize}>
              前往整理工作台
            </button>
          )}
        </p>
      )}
      {state.status === 'loading' && <p role="status">正在建立本地搜索索引…</p>}
      {state.connectionMessage && <p role={state.connectionFailed ? 'alert' : 'status'}>{state.connectionMessage}</p>}
      {!state.connectionReady && (
        <button type="button" onClick={() => retry.current()}>
          重试读取
        </button>
      )}
      {state.status === 'ready' && (
        <>
          <button
            type="button"
            disabled={!settings || !state.connectionReady || state.reranking}
            onClick={() => void controller.current?.rerank()}
          >
            AI 帮我找
          </button>
          <button
            type="button"
            disabled={!settings || !state.connectionReady || state.reranking}
            onClick={() => void controller.current?.rerank('deep')}
          >
            深度搜索
          </button>
          <p className="hint">
            描述用途或大致内容，优先快速查找少量候选。深度搜索会分段检查全部允许搜索的书签，可能需要更久。
          </p>
          {state.reranking && (
            <>
              <BusyIndicator label="AI 正在理解描述并查找相关书签…" />
              {state.message && <p role="status">{state.message}</p>}
              <button type="button" onClick={() => controller.current?.cancel()}>
                取消 AI 搜索
              </button>
            </>
          )}
          {!state.reranking && state.message && <p role="status">{state.message}</p>}
          {!state.hits.length ? (
            <p role="status">没有匹配的关键词结果。可以点击“AI 帮我找”，或换个描述。</p>
          ) : (
            <>
              <p className="hint">
                {state.hits.length} 条结果 · {state.connectionReady ? '点击或聚焦后按 Enter 打开' : '连接恢复后可打开'}
              </p>
              <ul className="search-hit-list">
                {state.hits.map(hit => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      title={hit.title || '未命名书签'}
                      disabled={!state.connectionReady || !canOpenUrl(hit.url)}
                      onClick={() => controller.current?.open(hit.id)}
                    >
                      {hit.title || '未命名书签'}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
