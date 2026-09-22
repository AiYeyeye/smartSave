import type { ModelAuthority } from '../adapters/model-authority';
import type { ModelTransport } from '../adapters/model-transport';
import type { TreeState } from '../domain/node-reference';
import { SearchIndex, type SearchHit } from '../domain/search-index';
import { applySearchOrder, searchCandidates } from '../domain/search-rerank';
import { openUrl } from '../domain/open-url';
export interface SearchState {
  query: string;
  hits: SearchHit[];
  status: 'loading' | 'ready' | 'error';
  message: string;
  reranking: boolean;
}
export class SearchController {
  private index?: SearchIndex;
  private tree: TreeState = { status: 'loading' };
  private local: SearchHit[] = [];
  private generation = 0;
  private authorityGeneration = 0;
  private authorityReady = true;
  private readonly stop?: () => void;
  private state: SearchState = { query: '', hits: [], status: 'loading', message: '', reranking: false };
  constructor(
    private readonly emit: (state: SearchState) => void,
    private readonly authority?: ModelAuthority,
    private readonly transport?: ModelTransport,
  ) {
    // Tree changes reach this owner through setTree and are judged per request by the transport's dependency scope.
    this.stop = authority?.subscribe(change => {
      if (change === 'tree') return;
      this.invalidate('设置或权限已变化，已恢复本地结果。');
      const generation = ++this.authorityGeneration;
      this.authorityReady = false;
      void authority
        .read()
        .then(() => {
          if (generation !== this.authorityGeneration) return;
          this.authorityReady = true;
        })
        .catch(() => {
          /* Optional AI settings failure must not clear healthy local results. */
        });
    });
  }
  private publish() {
    this.emit({ ...this.state, hits: [...this.state.hits] });
  }
  private invalidate(message = '') {
    this.generation++;
    this.transport?.cancel();
    this.state = { ...this.state, hits: this.local, reranking: false, message };
    this.publish();
  }
  /** Rebuilds the local index and results; an in-flight rerank keeps running and lands on the current local results. */
  setTree(tree: TreeState) {
    this.tree = structuredClone(tree);
    try {
      this.index = tree.status === 'ready' ? new SearchIndex(tree.snapshot) : undefined;
    } catch {
      this.tree = { status: 'error', message: '搜索索引不可用，请等待书签刷新。' };
      this.index = undefined;
    }
    this.local = this.index?.query(this.state.query) ?? [];
    this.state = {
      ...this.state,
      status: this.tree.status,
      hits: this.local,
      message: this.tree.status === 'error' ? this.tree.message : this.state.reranking ? this.state.message : '',
    };
    this.publish();
  }
  setQuery(query: string) {
    this.state.query = query;
    this.local = this.index?.query(query) ?? [];
    this.invalidate();
  }
  cancel() {
    this.invalidate('已取消 AI 重排，保留本地结果。');
  }
  async rerank() {
    this.invalidate();
    const generation = this.generation;
    if (
      !this.authorityReady ||
      !this.authority ||
      !this.transport ||
      !this.state.query.trim() ||
      !this.local.length ||
      this.tree.status !== 'ready'
    ) {
      this.state.message = 'AI 重排不可用，保留本地结果。';
      this.publish();
      return;
    }
    this.state.reranking = true;
    this.publish();
    try {
      const context = await this.authority.read();
      if (generation !== this.generation) return;
      if (!context.config) throw Error('unavailable');
      const candidates = searchCandidates(context.tree, context.privacy, this.local);
      if (!candidates.length) throw Error('no-allowed-candidates');
      const result = await this.transport.run({
        ...context,
        config: context.config,
        request: { task: 'search', query: this.state.query, itemIds: candidates, folderIds: [] },
      });
      if (generation !== this.generation) return;
      if (result.status !== 'completed' || !('rankedIds' in result.output)) throw Error('rerank-failed');
      // Candidates removed from the tree while the model answered are simply no longer rankable.
      const present = new Set(this.local.map(hit => hit.id));
      this.state.hits = applySearchOrder(
        this.local,
        candidates,
        result.output.rankedIds.filter(id => present.has(id)),
      );
      this.state.message = 'AI 已重排本地候选；未参与项目仍保留。';
    } catch {
      if (generation === this.generation) {
        this.state.hits = this.local;
        this.state.message = 'AI 重排未完成，保留本地结果。请检查模型配置或重试。';
      }
    } finally {
      if (generation === this.generation) {
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
    this.authorityGeneration++;
    this.stop?.();
    this.transport?.dispose();
  }
}
