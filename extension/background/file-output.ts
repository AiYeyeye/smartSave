import { fileOutputAncestry } from '../domain/file-output-scope';
import {
  fileOutputMessageSchema,
  fileOutputReceipt,
  type FileOutputCommand,
  type FileOutputReceipt,
} from '../export/file-output-control';
export { fileOutputMessageSchema } from '../export/file-output-control';
import {
  assertExportProjectionCurrent,
  createExportProjection,
  ExportProjectionError,
} from '../domain/export-projection';
import type { TreeSnapshot } from '../domain/node-reference';
import { serializeExportJSON } from '../export/serializers';
import { FileOutputStore, type FileOutputMetadata, type FileOutputRecord } from '../persistence/file-output';
import { trustedMutationSender } from '../domain/trusted-sender';
import type { TreeProjection } from './tree-projection';

const identity = (tree: TreeSnapshot) => JSON.stringify([tree.installationId, tree.epoch, tree.observedRevision]);
class StaleOutput extends Error {}
export class FileOutputSink {
  private target?: FileOutputRecord;
  private version = 0;
  private dirty = 0;
  private completed = 0;
  private seen = '';
  private busy = false;
  private paused = true;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly debounceMs: number;
  private detach: () => void;
  private controls: Promise<unknown> = Promise.resolve();
  private state: { status: FileOutputMetadata['status'] | 'storage-error'; generation?: string; lastSuccess?: string } =
    { status: 'stopped' };
  constructor(
    private tree: TreeProjection,
    private store: FileOutputStore,
    options: { debounceMs?: number } = {},
  ) {
    this.debounceMs = options.debounceMs ?? 1500;
    this.detach = tree.subscribe(value => {
      // Only a native read failure fences in-flight work; transient loading is not evidence of change.
      if (value.status === 'error') {
        this.version++;
        return;
      }
      if (value.status !== 'ready') return;
      const next = identity(value.snapshot);
      if (next !== this.seen) {
        this.seen = next;
        this.dirty++;
      }
      this.schedule();
    });
  }
  status() {
    return { ...this.state };
  }
  /** Internal startup/test entry; runtime commands always carry exact correlation fields. */
  async control(action: 'reload' | 'retry' | 'stop', expectedGeneration?: string): Promise<FileOutputReceipt> {
    if (action === 'stop') return this.command({ version: 1, type: 'fileOutput', action, ticket: crypto.randomUUID() });
    try {
      const target = await this.store.read();
      if (!target)
        return fileOutputReceipt(
          {
            version: 1,
            type: 'fileOutput',
            action,
            ticket: crypto.randomUUID(),
            expectedGeneration: 'none',
            expectedRevision: 0,
          },
          'stale',
        );
      return this.command({
        version: 1,
        type: 'fileOutput',
        action,
        ticket: crypto.randomUUID(),
        expectedGeneration: expectedGeneration ?? target.generation,
        expectedRevision: target.controlRevision,
      });
    } catch {
      this.version++;
      this.paused = true;
      this.state = { status: 'storage-error' };
      return fileOutputReceipt(
        {
          version: 1,
          type: 'fileOutput',
          action,
          ticket: crypto.randomUUID(),
          expectedGeneration: expectedGeneration ?? 'unknown',
          expectedRevision: 0,
        },
        'storage-error',
      );
    }
  }
  command(command: FileOutputCommand): Promise<FileOutputReceipt> {
    // Explicit stop fences immediately; stale reload/retry/prepare must not pause another target.
    if (command.action === 'stop') {
      this.version++;
      this.paused = true;
    }
    let version = this.version;
    const run = async (): Promise<FileOutputReceipt> => {
      const receipt = (outcome: FileOutputReceipt['outcome'], revision?: number) =>
        fileOutputReceipt(command, outcome, revision);
      if (this.disposed || version !== this.version) return receipt('stale');
      try {
        if (command.action === 'stop' || command.action === 'prepare') {
          const revision = await this.store.stop(command.action === 'prepare' ? command.lease : undefined);
          if (revision === undefined) return receipt('conflict');
          if (this.disposed || version !== this.version) return receipt('stale');
          this.version++;
          this.paused = true;
          this.target = undefined;
          this.state = { status: 'stopped' };
          return receipt('accepted', revision);
        }
        const target = await this.store.read();
        if (
          this.disposed ||
          version !== this.version ||
          !target?.enabled ||
          target.generation !== command.expectedGeneration ||
          target.controlRevision !== command.expectedRevision
        )
          return receipt('stale');
        this.version++;
        this.paused = true;
        version = this.version;
        // A persisted failure stays paused across worker wakes. Retry is explicit.
        if (command.action === 'reload' && !['pending', 'success'].includes(target.status)) {
          this.state = { status: target.status, generation: target.generation, lastSuccess: target.lastSuccess };
          return receipt('stale');
        }
        if (
          command.action === 'retry' &&
          !(await this.store.update(
            target.generation,
            { status: 'pending' },
            () => version === this.version && !this.disposed,
          ))
        )
          return receipt('stale');
        const current = await this.store.read();
        if (
          this.disposed ||
          version !== this.version ||
          !current?.enabled ||
          current.generation !== target.generation ||
          current.controlRevision !== command.expectedRevision
        )
          return receipt('stale');
        this.target = current;
        this.paused = false;
        this.dirty++;
        this.state = { status: 'pending', generation: target.generation, lastSuccess: target.lastSuccess };
        // An explicit command writes the current authoritative snapshot at once; only an unavailable tree is re-read.
        if (this.tree.state.status === 'ready') this.kick();
        else this.tree.refresh();
        return receipt('accepted', target.controlRevision);
      } catch {
        if (version === this.version) {
          this.version++;
          this.paused = true;
          this.state = { status: 'storage-error' };
        }
        return receipt('storage-error');
      }
    };
    const result = this.controls.then(run);
    this.controls = result.catch(() => {});
    return result;
  }
  dispose() {
    this.disposed = true;
    this.paused = true;
    this.version++;
    clearTimeout(this.timer);
    this.detach();
  }
  /** Trailing debounce: a burst of native events yields one pass over the latest snapshot. */
  private schedule() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.debounceMs) {
      this.kick();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.kick();
    }, this.debounceMs);
  }
  private kick() {
    if (
      this.busy ||
      this.paused ||
      this.disposed ||
      !this.target ||
      this.tree.state.status !== 'ready' ||
      this.dirty === this.completed
    )
      return;
    this.busy = true;
    this.state = { ...this.state, status: 'pending' };
    void this.pass().finally(() => {
      this.busy = false;
      this.schedule();
    });
  }
  private async pass() {
    const target = this.target!;
    const version = this.version;
    const dirty = this.dirty;
    if (this.tree.state.status !== 'ready') return;
    const snapshot = this.tree.state.snapshot;
    let stream: Awaited<ReturnType<FileOutputRecord['handle']['createWritable']>> | undefined;
    let closed = false;
    const current = () => {
      if (
        this.disposed ||
        this.paused ||
        version !== this.version ||
        target !== this.target ||
        this.tree.state.status !== 'ready' ||
        identity(this.tree.state.snapshot) !== identity(snapshot)
      )
        throw new StaleOutput();
    };
    const fence = async () => {
      current();
      const stored = await this.store.read();
      current();
      if (!stored?.enabled || stored.generation !== target.generation) {
        this.paused = true;
        this.state = { status: 'stopped' };
        throw new StaleOutput();
      }
    };
    try {
      current();
      if (JSON.stringify(fileOutputAncestry(snapshot, target.scope)) !== JSON.stringify(target.ancestry))
        throw new ExportProjectionError('scope-invalid-or-stale');
      const projection = createExportProjection(snapshot, target.scope, new Date().toISOString());
      const text = serializeExportJSON(projection);
      await fence();
      const permission = await target.handle.queryPermission({ mode: 'readwrite' });
      current();
      if (permission !== 'granted') {
        await this.pause(target, 'needs-permission');
        return;
      }
      await fence();
      stream = await target.handle.createWritable();
      current();
      await fence();
      assertExportProjectionCurrent(
        projection,
        this.tree.state.status === 'ready' ? this.tree.state.snapshot : snapshot,
      );
      current();
      await stream.write(text);
      current();
      await fence();
      await stream.close();
      closed = true;
      current();
      await fence();
      const lastSuccess = new Date().toISOString();
      if (
        !(await this.store.update(target.generation, { status: 'success', lastSuccess }, () => {
          try {
            current();
            return true;
          } catch {
            return false;
          }
        }))
      )
        throw new StaleOutput();
      current();
      this.completed = dirty;
      this.state = { status: 'success', generation: target.generation, lastSuccess };
    } catch (error) {
      if (stream && !closed) {
        try {
          await stream.abort();
        } catch {
          /* Issued writes/close are not an external transaction. */
        }
      }
      if (error instanceof StaleOutput) return;
      if (version === this.version && target === this.target && !this.disposed)
        await this.pause(
          target,
          error instanceof ExportProjectionError && error.code === 'scope-invalid-or-stale'
            ? 'scope-invalid'
            : 'paused',
        );
    }
  }
  private async pause(target: FileOutputRecord, status: FileOutputMetadata['status']) {
    const version = this.version;
    this.paused = true;
    this.state = { status, generation: target.generation, lastSuccess: this.state.lastSuccess };
    try {
      await this.store.update(target.generation, { status });
    } catch {
      if (version === this.version) this.state = { ...this.state, status: 'storage-error' };
    }
  }
}
export function startFileOutput(tree: TreeProjection, store = new FileOutputStore()) {
  const sink = new FileOutputSink(tree, store);
  chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
    const parsed = fileOutputMessageSchema.safeParse(message);
    if (!parsed.success || !trustedMutationSender(sender, chrome.runtime.id)) return false;
    if (parsed.data.action === 'status') {
      reply(sink.status());
      return false;
    }
    void sink.command(parsed.data).then(reply);
    return true;
  });
  void sink.control('reload');
  return sink;
}
