import type { ModelAuthority } from '../adapters/model-authority';
import { ModelTransport } from '../adapters/model-transport';
import { HistoryReader } from '../adapters/browser-history';
import { cancellable } from '../domain/cancellable';
import {
  historyDomainMatches,
  historyQuerySchema,
  inferredRange,
  localDate,
  HISTORY_READ_LIMIT,
  type HistoryAiRequest,
  type HistoryRange,
  type HistoryRecord,
} from '../domain/history-search';
import { SearchDocumentsIndex } from '../domain/search-index';
import { AI_SEARCH_CANDIDATES } from '../domain/search-limits';
import { allowedHistory } from '../domain/history-privacy';

export interface HistorySearchState {
  permission: boolean;
  loading: boolean;
  searching: boolean;
  consent: boolean;
  records: HistoryRecord[];
  hits: HistoryRecord[];
  limited: boolean;
  error: string;
  aiCount?: number;
  aiRange?: HistoryRange;
}
export class HistoryController {
  private state: HistorySearchState = {
    permission: false,
    loading: false,
    searching: false,
    consent: false,
    records: [],
    hits: [],
    limited: false,
    error: '',
  };
  private query = '';
  private range: HistoryRange = { startTime: 0, endTime: Date.now() + 1 };
  private active = false;
  private generation = 0;
  private operation?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private index = new SearchDocumentsIndex([]);
  private limit = HISTORY_READ_LIMIT;
  private disposed = false;
  private readonly stops: (() => void)[] = [];
  readonly authority?: ModelAuthority;
  private transport?: ModelTransport;
  private proof?: { revision: number; signal: AbortSignal; request: string };
  constructor(
    private readonly reader: HistoryReader,
    private readonly emit: (state: HistorySearchState) => void,
    base?: ModelAuthority,
  ) {
    if (base) {
      this.authority = {
        read: () => base.read(),
        subscribe: listener => base.subscribe(listener),
        validateHistory: async request => {
          const proof = this.proof;
          if (!proof || !this.state.consent || proof.request !== JSON.stringify(request))
            throw Error('history-authority');
          await this.reader.check(proof.revision, proof.signal);
          if (request.task === 'history-rank') {
            const current = await cancellable(base.read(), proof.signal);
            if (allowedHistory(request.items, current.tree, current.privacy).length !== request.items.length)
              throw Error('stale-context');
          }
        },
      };
      this.stops.push(
        base.subscribe(change => {
          if (change === 'tree') return;
          this.cancel();
          this.state.consent = false;
          this.publish();
        }),
      );
    }
    this.stops.push(
      reader.subscribe(() => {
        this.invalidate();
        this.state = { ...this.state, records: [], hits: [], consent: false, limited: false, error: 'history-changed' };
        this.index = new SearchDocumentsIndex([]);
        this.publish();
        void this.permission();
      }),
    );
  }
  attach(transport: ModelTransport) {
    this.transport = transport;
  }
  private publish() {
    if (!this.disposed) this.emit({ ...this.state, records: [...this.state.records], hits: [...this.state.hits] });
  }
  private invalidate() {
    this.generation++;
    clearTimeout(this.timer);
    this.operation?.abort();
    this.operation = undefined;
    this.proof = undefined;
    this.transport?.cancel();
    this.state.loading = false;
    this.state.searching = false;
    this.state.aiCount = undefined;
    this.state.aiRange = undefined;
  }
  private local() {
    if (!this.query.trim()) return this.state.records;
    const ids = new Set(this.index.query(this.query).map(hit => hit.id));
    return this.state.records.filter(record => ids.has(record.id));
  }
  private accept(records: HistoryRecord[], limited: boolean) {
    this.state.records = records;
    this.state.limited = limited;
    this.index = new SearchDocumentsIndex(records.map(record => ({ hit: { ...record, path: '' } })));
    this.state.hits = this.local();
  }
  async permission() {
    const generation = this.generation;
    try {
      const permission = await this.reader.boundary.contains();
      if (generation !== this.generation) return;
      this.state.permission = permission;
      if (!permission) this.accept([], false);
      this.publish();
    } catch {
      if (generation === this.generation) {
        this.state.error = 'history-unavailable';
        this.publish();
      }
    }
  }
  /** Called synchronously by the enable button to preserve the browser user gesture. */
  enable() {
    const pending = this.reader.boundary.request();
    void pending
      .then(granted => {
        if (this.disposed) return;
        this.state.permission = granted;
        this.state.error = granted ? '' : 'history-denied';
        this.publish();
        if (granted && this.active) void this.load();
      })
      .catch(() => {
        this.state.error = 'history-unavailable';
        this.publish();
      });
  }
  disable() {
    this.invalidate();
    this.state.permission = false;
    this.state.consent = false;
    this.accept([], false);
    this.publish();
    void this.reader.boundary.remove().catch(() => {
      this.state.error = 'history-unavailable';
      this.publish();
    });
  }
  consent(value: boolean) {
    this.cancel();
    this.state.consent = value;
    this.publish();
  }
  configure(query: string, range: HistoryRange, active: boolean) {
    this.invalidate();
    const changedRange = JSON.stringify(range) !== JSON.stringify(this.range);
    this.query = query;
    this.range = range;
    this.active = active;
    this.limit = HISTORY_READ_LIMIT;
    this.state.consent = false;
    this.state.error = '';
    if (changedRange || !active) this.accept([], false);
    else this.state.hits = this.local();
    this.publish();
    if (active) this.timer = setTimeout(() => void this.load(), 180);
  }
  async load(more = false) {
    this.invalidate();
    if (!this.active) return;
    if (more) this.limit += HISTORY_READ_LIMIT;
    const generation = this.generation;
    const operation = new AbortController();
    this.operation = operation;
    const timer = setTimeout(() => operation.abort(Error('history-timeout')), 15000);
    this.state.loading = true;
    this.state.error = '';
    this.publish();
    try {
      const result = await this.reader.read(
        this.range,
        this.query.trim() ? [this.query.trim()] : [],
        operation.signal,
        this.limit,
      );
      if (generation !== this.generation) return;
      this.state.permission = true;
      this.accept(result.records, result.limited);
    } catch (error) {
      if (generation !== this.generation) return;
      this.state.error = error instanceof Error ? error.message : 'history-unavailable';
      if (this.state.error === 'history-permission') {
        if (!this.state.permission) this.state.error = '';
        this.state.permission = false;
        this.accept([], false);
      }
    } finally {
      clearTimeout(timer);
      if (generation === this.generation) {
        this.state.loading = false;
        this.operation = undefined;
        this.publish();
      }
    }
  }
  cancel() {
    this.invalidate();
    this.state.hits = this.local();
    this.state.error = '';
    this.publish();
  }
  async search() {
    this.cancel();
    if (!this.state.consent || !this.query.trim() || !this.authority || !this.transport || !this.active) return;
    const generation = this.generation;
    const operation = new AbortController();
    this.operation = operation;
    this.state.searching = true;
    this.publish();
    const revision = this.reader.revision;
    const prepareTimer = setTimeout(() => operation.abort(Error('history-timeout')), 15000);
    try {
      await this.reader.check(revision, operation.signal);
      const context = await cancellable(this.authority.read(), operation.signal);
      if (!context.config) throw Error('unavailable');
      clearTimeout(prepareTimer);
      const run = async (request: HistoryAiRequest) => {
        this.proof = { revision, signal: operation.signal, request: JSON.stringify(request) };
        const result = await cancellable(
          this.transport!.run({ ...context, config: context.config!, request, signal: operation.signal }),
          operation.signal,
        );
        if (generation !== this.generation) throw Error('cancelled');
        if (result.status !== 'completed') throw Error(result.reason);
        return result.output;
      };
      const plan = historyQuerySchema.parse(
        await run({
          task: 'history-query',
          query: this.query,
          today: localDate(Date.now()),
          range: this.range,
          folderIds: [],
        }),
      );
      const range = inferredRange(this.range, plan);
      const retrievalTimer = setTimeout(() => operation.abort(Error('history-timeout')), 15000);
      let result: Awaited<ReturnType<HistoryReader['read']>>;
      try {
        result = await this.reader.read(range, plan.terms, operation.signal, 500);
      } finally {
        clearTimeout(retrievalTimer);
      }
      const records = allowedHistory(
        result.records.filter(record => historyDomainMatches(record.url, plan.domains)),
        context.tree,
        context.privacy,
      );
      const index = new SearchDocumentsIndex(records.map(record => ({ hit: { ...record, path: '' } })));
      const ids = new Set([this.query, ...plan.terms].flatMap(term => index.query(term).map(hit => hit.id)));
      const candidates = (
        records.length <= AI_SEARCH_CANDIDATES ? records : records.filter(record => ids.has(record.id))
      ).slice(0, AI_SEARCH_CANDIDATES);
      if (!candidates.length) throw Error('history-no-candidates');
      const ranked = await run({ task: 'history-rank', query: this.query, items: candidates, folderIds: [] });
      if (!('rankedIds' in ranked)) throw Error('schema');
      await this.reader.check(revision, operation.signal);
      if (generation !== this.generation) return;
      const byId = new Map(candidates.map(item => [item.id, item]));
      this.state.hits = ranked.rankedIds.map(id => byId.get(id)!);
      this.state.aiCount = candidates.length;
      this.state.aiRange = range;
    } catch (error) {
      if (generation === this.generation) {
        this.state.hits = this.local();
        this.state.error = error instanceof Error ? error.message : 'history-unavailable';
      }
    } finally {
      clearTimeout(prepareTimer);
      if (generation === this.generation) {
        this.operation = undefined;
        this.proof = undefined;
        this.state.searching = false;
        this.publish();
      }
    }
  }
  async verify(record: HistoryRecord) {
    const operation = new AbortController();
    const timer = setTimeout(() => operation.abort(), 5000);
    try {
      return await this.reader.exists(record, operation.signal);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  dispose() {
    this.disposed = true;
    this.invalidate();
    this.stops.forEach(stop => stop());
    this.transport?.dispose();
    this.reader.dispose();
  }
}
