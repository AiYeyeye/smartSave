import type { ModelResult } from '../adapters/model-transport';
import { cancellable } from '../domain/cancellable';

/** Bounded read-only prefetch. Results are consumed in queue order; only validated successes survive a pause. */
export class OrganizeBatchExecutor {
  private readonly active = new Map<string[], Promise<ModelResult>>();
  private readonly settled = new Map<string[], ModelResult>();
  private readonly controller = new AbortController();
  private readonly abort = () => this.stop();
  private stopped = false;
  constructor(
    private readonly accepted: Map<string[], ModelResult>,
    private readonly execute: (ids: string[], signal: AbortSignal) => Promise<ModelResult>,
    private concurrency: number,
    private readonly signal: AbortSignal,
    private readonly onReady: () => void,
    private readonly beforeReady?: () => Promise<void>,
  ) {
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.stop();
  }
  reduceConcurrency() {
    this.concurrency = 1;
  }
  async next(queue: string[][]): Promise<ModelResult> {
    if (this.stopped || !queue.length) throw Error('cancelled');
    for (const ids of queue) {
      const settled = this.settled.get(ids);
      // Do not schedule beyond a known failure, and never replay it within this invocation.
      if (settled && settled.status !== 'completed') break;
      if (this.accepted.has(ids) || settled || this.active.has(ids)) continue;
      if (this.active.size >= this.concurrency) break;
      const pending = Promise.resolve()
        .then(() => this.execute(ids, this.controller.signal))
        .catch(error => ({
          status: 'failed' as const,
          reason:
            error instanceof Error &&
            ['invalid-output', 'stale-context', 'bookmark-context-too-large', 'cancelled'].includes(error.message)
              ? error.message
              : 'unknown-error',
        }))
        .then(async result => {
          if (!this.stopped) {
            if (result.status === 'completed') {
              this.accepted.set(ids, result);
              try {
                await this.beforeReady?.();
              } catch {
                this.accepted.delete(ids);
                result = { status: 'failed', reason: 'checkpoint-unavailable' };
              }
            }
            if (!this.stopped) {
              this.settled.set(ids, result);
              if (result.status === 'completed') this.onReady();
            }
          }
          this.active.delete(ids);
          return result;
        });
      this.active.set(ids, pending);
    }
    const ids = queue[0]!;
    // A validated result awaiting durable storage is not yet ready for ordered consumption.
    const value = this.active.get(ids) ?? this.accepted.get(ids) ?? this.settled.get(ids);
    if (!value) throw Error('unavailable');
    return cancellable(Promise.resolve(value), this.controller.signal);
  }
  consume(ids: string[]) {
    this.accepted.delete(ids);
    this.settled.delete(ids);
  }
  stop() {
    this.stopped = true;
    this.signal.removeEventListener('abort', this.abort);
    this.controller.abort(Error('cancelled'));
  }
}
