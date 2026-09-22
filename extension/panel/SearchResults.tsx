import { useEffect, useRef, useState } from 'react';
import { browserModelAuthority } from '../adapters/model-authority';
import { ModelTransport } from '../adapters/model-transport';
import type { SettingsStore } from '../persistence/settings';
import { connectTree } from './tree-client';
import { SearchController, type SearchState } from './search-controller';
import { canOpenUrl } from '../domain/open-url';
export function SearchResults({
  query,
  settings,
  onOrganize,
}: {
  query: string;
  settings?: SettingsStore;
  onOrganize?: () => void;
}) {
  const [state, setState] = useState<SearchState>({
    query,
    hits: [],
    status: 'loading',
    message: '',
    reranking: false,
  });
  const controller = useRef<SearchController | undefined>(undefined);
  const latestQuery = useRef(query);
  latestQuery.current = query;
  useEffect(() => {
    const authority = settings && typeof chrome !== 'undefined' ? browserModelAuthority(settings) : undefined;
    const transport = authority
      ? new ModelTransport(
          { fetch: (...args) => fetch(...args), contains: request => chrome.permissions.contains(request) },
          authority,
        )
      : undefined;
    const owner = new SearchController(setState, authority, transport);
    controller.current = owner;
    owner.setQuery(latestQuery.current);
    const stop =
      typeof chrome !== 'undefined' && typeof chrome.runtime?.connect === 'function'
        ? connectTree(chrome.runtime, tree => owner.setTree(tree))
        : undefined;
    if (!stop) owner.setTree({ status: 'error', message: '书签服务不可用。' });
    return () => {
      stop?.();
      owner.dispose();
      controller.current = undefined;
    };
  }, [settings]);
  useEffect(() => {
    controller.current?.setQuery(query);
  }, [query]);
  if (!query.trim()) return null;
  const writeIntent = /整理|移动|删除|重命名|合并|^(organize|move|delete|rename|merge)\b/i.test(query.trim());
  return (
    <section
      className="surface search-results"
      aria-label="搜索结果"
      aria-busy={state.status === 'loading' || state.reranking}
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
      {state.status === 'error' && <p role="alert">{state.message}</p>}
      {state.status === 'ready' && (
        <>
          <button
            type="button"
            disabled={!settings || !state.hits.length || state.reranking || writeIntent}
            onClick={() => void controller.current?.rerank()}
          >
            启用 AI 并重排本次搜索（最多 8 条）
          </button>
          {state.reranking && (
            <>
              <p role="status">正在重排，仍可打开本地结果…</p>
              <button type="button" onClick={() => controller.current?.cancel()}>
                取消 AI 重排
              </button>
            </>
          )}
          {!state.reranking && state.message && <p role="status">{state.message}</p>}
          {!state.hits.length ? (
            <p role="status">没有匹配的书签，请尝试其他关键词或拼音。</p>
          ) : (
            <>
              <p className="hint">{state.hits.length} 条结果 · 点击或聚焦后按 Enter 打开</p>
              <ul className="search-hit-list">
                {state.hits.map(hit => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      disabled={!canOpenUrl(hit.url)}
                      onClick={() => controller.current?.open(hit.id)}
                    >{`${hit.title || '未命名书签'}
${hit.path || '根目录'}
${hit.url}${canOpenUrl(hit.url) ? '' : String.fromCharCode(10) + '此网址协议不支持安全打开'}`}</button>
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
