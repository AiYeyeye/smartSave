import type { ModelAuthority } from '../adapters/model-authority';
import type { ModelProgress, ModelTransport } from '../adapters/model-transport';
import type { AiRequest } from '../domain/ai-payload';
import type { TreeState } from '../domain/node-reference';
import { SearchIndex, type SearchHit } from '../domain/search-index';
import { applySearchOrder, searchCandidates } from '../domain/search-rerank';
import { openUrl } from '../domain/open-url';
import { cancellable } from '../domain/cancellable';
import { fastSearchCandidates } from '../domain/search-retrieval';
import { AI_SEARCH_CANDIDATES, AI_SEARCH_RESULTS } from '../domain/search-limits';
import type { BookmarkKeywordRecord } from '../domain/bookmark-keywords';
export interface SearchState {
  query: string;
  hits: SearchHit[];
  status: 'loading' | 'ready' | 'error';
  message: string;
  reranking: boolean;
  connectionReady: boolean;
  connectionFailed: boolean;
  connectionMessage: string;
}
const PREPARE_TIMEOUT_MS = 10_000;
function failureMessage(reason: string): string {
  const messages: Record<string, string> = {
    'prepare-timeout': '读取书签或模型设置超时，请重试。',
    'tree-unavailable': '书签正在更新，请连接恢复后重试。',
    timeout: '模型搜索超时，请重试或调整模型超时设置。',
    unavailable: '请先在 AI 服务中为“智能搜索”指定模型。',
    'no-allowed-candidates': '没有允许用于 AI 搜索的书签，请检查隐私排除设置。',
    'payload-too-large': '书签资料超过单次模型请求限额，请通过隐私排除设置缩小 AI 搜索范围。',
    permission: '模型服务尚未授权，请检查 AI 服务权限。',
    'stale-context': '搜索期间书签或设置已变化，请重新搜索。',
    schema: '模型返回的搜索结果无效，请重试。',
    'no-fast-candidates': '快速搜索没有找到足够候选，可以尝试“深度搜索”，分段检查全部允许搜索的书签。',
  };
  return `AI 搜索未完成，保留本地结果。${messages[reason] ?? '请检查模型连接后重试。'}`;
}
export class SearchController {
  private keywords: BookmarkKeywordRecord[] = [];
  setKeywords(records: BookmarkKeywordRecord[]) {
    this.keywords = records;
    if (this.tree.status === 'ready') this.setTree(this.tree);
  }
  private index?: SearchIndex;
  private tree: TreeState = { status: 'loading' };
  private local: SearchHit[] = [];
  private semantic?: { installationId: string; hits: SearchHit[] };
  private generation = 0;
  private active?: AbortController;
  private readonly stop?: () => void;
  private state: SearchState = {
    query: '',
    hits: [],
    status: 'loading',
    message: '',
    reranking: false,
    connectionReady: false,
    connectionFailed: false,
    connectionMessage: '',
  };
  constructor(
    private readonly emit: (state: SearchState) => void,
    private readonly authority?: ModelAuthority,
    private readonly transport?: ModelTransport,
  ) {
    // Tree changes reach this owner through setTree and are judged per request by the transport's dependency scope.
    this.stop = authority?.subscribe(change => {
      if (change === 'tree') return;
      this.invalidate('设置或权限已变化，已恢复本地结果。');
    });
  }
  private publish() {
    this.emit({ ...this.state, hits: [...this.state.hits] });
  }
  private invalidate(message = '') {
    this.generation++;
    this.active?.abort();
    this.active = undefined;
    this.transport?.cancel();
    this.semantic = undefined;
    this.state = { ...this.state, hits: this.local, reranking: false, message };
    this.publish();
  }
  /** Rebuilds the local index and results; an in-flight rerank keeps running and lands on the current local results. */
  setTree(tree: TreeState) {
    this.tree = structuredClone(tree);
    try {
      if (this.tree.status === 'ready') this.index = new SearchIndex(this.tree.snapshot, this.keywords);
    } catch {
      this.tree = { status: 'error', message: '搜索索引不可用，请等待书签刷新。' };
      this.index = undefined;
    }
    this.local = this.index?.query(this.state.query) ?? [];
    let hits = this.local;
    if (this.tree.status === 'ready' && this.semantic) {
      const current = new Map(this.index?.all().map(hit => [hit.id, hit]));
      this.semantic.hits =
        this.semantic.installationId === this.tree.snapshot.installationId
          ? this.semantic.hits.filter(hit => {
              const live = current.get(hit.id);
              return live?.title === hit.title && live.url === hit.url && live.path === hit.path;
            })
          : [];
      const ids = new Set(this.semantic.hits.map(hit => hit.id));
      hits = [...this.semantic.hits, ...this.local.filter(hit => !ids.has(hit.id))];
    }
    this.state = {
      ...this.state,
      status: this.index ? 'ready' : this.tree.status,
      hits: tree.status === 'ready' || !this.index ? hits : this.state.hits,
      connectionReady: this.tree.status === 'ready',
      connectionFailed: this.tree.status === 'error',
      connectionMessage:
        this.tree.status === 'error'
          ? `${this.tree.message}${this.index ? ' 仍可搜索上次读取的数据。' : ''}`
          : this.tree.status === 'loading'
            ? this.index
              ? '正在更新书签；仍可搜索上次读取的数据，连接恢复后可打开结果。'
              : '正在读取书签…'
            : '',
      message: this.state.reranking ? this.state.message : '',
    };
    this.publish();
  }
  setQuery(query: string) {
    this.state.query = query;
    this.local = this.index?.query(query) ?? [];
    this.invalidate();
  }
  cancel() {
    this.invalidate('已取消 AI 搜索，保留本地结果。');
  }
  async rerank(mode: 'fast' | 'deep' = 'fast') {
    this.invalidate();
    const generation = this.generation;
    if (!this.authority || !this.transport || !this.state.query.trim() || this.tree.status !== 'ready') {
      this.state.message = 'AI 搜索暂不可用，请等待书签连接恢复并检查模型配置。';
      this.publish();
      return;
    }
    this.state.reranking = true;
    this.state.message = mode === 'deep' ? '正在分段检查允许搜索的书签…' : '正在理解描述并查找候选书签…';
    this.publish();
    const started = Date.now();
    const operation = new AbortController();
    this.active = operation;
    const timer = setTimeout(() => operation.abort(Error('prepare-timeout')), PREPARE_TIMEOUT_MS);
    try {
      const context = await cancellable(this.authority.read(), operation.signal);
      if (generation !== this.generation) return;
      if (!context.config) throw Error('unavailable');
      clearTimeout(timer);
      const remaining = context.config.timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw Error('timeout');
      const candidates = searchCandidates(context.tree, context.privacy);
      if (!candidates.length) throw Error('no-allowed-candidates');
      const onProgress = (progress: ModelProgress) => {
        if (generation !== this.generation || !progress.retry) return;
        this.state.message = `服务繁忙，${progress.retry.delaySeconds} 秒后重试（${progress.retry.attempt}/3），可随时取消。`;
        this.publish();
      };
      const run = async (request: AiRequest) => {
        const result = await cancellable(
          this.transport!.run({
            ...context,
            config: context.config!,
            timeoutMs: remaining,
            request,
            signal: operation.signal,
            onProgress,
          }),
          operation.signal,
        );
        if (generation !== this.generation || operation.signal.aborted) throw Error('cancelled');
        if (result.status !== 'completed') throw Error(result.reason);
        return result.output;
      };
      const rank = async (ids: string[]) => {
        const output = await run({ task: 'search', query: this.state.query, itemIds: ids, folderIds: [] });
        if (!('rankedIds' in output)) throw Error('schema');
        return output.rankedIds.slice(0, AI_SEARCH_RESULTS);
      };
      let ranked: string[];
      if (mode === 'fast' && candidates.length > AI_SEARCH_CANDIDATES) {
        const expanded = await run({ task: 'search-expand', query: this.state.query, itemIds: [], folderIds: [] });
        if (!('terms' in expanded)) throw Error('schema');
        const shortList = fastSearchCandidates(
          new SearchIndex(context.tree, this.keywords),
          candidates,
          this.state.query,
          expanded.terms,
        );
        if (!shortList.length) throw Error('no-fast-candidates');
        this.state.message = `正在比较 ${shortList.length} 条候选书签…找不到时可尝试深度搜索。`;
        this.publish();
        ranked = await rank(shortList);
      } else if (mode === 'deep' && candidates.length > AI_SEARCH_CANDIDATES) {
        let pool = candidates;
        while (pool.length > AI_SEARCH_CANDIDATES) {
          const next: string[] = [];
          for (let i = 0; i < pool.length; i += AI_SEARCH_CANDIDATES) {
            next.push(...(await rank(pool.slice(i, i + AI_SEARCH_CANDIDATES))));
            this.state.message = `深度搜索：已检查 ${Math.min(i + AI_SEARCH_CANDIDATES, pool.length)} / ${pool.length} 条，正在比较相关结果…`;
            this.publish();
          }
          pool = [...new Set(next)];
        }
        ranked = pool.length ? await rank(pool) : [];
      } else ranked = await rank(candidates);
      if (generation !== this.generation) return;
      if (this.tree.status !== 'ready') throw Error('tree-unavailable');
      // Candidates removed from the tree while the model answered are simply no longer rankable.
      const catalog = this.index?.all() ?? [];
      const present = new Set(catalog.map(hit => hit.id));
      const rankedIds = ranked.filter(id => present.has(id));
      this.state.hits = applySearchOrder(this.local, candidates, rankedIds, catalog);
      const selected = new Set(rankedIds);
      this.semantic = {
        installationId: this.tree.snapshot.installationId,
        hits: this.state.hits.filter(hit => selected.has(hit.id)),
      };
      this.state.message = rankedIds.length
        ? `AI 找到 ${rankedIds.length} 条相关书签`
        : 'AI 没有找到相关书签，换个描述试试';
    } catch (error) {
      if (generation === this.generation) {
        this.state.hits = this.local;
        this.state.message = failureMessage(error instanceof Error ? error.message : 'unknown');
      }
    } finally {
      clearTimeout(timer);
      if (generation === this.generation) {
        this.active = undefined;
        this.state.reranking = false;
        this.publish();
      }
    }
  }
  open(id: string, opener?: (url: string, target: string, features: string) => unknown) {
    if (this.tree.status !== 'ready') return false;
    const node = this.tree.snapshot.nodes.find(node => node.ref.nativeId === id && node.ref.kind === 'bookmark');
    return node?.url !== undefined && this.state.hits.some(hit => hit.id === id) ? openUrl(node.url, opener) : false;
  }
  dispose() {
    this.generation++;
    this.active?.abort();
    this.stop?.();
    this.transport?.dispose();
  }
}
