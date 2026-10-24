import type { ModelAuthority } from '../adapters/model-authority';
import type { ModelTransport } from '../adapters/model-transport';
import type { AiRequest } from '../domain/ai-payload';
import type { NodeRef, TreeSnapshot, TreeState } from '../domain/node-reference';
import { SearchIndex, type SearchHit } from '../domain/search-index';
import { searchCandidates } from '../domain/search-rerank';
import { localSearchRule } from '../domain/search-local-query';
import { searchScope } from '../domain/search-scope';
import { openUrl } from '../domain/open-url';
import { cancellable } from '../domain/cancellable';
import { BOOKMARK_SEARCH_BATCH_SIZE, SEARCH_PLAN_TIMEOUT_MS } from '../domain/search-limits';
import { prioritizeSearchCandidates, requestsAllSearchMatches, searchFolderIds } from '../domain/search-planning';
import type { BookmarkKeywordRecord } from '../domain/bookmark-keywords';
import {
  collectionPlan,
  inCollectionRange,
  newestBookmarks,
  type BookmarkPeriod,
  type CollectionPlan,
  type CollectionRange,
} from '../domain/bookmark-recency';

export interface SearchState {
  query: string;
  hits: SearchHit[];
  status: 'loading' | 'ready' | 'error';
  message: string;
  reranking: boolean;
  connectionReady: boolean;
  connectionFailed: boolean;
  connectionMessage: string;
  collectionRange?: CollectionRange;
  recentFallback?: boolean;
  expandedRange?: boolean;
  uncertainHits?: SearchHit[];
  localOnlyHits?: SearchHit[];
  canContinue?: boolean;
  planningFallback?: boolean;
  folderUnavailable?: boolean;
  progress?: { checked: number; total: number; excluded: number; complete: boolean; changed: boolean };
}
type Decision = 'matched' | 'unmatched' | 'uncertain';
interface SearchRun {
  range?: CollectionRange;
  folderScope?: NodeRef;
  installationId: string;
  source: Map<string, SearchHit>;
  allowed: Set<string>;
  decisions: Map<string, Decision>;
  finished: boolean;
  changed: boolean;
}
const sameHit = (a: SearchHit | undefined, b: SearchHit) =>
  a?.title === b.title && a.url === b.url && a.path === b.path && a.dateAdded === b.dateAdded;
const PREPARE_TIMEOUT_MS = 10_000;
function failureMessage(reason: string): string {
  const messages: Record<string, string> = {
    'prepare-timeout': '读取书签或模型设置超时，请重试。',
    'tree-unavailable': '书签正在更新，请连接恢复后重试。',
    timeout: '模型搜索超时，请重试或调整模型超时设置。',
    unavailable: '请先在 AI 服务中为“智能搜索”指定模型。',
    'no-allowed-candidates': '没有允许用于 AI 搜索的书签，请检查隐私排除设置。',
    'payload-too-large': '单条书签或查询超过模型请求限额，搜索尚未完成。',
    permission: '模型服务尚未授权，请检查 AI 服务权限。',
    'stale-context': '搜索期间书签或设置已变化，请重新搜索。',
    schema: '模型未完整判断本批书签，搜索尚未完成。',
    'invalid-search-folder': '所选文件夹已不可用，请重新选择。',
  };
  return `AI 搜索未完成，保留已找到的结果。${messages[reason] ?? '请检查模型连接后重试。'}`;
}
export class SearchController {
  private period: BookmarkPeriod = 'auto';
  private recentView = false;
  private plan: CollectionPlan = {};
  private keywords: BookmarkKeywordRecord[] = [];
  private index?: SearchIndex;
  private indexInstallationId?: string;
  private indexTree?: TreeSnapshot;
  private folderScope?: NodeRef;
  private scopeIds = new Set<string>();
  private tree: TreeState = { status: 'loading' };
  private local: SearchHit[] = [];
  private run?: SearchRun;
  private generation = 0;
  private active?: AbortController;
  private continuation?: () => Promise<void>;
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
    this.stop = authority?.subscribe(change => {
      if (change !== 'tree') this.invalidate('设置或权限已变化，已恢复本地结果。');
    });
  }
  setKeywords(records: BookmarkKeywordRecord[]) {
    this.keywords = records;
    if (this.tree.status === 'ready') this.setTree(this.tree);
  }
  private publish() {
    this.emit({ ...this.state, hits: [...this.state.hits] });
  }
  private stopActive() {
    this.generation++;
    this.active?.abort();
    this.active = undefined;
    this.continuation = undefined;
    this.state.canContinue = false;
    this.transport?.cancel();
    this.state.reranking = false;
  }
  private invalidate(message = '') {
    this.stopActive();
    this.run = undefined;
    this.state = {
      ...this.state,
      hits: this.local,
      uncertainHits: [],
      localOnlyHits: [],
      progress: undefined,
      message,
      collectionRange: this.plan.range,
      recentFallback: !!this.plan.fallback,
      expandedRange: false,
      planningFallback: false,
    };
    this.publish();
  }
  /** Keep only judgments whose supplied metadata still agrees with native bookmarks. */
  private projectRun() {
    const run = this.run;
    if (!run) {
      this.state.hits = this.local;
      return;
    }
    const catalog = (this.index?.all() ?? []).filter(
      hit => this.scopeIds.has(hit.id) && inCollectionRange(hit, run.range),
    );
    const current = new Map(catalog.map(hit => [hit.id, hit]));
    const sameInstallation = this.indexInstallationId === run.installationId;
    if (
      !sameInstallation ||
      current.size !== run.source.size ||
      [...run.source].some(([id, hit]) => !sameHit(current.get(id), hit))
    )
      run.changed = true;
    const hits: SearchHit[] = [];
    const uncertain: SearchHit[] = [];
    let checked = 0;
    for (const [id, decision] of run.decisions) {
      const original = run.source.get(id)!;
      if (!sameInstallation || !sameHit(current.get(id), original)) continue;
      checked++;
      if (decision === 'matched') hits.push(current.get(id)!);
      if (decision === 'uncertain') uncertain.push(current.get(id)!);
    }
    this.state.hits = run.decisions.size ? hits : this.local.filter(hit => run.allowed.has(hit.id));
    this.state.uncertainHits = uncertain;
    this.state.localOnlyHits = this.local.filter(hit => !run.allowed.has(hit.id) && run.source.has(hit.id));
    this.state.progress = {
      checked,
      total: run.allowed.size,
      excluded: run.source.size - run.allowed.size,
      complete: run.finished && checked === run.allowed.size && !run.changed,
      changed: run.changed,
    };
  }
  setTree(tree: TreeState) {
    this.tree = structuredClone(tree);
    try {
      if (this.tree.status === 'ready') {
        this.index = new SearchIndex(this.tree.snapshot, this.keywords);
        this.indexInstallationId = this.tree.snapshot.installationId;
        this.indexTree = this.tree.snapshot;
        // Idle browsing follows new native saves; an AI run keeps its explicitly captured time boundary.
        if (!this.run) {
          this.plan = collectionPlan(this.state.query, this.period, this.recentView);
          this.state.collectionRange = this.plan.range;
          this.state.recentFallback = !!this.plan.fallback;
        }
      }
    } catch {
      this.tree = { status: 'error', message: '搜索索引不可用，请等待书签刷新。' };
      this.index = undefined;
      this.indexInstallationId = undefined;
      this.indexTree = undefined;
    }
    this.updateLocal();
    this.projectRun();
    this.state = {
      ...this.state,
      status: this.index ? 'ready' : this.tree.status,
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
    };
    if (this.state.folderUnavailable) {
      this.invalidate();
      return;
    }
    if (this.run?.changed && !this.state.reranking) {
      this.continuation = undefined;
      this.state.canContinue = false;
      this.state.message = '书签已变化，当前结果尚未覆盖最新书签，请重新搜索。';
    }
    this.publish();
  }
  setQuery(query: string) {
    this.state.query = query;
    this.plan = collectionPlan(query, this.period, this.recentView);
    this.updateLocal();
    this.invalidate();
  }
  setCollectionFilter(period: BookmarkPeriod, recentView = false) {
    this.period = period;
    this.recentView = recentView;
    this.setQuery(this.state.query);
  }
  setFolderScope(folder?: NodeRef) {
    if (
      this.folderScope?.nativeId === folder?.nativeId &&
      this.folderScope?.installationId === folder?.installationId &&
      this.folderScope?.kind === folder?.kind
    )
      return;
    this.folderScope = folder ? { ...folder } : undefined;
    this.setQuery(this.state.query);
  }
  private updateLocal() {
    try {
      this.scopeIds = this.indexTree ? searchScope(this.indexTree, this.folderScope).ids : new Set();
      this.state.folderUnavailable = false;
    } catch {
      this.scopeIds = new Set();
      this.state.folderUnavailable = true;
    }
    const hits = this.state.query.trim()
      ? (this.index?.query(this.state.query) ?? [])
      : this.recentView
        ? (this.index?.all() ?? [])
        : [];
    const filtered = hits.filter(hit => this.scopeIds.has(hit.id) && inCollectionRange(hit, this.plan.range));
    this.local = this.recentView || this.plan.range ? newestBookmarks(filtered) : filtered;
  }
  cancel() {
    if (!this.state.reranking) return;
    this.stopActive();
    this.projectRun();
    this.state.message = '已取消 AI 搜索，保留已找到的结果；搜索尚未完成。';
    this.publish();
  }
  async continueSearch() {
    if (this.state.reranking || this.tree.status !== 'ready' || !this.continuation) return;
    const resume = this.continuation;
    this.continuation = undefined;
    this.state.canContinue = false;
    await resume();
  }
  async rerank() {
    this.plan = collectionPlan(this.state.query, this.period, this.recentView);
    this.updateLocal();
    this.invalidate();
    const generation = this.generation;
    const query = this.state.query;
    if (this.state.folderUnavailable) return;
    if (!query.trim() || this.tree.status !== 'ready') {
      this.state.message = 'AI 搜索暂不可用，请等待书签连接恢复并检查模型配置。';
      this.publish();
      return;
    }
    const folderScope = this.folderScope ? { ...this.folderScope } : undefined;
    const localRule = localSearchRule(query, this.tree.snapshot);
    if (localRule) {
      const scoped = () =>
        (this.index?.all() ?? []).filter(hit => this.scopeIds.has(hit.id) && inCollectionRange(hit, this.plan.range));
      let catalog = scoped();
      if (this.plan.fallback && !catalog.some(hit => localRule.matches(hit))) {
        this.plan.range = this.plan.fallback;
        catalog = scoped();
        this.state.collectionRange = this.plan.range;
        this.state.expandedRange = true;
        this.updateLocal();
      }
      this.run = {
        range: this.plan.range,
        folderScope,
        installationId: this.tree.snapshot.installationId,
        source: new Map(catalog.map(hit => [hit.id, hit])),
        allowed: new Set(catalog.map(hit => hit.id)),
        decisions: new Map(catalog.map(hit => [hit.id, localRule.matches(hit) ? 'matched' : 'unmatched'])),
        finished: true,
        changed: false,
      };
      this.projectRun();
      this.publish();
      return;
    }
    if (!this.authority || !this.transport) {
      this.state.message = failureMessage('unavailable');
      this.publish();
      return;
    }
    this.state.reranking = true;
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
      const allAllowed = new Set(searchCandidates(context.tree, context.privacy));
      const searchIndex = new SearchIndex(context.tree, this.keywords);
      const scopeIds = searchScope(context.tree, folderScope).ids;
      const catalog = searchIndex.all().filter(hit => scopeIds.has(hit.id));
      const scoped = (range?: CollectionRange) => {
        const items = catalog.filter(hit => inCollectionRange(hit, range));
        return range || this.recentView ? newestBookmarks(items) : items;
      };
      let source = scoped(this.plan.range);
      const permitted = source.filter(hit => allAllowed.has(hit.id));
      let folderOrder = searchFolderIds(context.tree, permitted);
      let terms: string[] = [];
      let candidates = permitted.map(hit => hit.id);
      const run: SearchRun = (this.run = {
        range: this.plan.range,
        folderScope,
        installationId: context.tree.installationId,
        source: new Map(source.map(hit => [hit.id, hit])),
        allowed: new Set(candidates),
        decisions: new Map(),
        finished: false,
        changed: false,
      });
      this.projectRun();
      this.publish();
      // Small or flat catalogs need no extra network round trip just to decide their order.
      if (candidates.length > BOOKMARK_SEARCH_BATCH_SIZE && folderOrder.length > 1) {
        const request: AiRequest = {
          task: 'search-plan',
          query,
          itemIds: candidates,
          folderIds: folderOrder,
          collectionRange: run.range,
          folderScope: run.folderScope,
        };
        if (this.transport.fits({ ...context, config: context.config, request })) {
          const planner = new AbortController();
          const stopPlanner = () => planner.abort(operation.signal.reason);
          operation.signal.addEventListener('abort', stopPlanner, { once: true });
          const planTimer = setTimeout(
            () => planner.abort(Error('timeout')),
            Math.min(remaining, SEARCH_PLAN_TIMEOUT_MS),
          );
          try {
            const plan = await cancellable(
              this.transport.run({
                ...context,
                config: context.config,
                request,
                timeoutMs: remaining,
                signal: planner.signal,
              }),
              planner.signal,
            );
            if (generation !== this.generation || operation.signal.aborted) return;
            if (plan.status === 'completed' && 'folderIds' in plan.output) {
              folderOrder = plan.output.folderIds;
              terms = plan.output.terms;
            } else {
              if (plan.status !== 'completed' && ['stale-context', 'permission'].includes(plan.reason))
                throw Error(plan.reason);
              this.state.planningFallback = true;
            }
          } catch (error) {
            if (generation !== this.generation || operation.signal.aborted) return;
            if (error instanceof Error && ['stale-context', 'permission'].includes(error.message)) throw error;
            this.state.planningFallback = true;
          } finally {
            clearTimeout(planTimer);
            operation.signal.removeEventListener('abort', stopPlanner);
          }
        } else this.state.planningFallback = true;
      }
      if (generation !== this.generation || operation.signal.aborted) return;
      const priorityIds = [query, ...terms].flatMap(term => searchIndex.query(term).map(hit => hit.id));
      candidates = prioritizeSearchCandidates(context.tree, permitted, folderOrder, priorityIds);
      const requestFor = (ids: string[]): AiRequest => ({
        task: 'search-batch',
        query,
        itemIds: ids,
        folderIds: [],
        collectionRange: run.range,
        folderScope: run.folderScope,
      });
      let offset = 0;
      let expanded = false;
      const scan = async (exhaustive: boolean) => {
        if (generation !== this.generation || operation.signal.aborted) return;
        this.active = operation;
        this.state.reranking = true;
        this.state.message = '';
        this.publish();
        try {
          while (true) {
            if (generation !== this.generation || operation.signal.aborted) return;
            if (offset >= candidates.length) {
              this.projectRun();
              if (!expanded && this.plan.fallback && !run.changed && ![...run.decisions.values()].includes('matched')) {
                expanded = true;
                run.range = this.plan.fallback;
                source = scoped(run.range);
                run.source = new Map(source.map(hit => [hit.id, hit]));
                const additional = source.filter(hit => allAllowed.has(hit.id) && !run.allowed.has(hit.id));
                for (const id of prioritizeSearchCandidates(context.tree, additional, folderOrder, priorityIds))
                  candidates.push(id);
                additional.forEach(hit => run.allowed.add(hit.id));
                this.state.collectionRange = run.range;
                this.state.expandedRange = true;
                this.plan.range = run.range;
                this.updateLocal();
                this.projectRun();
                this.publish();
                continue;
              }
              break;
            }
            let ids = candidates.slice(offset, offset + BOOKMARK_SEARCH_BATCH_SIZE);
            // Measure the actual adapter envelope. Never truncate a title or discard the remainder.
            while (!this.transport!.fits({ ...context, config: context.config!, request: requestFor(ids) })) {
              if (ids.length === 1) throw Error('payload-too-large');
              ids = ids.slice(0, Math.ceil(ids.length / 2));
            }
            const result = await cancellable(
              this.transport!.run({
                ...context,
                config: context.config!,
                timeoutMs: remaining,
                request: requestFor(ids),
                signal: operation.signal,
                onProgress: progress => {
                  if (generation !== this.generation || !progress.retry) return;
                  this.state.message = `服务繁忙，${progress.retry.delaySeconds} 秒后重试（${progress.retry.attempt}/3），可随时取消。`;
                  this.publish();
                },
              }),
              operation.signal,
            );
            if (generation !== this.generation || operation.signal.aborted) return;
            if (result.status !== 'completed') throw Error(result.reason);
            if (!('matchedIds' in result.output)) throw Error('schema');
            if (this.tree.status !== 'ready') throw Error('tree-unavailable');
            for (const id of result.output.matchedIds) run.decisions.set(id, 'matched');
            for (const id of result.output.unmatchedIds) run.decisions.set(id, 'unmatched');
            for (const id of result.output.uncertainIds) run.decisions.set(id, 'uncertain');
            offset += ids.length;
            this.projectRun();
            this.state.message = '';
            this.publish();
            if (!exhaustive && offset < candidates.length && this.state.hits.length && !run.changed) {
              this.state.canContinue = true;
              this.continuation = () => scan(true);
              return;
            }
          }
          run.finished = true;
          this.projectRun();
          this.state.message = run.changed
            ? '书签已变化，当前结果尚未覆盖最新书签，请重新搜索。'
            : !source.length
              ? '所选时间内没有记录收藏时间的书签，可切换到全部时间。'
              : !candidates.length
                ? '没有允许用于 AI 搜索的书签，请检查隐私排除设置。'
                : '';
        } catch (error) {
          if (generation === this.generation) {
            this.projectRun();
            this.state.message = failureMessage(error instanceof Error ? error.message : 'unknown');
          }
        } finally {
          if (generation === this.generation) {
            this.active = undefined;
            this.state.reranking = false;
            this.publish();
          }
        }
      };
      await scan(requestsAllSearchMatches(query));
    } catch (error) {
      if (generation === this.generation) {
        this.projectRun();
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
    const displayed = [...this.state.hits, ...(this.state.uncertainHits ?? []), ...(this.state.localOnlyHits ?? [])];
    return node?.url !== undefined && displayed.some(hit => hit.id === id) ? openUrl(node.url, opener) : false;
  }
  dispose() {
    this.stopActive();
    this.stop?.();
    this.transport?.dispose();
  }
}
