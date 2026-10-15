import { ModelTransport } from '../adapters/model-transport';
import type { ModelAuthority } from '../adapters/model-authority';
import type { ModelSettingsReader } from '../adapters/feature-model-settings';
import { OrganizeController } from '../panel/organize-controller';
import type { GenerationOptions, OrganizeState } from '../domain/organize-state';
import type { OrganizePreference } from '../domain/organize-preferences';
import type { OrganizeCheckpoint } from '../domain/organize-checkpoint';
import type { OrganizeCheckpointStore } from '../persistence/organize-checkpoints';
import type { OrganizeMemoryStore } from '../persistence/organize-memory';
import { organizeProtectionChanged } from '../domain/organize-memory-context';
import { cancellable } from '../domain/cancellable';
import { createWorkerTaskLifetime } from './worker-task-lifetime';
import { organizeModelAuthority, type OrganizeCredentialGrant } from './organize-model-authority';
import type { TreeProjection } from './tree-projection';

export type OrganizeTaskView = {
  id: string;
  revision: number;
  state: OrganizeState;
  needsCredential: boolean;
  submission?: { requestId: string };
};
type Task = {
  installationId: string;
  id: string;
  revision: number;
  state: OrganizeState;
  controller: OrganizeController;
  hasCredential: boolean;
  checkpoint?: OrganizeCheckpoint;
  operation?: Promise<void>;
  persistence: Promise<void>;
  ready: Promise<void>;
  readyResolve: () => void;
  stopTree: () => void;
  retired: boolean;
  persistenceFailed: boolean;
  editing: boolean;
  memoryRefresh?: Promise<void>;
};
type Options = {
  projection: Pick<TreeProjection, 'fresh' | 'subscribe' | 'state'>;
  settings: ModelSettingsReader;
  store: Pick<OrganizeCheckpointStore, 'get' | 'list' | 'put' | 'remove'>;
  memory?: Pick<OrganizeMemoryStore, 'load'>;
  model?: (authority: ModelAuthority) => NonNullable<ConstructorParameters<typeof OrganizeController>[2]>;
  lifetime?: ReturnType<typeof createWorkerTaskLifetime>;
};

/** Owns read-only generation. Subscribers and their ports are not task lifetime owners. */
export class OrganizeTaskOwner {
  private tasks = new Map<string, Task>();
  private submissions = new Map<string, OrganizeCheckpoint>();
  private listeners = new Set<(view: OrganizeTaskView) => void>();
  private lifetime: ReturnType<typeof createWorkerTaskLifetime>;
  private closed = false;
  private starting = false;
  private loading = new Set<string>();
  private stopping = new AbortController();
  constructor(private options: Options) {
    this.lifetime = options.lifetime ?? createWorkerTaskLifetime();
  }
  private async bounded<T>(pending: Promise<T>) {
    const deadline = new AbortController();
    const abort = () => deadline.abort(Error('organize-task-unavailable'));
    this.stopping.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 10_000);
    try {
      if (this.closed) abort();
      return await cancellable(pending, deadline.signal);
    } finally {
      clearTimeout(timer);
      this.stopping.signal.removeEventListener('abort', abort);
    }
  }
  subscribe(listener: (view: OrganizeTaskView) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private submittedView(checkpoint: OrganizeCheckpoint): OrganizeTaskView {
    return {
      id: checkpoint.id,
      revision: checkpoint.revision,
      needsCredential: false,
      submission: { requestId: checkpoint.submission!.requestId },
      state: {
        tree: this.options.projection.state,
        scopeId: checkpoint.root.nativeId,
        selected: [],
        targets: {},
        duplicates: [],
        choices: {},
        busy: false,
        invalid: true,
        message: '此整理任务已提交，请查看执行记录确认结果。',
      },
    };
  }
  /** Called only after the journal's atomic handoff. Retire generation without rewriting its association. */
  submitted(checkpoint: OrganizeCheckpoint) {
    if (!checkpoint.submission || this.closed) return;
    this.submissions.set(checkpoint.id, structuredClone(checkpoint));
    const task = this.tasks.get(checkpoint.id);
    if (task) this.retire(task);
    const view = this.submittedView(checkpoint);
    for (const listener of this.listeners) listener(structuredClone(view));
  }
  private view(task: Task): OrganizeTaskView {
    return {
      id: task.id,
      revision: task.revision,
      state: structuredClone({
        ...task.state,
        busy: task.state.busy || !!task.operation || task.editing,
        invalid: task.state.invalid || task.persistenceFailed,
      }),
      needsCredential: !!task.checkpoint?.requiresCredential && !task.hasCredential,
    };
  }
  private publish(task: Task) {
    if (this.closed || task.retired) return;
    const view = this.view(task);
    for (const listener of this.listeners) listener(structuredClone(view));
  }
  private persist(task: Task): Promise<void> {
    const pending = task.persistence
      .catch(() => {})
      .then(async () => {
        if (this.closed || task.retired) throw Error('organize-task-unavailable');
        let value = await this.bounded(task.controller.checkpoint(task.id, task.revision + 1));
        if (!value && task.checkpoint)
          value = { ...task.checkpoint, revision: task.revision + 1, updatedAt: Date.now(), status: 'invalid' };
        if (!value) return;
        await this.bounded(this.options.store.put(value, task.revision < 0 ? null : task.revision));
        task.revision = value.revision;
        task.checkpoint = value;
        task.readyResolve();
      });
    task.persistence = pending;
    return pending;
  }
  private retire(task: Task) {
    task.retired = true;
    task.stopTree();
    task.controller.dispose();
    this.tasks.delete(task.id);
  }
  private require(id: string, revision?: number) {
    const task = this.tasks.get(id);
    if (this.closed || !task) throw Error('organize-task-unavailable');
    if (revision !== undefined && task.revision !== revision) throw Error('organize-task-conflict');
    if (task.persistenceFailed) throw Error('organize-checkpoint-unavailable');
    return task;
  }
  private edit(id: string, revision: number) {
    const task = this.require(id, revision);
    if (task.editing || task.memoryRefresh || this.loading.has(id)) throw Error('organize-task-conflict');
    task.editing = true;
    return task;
  }
  private async create(id: string, grant?: OrganizeCredentialGrant, checkpoint?: OrganizeCheckpoint) {
    const slot: { value?: Task } = {};
    const base = organizeModelAuthority(this.options.projection, this.options.settings, grant);
    const authority: ModelAuthority = {
      subscribe: listener => base.subscribe(listener),
      read: async () => {
        const task = slot.value;
        const current = await base.read();
        if (task?.checkpoint && this.options.memory) {
          const memory = await this.bounded(this.options.memory.load(current.tree.installationId));
          if (organizeProtectionChanged(task.checkpoint, current.tree, memory.protectedFolderIds)) {
            task.controller.protectionChanged();
            throw Error('stale-context');
          }
        }
        return current;
      },
    };
    const context = await this.bounded(authority.read());
    if (this.options.memory && checkpoint) {
      const memory = await this.bounded(this.options.memory.load(context.tree.installationId));
      if (organizeProtectionChanged(checkpoint, context.tree, memory.protectedFolderIds)) throw Error('stale-context');
    }
    const model =
      this.options.model?.(authority) ??
      new ModelTransport(
        {
          fetch: (...args) => fetch(...args),
          contains: request => chrome.permissions.contains(request),
        },
        authority,
      );
    let readyResolve!: () => void;
    const ready = new Promise<void>(resolve => {
      readyResolve = resolve;
    });
    const controller = new OrganizeController(
      state => {
        const task = slot.value;
        if (!task) return;
        task.state = state;
        if (!state.busy && task.operation) return; // Completion is published only after its final checkpoint.
        if (state.invalid && task.checkpoint?.status !== 'invalid' && !task.operation)
          void this.persist(task).then(
            () => this.publish(task),
            () => {
              task.persistenceFailed = true;
              this.publish(task);
            },
          );
        else this.publish(task);
      },
      authority,
      model,
      undefined,
      undefined,
      {
        generationOnly: true,
        persist: () => (slot.value ? this.persist(slot.value) : Promise.reject(Error('organize-task-unavailable'))),
      },
    );
    const task: Task = {
      installationId: context.tree.installationId,
      id,
      revision: checkpoint?.revision ?? -1,
      state: {
        tree: this.options.projection.state,
        scopeId: '',
        selected: [],
        targets: {},
        duplicates: [],
        choices: {},
        invalid: false,
        busy: false,
        message: '正在读取整理任务…',
      },
      controller,
      hasCredential: !!context.key,
      checkpoint,
      persistence: Promise.resolve(),
      ready,
      readyResolve,
      stopTree: () => {},
      retired: false,
      persistenceFailed: false,
      editing: true,
    };
    slot.value = task;
    this.tasks.set(id, task);
    task.stopTree = this.options.projection.subscribe(tree => controller.setTree(tree));
    return task;
  }
  private launch(task: Task, run: () => Promise<void>) {
    if (task.operation || task.state.busy) throw Error('organize-task-busy');
    const release = this.lifetime.acquire();
    task.operation = Promise.resolve()
      .then(run)
      .catch(() => {
        // Controllers expose only allowlisted diagnostics in state; never forward raw provider exceptions.
        task.state = { ...task.state, invalid: true, busy: false, message: '本次整理已停止，请检查配置后重新开始。' };
      })
      .then(async () => {
        if (!this.closed && !task.retired) {
          try {
            await this.persist(task);
          } catch {
            task.persistenceFailed = true;
            task.state.message = '无法保存整理进度，请检查本机存储后重新打开。';
          }
        }
      })
      .finally(() => {
        task.operation = undefined;
        task.readyResolve();
        release();
        this.publish(task);
      });
    this.publish(task);
  }
  async start(input: {
    scopeId: string;
    preference: OrganizePreference;
    options: GenerationOptions;
    credential?: OrganizeCredentialGrant;
  }) {
    if (
      this.starting ||
      this.loading.size ||
      [...this.tasks.values()].some(task => task.operation || task.state.busy || task.editing)
    )
      throw Error('organize-task-busy');
    this.starting = true;
    const release = this.lifetime.acquire();
    let created: Task | undefined;
    try {
      for (const task of this.tasks.values()) this.retire(task);
      const task = await this.create(crypto.randomUUID(), input.credential);
      created = task;
      const options = structuredClone(input.options);
      if (this.options.memory) {
        const memory = await this.bounded(this.options.memory.load(task.installationId));
        options.protectedFolderIds = [
          ...new Set([...(options.protectedFolderIds ?? []), ...memory.protectedFolderIds]),
        ];
        options.rejectedSignatures = [
          ...new Set([...(options.rejectedSignatures ?? []), ...memory.rejected.map(value => value.signature)]),
        ];
      }
      task.controller.selectScope(input.scopeId);
      this.launch(task, () => task.controller.generate(input.preference, { ...options, staged: true }));
      task.editing = false;
      await this.bounded(task.ready);
      return this.view(task);
    } catch (error) {
      if (created && !created.retired) this.retire(created);
      throw error;
    } finally {
      this.starting = false;
      release();
    }
  }
  async get(id: string, credential?: OrganizeCredentialGrant) {
    return this.load(id, credential);
  }
  /** Memory edits prune review choices; they do not pretend the model route has changed. */
  async refreshMemory(installationId: string) {
    await Promise.all(
      [...this.tasks.values()]
        .filter(task => task.installationId === installationId)
        .map(task => this.refreshTaskMemory(task)),
    );
  }
  private refreshTaskMemory(task: Task): Promise<void> {
    if (!this.options.memory || !task.checkpoint || task.state.invalid || task.retired || this.closed)
      return Promise.resolve();
    if (task.memoryRefresh) return task.memoryRefresh;
    const pending = Promise.resolve()
      .then(async () => {
        const memory = await this.bounded(this.options.memory!.load(task.installationId));
        if (task.retired || this.closed) return;
        const state = this.options.projection.state;
        if (state.status !== 'ready') throw Error('organize-task-unavailable');
        if (organizeProtectionChanged(task.checkpoint!, state.snapshot, memory.protectedFolderIds)) {
          task.controller.protectionChanged();
          if (task.operation) await this.bounded(task.operation);
          if (!task.retired) await this.persist(task);
          return;
        }
        let result = task.controller.refreshRejections(memory.rejected.map(value => value.signature));
        if (result.locked) {
          // A taxonomy refusal changes subsequent destinations. Return to its review before any further batch.
          task.controller.pauseBatches();
          if (task.operation) await this.bounded(task.operation);
          if (task.retired || this.closed) return;
          task.controller.returnToFolders();
          result = task.controller.refreshRejections(memory.rejected.map(value => value.signature));
          result.changed = true;
        }
        if (result.changed) await this.persist(task);
        this.publish(task);
      })
      .catch(error => {
        if (!task.retired && !this.closed) {
          if (error instanceof Error && error.message.startsWith('organize-checkpoint-')) task.persistenceFailed = true;
          task.state.message = '无法读取整理偏好，请检查本机存储后重新打开；已保存进度保留。';
          this.publish(task);
        }
        throw error;
      })
      .finally(() => {
        task.memoryRefresh = undefined;
      });
    task.memoryRefresh = pending;
    return pending;
  }
  private async load(id: string, credential?: OrganizeCredentialGrant, editing?: Task) {
    if (this.closed) throw Error('organize-task-unavailable');
    const submission = this.submissions.get(id);
    if (submission) return this.submittedView(submission);
    if (this.loading.has(id)) throw Error('organize-task-busy');
    const existing = this.tasks.get(id);
    if (existing?.editing && existing !== editing) throw Error('organize-task-busy');
    if (existing && !credential) {
      await this.refreshTaskMemory(existing);
      return this.view(existing);
    }
    if (existing?.operation) throw Error('organize-task-busy');
    if (this.starting) throw Error('organize-task-busy');
    this.loading.add(id);
    const release = this.lifetime.acquire();
    try {
      const checkpoint = await this.bounded(this.options.store.get(id));
      if (!checkpoint) throw Error('organize-task-unavailable');
      if (checkpoint.submission) {
        this.submitted(checkpoint);
        return this.submittedView(checkpoint);
      }
      if (existing) this.retire(existing);
      const task = await this.create(id, credential, checkpoint);
      try {
        await task.controller.restoreCheckpoint(checkpoint, { allowMissingCredential: true });
        await this.refreshTaskMemory(task);
        await this.persist(task); // A running call becomes a durable paused task after worker replacement.
        task.editing = false;
        this.publish(task);
      } catch (error) {
        this.retire(task);
        throw error;
      }
      return this.view(task);
    } finally {
      this.loading.delete(id);
      release();
    }
  }
  async list() {
    return this.bounded(this.options.store.list());
  }
  async command(
    id: string,
    revision: number,
    action: 'confirmFolders' | 'resume' | 'pause' | 'cancel' | 'returnToFolders',
    credential?: OrganizeCredentialGrant,
  ) {
    let task = this.edit(id, revision);
    const editingTask = task;
    try {
      if (credential) {
        await this.load(id, credential, task);
        task = this.require(id);
        task.editing = true;
      }
      await this.refreshTaskMemory(task);
      if (task.state.invalid && action !== 'cancel') throw Error('stale-context');
      if (action === 'pause' || action === 'cancel') {
        if (action === 'pause') task.controller.pauseBatches();
        else task.controller.cancel();
        await this.persist(task);
        task.editing = false;
        this.publish(task);
        return this.view(task);
      }
      if (task.operation || task.state.busy) throw Error('organize-task-busy');
      if (action === 'returnToFolders') {
        task.controller.returnToFolders();
        await this.persist(task);
      } else {
        if (this.view(task).needsCredential) throw Error('organize-credential-required');
        this.launch(task, () =>
          action === 'confirmFolders' ? task.controller.confirmFolders() : task.controller.resumeBatches(),
        );
      }
      task.editing = false;
      this.publish(task);
      return this.view(task);
    } finally {
      task.editing = false;
      editingTask.editing = false;
    }
  }
  async select(
    id: string,
    revision: number,
    edit: { ids: string[]; selected: boolean } | { id: string; target: string },
  ) {
    const task = this.edit(id, revision);
    try {
      await this.refreshTaskMemory(task);
      if (task.revision !== revision) throw Error('organize-task-conflict');
      if (task.operation || task.state.busy) throw Error('organize-task-busy');
      if ('ids' in edit) task.controller.toggleMany(edit.ids, edit.selected);
      else task.controller.target(edit.id, edit.target);
      await this.persist(task);
      task.editing = false;
      this.publish(task);
      return this.view(task);
    } finally {
      task.editing = false;
    }
  }
  dispose() {
    this.closed = true;
    this.stopping.abort();
    for (const task of this.tasks.values()) this.retire(task);
    this.listeners.clear();
    this.submissions.clear();
    this.lifetime.dispose();
  }
}
