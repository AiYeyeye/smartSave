import {
  CHECK_ALARM,
  CHECK_ORIGINS,
  MAX_CHECK_ITEMS,
  WEEK_MS,
  bookmarkCheckMessageSchema,
  checkScopeNodes,
  currentCheckResults,
  emptyBookmarkCheck,
  type BookmarkCheckMessage,
  type BookmarkCheckState,
  type LinkResult,
} from '../domain/bookmark-check';
import { groupDuplicateNodes } from '../domain/suspected-duplicates';
import { withTrustedSender } from '../domain/trusted-sender';
import { createBookmarkLinkProbe } from '../adapters/bookmark-link-check';
import { BookmarkCheckStore, type BookmarkCheckPersistence } from '../persistence/bookmark-check';
import type { TreeProjection } from './tree-projection';
import { createWorkerTaskLifetime } from './worker-task-lifetime';

type Options = {
  projection: Pick<TreeProjection, 'fresh'> & Partial<Pick<TreeProjection, 'state'>>;
  store: BookmarkCheckPersistence;
  permitted: () => Promise<boolean>;
  schedule: (when?: number) => Promise<void>;
  probe?: (url: string, signal: AbortSignal) => Promise<LinkResult>;
  now?: () => number;
  lifetime?: { acquire(): () => void };
  batchDelayMs?: number;
};

/** The worker owns one durable read-only scan. UI disconnects never cancel it. */
export class BookmarkCheckOwner {
  private state = emptyBookmarkCheck();
  private ready: Promise<void>;
  private tail = Promise.resolve();
  private running?: Promise<void>;
  private abort?: AbortController;
  private disposed = false;
  private now: () => number;
  private lifetime: { acquire(): () => void };
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.lifetime = options.lifetime ?? createWorkerTaskLifetime();
    this.ready = options.store.read().then(async state => {
      this.state = state;
      await options.schedule(state.weekly ? (state.nextRun ?? this.now() + WEEK_MS) : undefined);
      if (state.job?.status === 'running') this.launch();
    });
    void this.ready.catch(() => {});
  }
  private queue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  private async persist(next: BookmarkCheckState) {
    next = { ...next, revision: this.state.revision + 1 };
    await this.options.store.write(next);
    this.state = next;
  }
  private async scope(installationId: string, scopeId: string | null, observe = false) {
    // Availability scans are read-only. Reuse the live native event projection between requests;
    // starting/configuring and all deletion authority still require fresh native reads.
    const current = observe ? this.options.projection.state : undefined;
    const tree = current?.status === 'ready' ? current.snapshot : await this.options.projection.fresh();
    if (installationId !== tree.installationId) throw Error('installation-changed');
    const nodes = checkScopeNodes(tree, scopeId);
    if (nodes.length > MAX_CHECK_ITEMS) throw Error('scope-too-large');
    return { tree, nodes };
  }
  private async start(installationId: string, scopeId: string | null) {
    if (this.state.job?.status === 'running') throw Error('already-running');
    if (!(await this.options.permitted())) throw Error('permission-required');
    const { tree, nodes } = await this.scope(installationId, scopeId);
    const manual = currentCheckResults(tree, { ...this.state, job: undefined });
    const now = this.now();
    await this.persist({
      ...this.state,
      installationId,
      scopeId,
      notice: undefined,
      job: {
        id: crypto.randomUUID(),
        installationId,
        scopeId,
        status: 'running',
        startedAt: now,
        updatedAt: now,
        duplicateGroups: groupDuplicateNodes(nodes).length,
        items: nodes.map(node => ({
          nativeId: node.ref.nativeId,
          url: node.url ?? '',
          result: manual.get(node.ref.nativeId),
        })),
      },
    });
    this.launch();
  }
  async handle(message: BookmarkCheckMessage): Promise<BookmarkCheckState> {
    await this.ready;
    if (message.action === 'get') return structuredClone(this.state);
    return this.queue(async () => {
      if (message.action === 'start') await this.start(message.installationId, message.scopeId);
      if (message.action === 'verify') {
        const { tree, nodes } = await this.scope(message.installationId, null);
        const node = nodes.find(node => node.ref.nativeId === message.nativeId);
        if (!node || node.url !== message.url) throw Error('stale-selection');
        const current = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
        const verified = (this.state.verified ?? []).filter(
          item =>
            item.installationId === tree.installationId &&
            current.get(item.nativeId)?.url === item.url &&
            item.nativeId !== message.nativeId,
        );
        const result: LinkResult | undefined = message.available
          ? { status: 'ok', reason: 'manual', at: this.now() }
          : undefined;
        if (message.available)
          verified.push({
            installationId: message.installationId,
            nativeId: node.ref.nativeId,
            url: node.url!,
            at: this.now(),
          });
        await this.persist({
          ...this.state,
          verified,
          job: this.state.job && {
            ...this.state.job,
            items: this.state.job.items.map(item =>
              this.state.job!.installationId === message.installationId &&
              item.nativeId === message.nativeId &&
              item.url === message.url
                ? { ...item, result }
                : item,
            ),
          },
        });
      }
      if (message.action === 'configure') {
        const changed = message.scopeId !== this.state.scopeId || message.installationId !== this.state.installationId;
        // Turning a schedule off must work even after its folder was removed.
        if (message.weekly || changed) await this.scope(message.installationId, message.scopeId);
        if (message.weekly && !(await this.options.permitted())) throw Error('permission-required');
        if (changed && this.state.job?.status === 'running') throw Error('already-running');
        const nextRun = message.weekly ? (this.state.nextRun ?? this.now() + WEEK_MS) : undefined;
        await this.persist({
          ...this.state,
          installationId: message.installationId,
          scopeId: message.scopeId,
          weekly: message.weekly,
          nextRun,
          notice: undefined,
          ...(changed ? { job: undefined } : {}),
        });
        await this.options.schedule(nextRun);
      }
      if (message.action === 'pause') await this.pause();
      if (message.action === 'resume') {
        const job = this.state.job;
        if (!job || !['paused', 'error'].includes(job.status)) throw Error('no-paused-check');
        await this.scope(job.installationId, job.scopeId);
        if (!(await this.options.permitted())) throw Error('permission-required');
        await this.persist({
          ...this.state,
          notice: undefined,
          job: { ...job, status: 'running', updatedAt: this.now() },
        });
        this.launch();
      }
      return structuredClone(this.state);
    });
  }
  private async pause(notice?: string) {
    this.abort?.abort();
    const job = this.state.job;
    if (job?.status === 'running') {
      const next = { ...this.state, notice, job: { ...job, status: 'paused' as const, updatedAt: this.now() } };
      try {
        await this.persist(next);
      } catch {
        // Cancellation must remain effective even if its durable checkpoint fails.
        this.state = { ...next, revision: this.state.revision + 1, notice: 'storage-unavailable' };
        throw Error('storage-unavailable');
      }
    }
  }
  async permissionsChanged() {
    await this.ready;
    return this.queue(async () => {
      if (!(await this.options.permitted())) await this.pause('permission-required');
    });
  }
  async weekly() {
    await this.ready;
    return this.queue(async () => {
      if (!this.state.weekly) return;
      await this.persist({ ...this.state, nextRun: this.now() + WEEK_MS });
      // Never replace active or deliberately paused work with another scheduled scan.
      if (this.state.job && ['running', 'paused'].includes(this.state.job.status)) return;
      try {
        await this.start(this.state.installationId, this.state.scopeId);
      } catch (error) {
        await this.persist({ ...this.state, notice: error instanceof Error ? error.message : 'check-failed' });
      }
    });
  }
  private launch() {
    if (this.running || this.disposed) return;
    const controller = new AbortController();
    this.abort = controller;
    const release = this.lifetime.acquire();
    this.running = Promise.resolve()
      .then(() => this.run(controller.signal))
      .catch(async error => {
        if (controller.signal.aborted || this.disposed) return;
        await this.queue(async () => {
          const notice = error instanceof Error ? error.message : 'check-failed';
          const next = {
            ...this.state,
            notice,
            job: this.state.job && { ...this.state.job, status: 'error' as const },
          };
          try {
            await this.persist(next);
          } catch {
            this.state = { ...next, notice: 'storage-unavailable' };
          }
        });
      })
      .finally(() => {
        release();
        this.running = undefined;
        // Wait behind pending pause/resume checkpoints before deciding to restart.
        if (!this.disposed)
          void this.queue(async () => {
            if (!this.disposed && this.state.job?.status === 'running') this.launch();
          });
      });
  }
  private async run(signal: AbortSignal) {
    const probe = this.options.probe ?? createBookmarkLinkProbe(this.state.job?.items);
    const cache = new Map<string, LinkResult>();
    for (const item of this.state.job?.items ?? [])
      if (item.result && !['changed', 'manual'].includes(item.result.reason)) cache.set(item.url, item.result);
    while (!signal.aborted && !this.disposed) {
      const job = this.state.job;
      if (!job || job.status !== 'running') return;
      const pending = job.items.filter(item => !item.result);
      if (!pending.length) {
        await this.queue(async () => {
          if (this.state.job?.id === job.id && !signal.aborted)
            await this.persist({
              ...this.state,
              job: { ...this.state.job, status: 'completed', updatedAt: this.now() },
            });
        });
        return;
      }
      if (!(await this.options.permitted())) {
        await this.queue(() => this.pause('permission-required'));
        return;
      }
      const { tree, nodes } = await this.scope(job.installationId, job.scopeId, true);
      const current = new Map(nodes.map(node => [node.ref.nativeId, node]));
      // At most two hosts concurrently, and one in-flight request per host.
      const hosts = new Set<string>();
      let cached = 0;
      const batch = pending.filter(item => {
        if (cache.has(item.url)) return cached++ < 100;
        let host = item.url;
        try {
          host = new URL(item.url).hostname;
        } catch {
          /* Unsupported links get a local skipped result. */
        }
        if (hosts.size >= 2 || hosts.has(host)) return false;
        hosts.add(host);
        return true;
      });
      const results = await Promise.all(
        batch.map(async item => {
          const node = current.get(item.nativeId);
          const result =
            !node || node.url !== item.url || tree.installationId !== job.installationId
              ? { status: 'skipped' as const, reason: 'changed' as const, at: this.now() }
              : (cache.get(item.url) ?? (await probe(item.url, signal)));
          if (result.reason !== 'changed') cache.set(item.url, result);
          return { ...item, result };
        }),
      );
      if (signal.aborted) return;
      await this.queue(async () => {
        if (signal.aborted || this.state.job?.id !== job.id || this.state.job.status !== 'running') return;
        const updates = new Map(results.map(item => [item.nativeId, item]));
        await this.persist({
          ...this.state,
          job: {
            ...this.state.job,
            updatedAt: this.now(),
            items: this.state.job.items.map(item =>
              item.result?.reason === 'manual' ? item : (updates.get(item.nativeId) ?? item),
            ),
          },
        });
      });
      if (!signal.aborted && (this.options.batchDelayMs ?? 200) > 0)
        await new Promise<void>(resolve => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, this.options.batchDelayMs ?? 200);
          signal.addEventListener('abort', finish, { once: true });
        });
    }
  }
  /** Test/host shutdown: durable running progress is resumed by the next worker, not marked completed. */
  dispose() {
    this.disposed = true;
    this.abort?.abort();
  }
}

export function startBookmarkChecks(projection: TreeProjection) {
  const owner = new BookmarkCheckOwner({
    projection,
    store: new BookmarkCheckStore(),
    permitted: async () => !!(await chrome.permissions?.contains({ origins: CHECK_ORIGINS })),
    schedule: async when => {
      if (!chrome.alarms) {
        if (when !== undefined) throw Error('schedule-unavailable');
        return;
      }
      if (when === undefined) {
        await chrome.alarms.clear(CHECK_ALARM);
        return;
      }
      const alarm = await chrome.alarms.get(CHECK_ALARM);
      if (!alarm)
        await chrome.alarms.create(CHECK_ALARM, {
          when: Math.max(when, Date.now() + 1000),
          periodInMinutes: WEEK_MS / 60000,
        });
    },
  });
  chrome.runtime.onMessage.addListener((raw: unknown, sender, reply) => {
    if (!raw || typeof raw !== 'object' || !('type' in raw) || raw.type !== 'bookmarkCheck') return false;
    return withTrustedSender(
      sender,
      chrome.runtime.id,
      () => {
        const parsed = bookmarkCheckMessageSchema.safeParse(raw);
        if (!parsed.success) {
          reply({ status: 'error', reason: 'invalid-request' });
          return false;
        }
        void owner
          .handle(parsed.data)
          .then(state => reply({ status: 'ok', state }))
          .catch(error => reply({ status: 'error', reason: error instanceof Error ? error.message : 'check-failed' }));
        return true;
      },
      () => reply({ status: 'error', reason: 'invalid-sender' }),
    );
  });
  chrome.alarms?.onAlarm.addListener(alarm => {
    if (alarm.name === CHECK_ALARM) void owner.weekly().catch(() => {});
  });
  chrome.permissions?.onRemoved?.addListener(() => {
    void owner.permissionsChanged().catch(() => {});
  });
  return owner;
}
