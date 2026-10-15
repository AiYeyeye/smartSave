import { z } from 'zod';
import type { ModelSettingsReader } from '../adapters/feature-model-settings';
import { browserModelAuthority } from '../adapters/model-authority';
import type { OrganizeTaskView } from '../background/organize-task-owner';
import { settingsIdentity } from '../domain/context-dependencies';
import type { GenerationOptions, OrganizeState } from '../domain/organize-state';
import { organizePreference, type OrganizePreference } from '../domain/organize-preferences';
import {
  ORGANIZE_TASK_PORT,
  organizeTaskReplySchema,
  organizeTaskViewSchema,
  type OrganizeTaskMessage,
} from '../domain/organize-task-protocol';
import type { TreeState } from '../domain/node-reference';
import type { DuplicateChoice } from '../domain/exact-duplicates';
import { confirmSchema, mutationResultSchema, type MutationResult } from '../schemas/messages';
import { OrganizeController } from './organize-controller';
import { openOrganizerLease, type OpenOrganizerLease, type OrganizerLease } from './organizer-client';
import { submitMutation } from './mutation-client';

type Runtime = Pick<typeof chrome.runtime, 'connect' | 'sendMessage' | 'lastError'>;
export type OrganizeWorkbenchOwner = Pick<
  OrganizeController,
  'setTree' | 'selectScope' | 'generate' | 'scan' | 'choice' | 'previewDuplicates' | 'apply' | 'dispose'
> & {
  toggle(id: string, selected: boolean): void | Promise<void>;
  toggleMany(ids: string[], selected: boolean): void | Promise<void>;
  target(id: string, target: string): void | Promise<void>;
  cancel(): void | Promise<void>;
  pauseBatches(): void | Promise<void>;
  confirmFolders(): void | Promise<void>;
  resumeBatches(): void | Promise<void>;
  returnToFolders(): void | Promise<void>;
  restoreTask?(id: string): Promise<void>;
  refreshTasks?(): Promise<void>;
  observe?(reconcile?: boolean): Promise<void>;
  deselectForMemory?(id: string): Promise<boolean>;
};

/** Page observer and explicit command client. Disposing it never cancels worker generation. */
export class OrganizeTaskClient implements OrganizeWorkbenchOwner {
  private local: OrganizeController;
  private localState!: OrganizeState;
  private current?: OrganizeTaskView;
  private available: NonNullable<OrganizeState['task']>['available'] = [];
  private mode: 'local' | 'remote' = 'local';
  private tree: TreeState = { status: 'loading' };
  private closed = false;
  private connected = false;
  private port?: chrome.runtime.Port;
  private retry?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private queue: Promise<void> = Promise.resolve();
  private editing = 0;
  private lease?: OrganizerLease;
  private result?: MutationResult;
  private requestId?: string;
  private message?: string;
  private context = 0;
  private pending = new Set<() => void>();
  constructor(
    private emit: (state: OrganizeState) => void,
    private settings: ModelSettingsReader,
    private runtime: Runtime = chrome.runtime,
    private open: OpenOrganizerLease = openOrganizerLease,
  ) {
    this.local = new OrganizeController(state => {
      this.localState = state;
      this.publish();
    }, browserModelAuthority(settings));
    this.connect();
    void this.refreshTasks(true);
  }
  private publish() {
    if (this.closed || !this.localState) return;
    const state = this.mode === 'remote' && this.current ? this.current.state : this.localState;
    this.emit({
      ...state,
      tree: this.tree,
      busy: state.busy || this.editing > 0,
      invalid: state.invalid || (this.mode === 'remote' && !this.connected),
      ...(this.mode === 'remote' && this.result ? { result: this.result } : {}),
      ...(this.message ? { message: this.message } : {}),
      task: {
        id: this.mode === 'remote' ? this.current?.id : undefined,
        revision: this.mode === 'remote' ? this.current?.revision : undefined,
        connected: this.connected,
        needsCredential: this.mode === 'remote' && !!this.current?.needsCredential,
        requestId: this.mode === 'remote' ? (this.requestId ?? this.current?.submission?.requestId) : undefined,
        available: this.available,
      },
    });
  }
  private rpc(input: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let done = false;
      const stop = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(stop);
        reject(Error('organize-task-unavailable'));
      };
      const timer = setTimeout(stop, 35_000);
      this.pending.add(stop);
      try {
        this.runtime.sendMessage(input, (reply: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.pending.delete(stop);
          if (this.runtime.lastError) reject(Error('organize-task-unavailable'));
          else resolve(reply);
        });
      } catch {
        clearTimeout(timer);
        done = true;
        this.pending.delete(stop);
        reject(Error('organize-task-unavailable'));
      }
    });
  }
  private async taskRpc(input: OrganizeTaskMessage) {
    const reply = organizeTaskReplySchema.parse(await this.rpc(input));
    if (!reply.ok) throw Error(reply.reason);
    if (
      input.action === 'list'
        ? !('tasks' in reply)
        : !('task' in reply) || (input.action !== 'start' && 'task' in reply && reply.task.id !== input.id)
    )
      throw Error('organize-task-unavailable');
    return reply;
  }
  private accept(task: OrganizeTaskView) {
    if (this.closed || (this.current?.id === task.id && task.revision < this.current.revision)) return;
    this.current = task;
    if (this.port) this.connected = true;
    if (task.submission) this.requestId = task.submission.requestId;
    this.publish();
  }
  private watch() {
    this.port?.postMessage({
      version: 1,
      type: 'subscribe',
      ...(this.mode === 'remote' && this.current ? { id: this.current.id } : {}),
    });
  }
  private connect() {
    if (this.closed) return;
    try {
      const port = this.runtime.connect({ name: ORGANIZE_TASK_PORT });
      this.port = port;
      this.connected = !this.current;
      port.onMessage.addListener((input: unknown) => {
        if (this.closed || this.port !== port) return;
        const reply = z.strictObject({ version: z.literal(1), task: organizeTaskViewSchema }).safeParse(input);
        if (!reply.success || this.mode !== 'remote' || reply.data.task.id !== this.current?.id) return;
        this.accept(reply.data.task);
      });
      port.onDisconnect.addListener(() => {
        if (this.closed || this.port !== port) return;
        this.port = undefined;
        this.connected = false;
        this.message = '整理连接已断开，正在重新读取进度；后台任务不会因页面断开而取消。';
        this.publish();
        if (++this.retries <= 3) this.retry = setTimeout(() => this.connect(), 1000);
        else {
          this.message = '无法连接整理任务，请重新读取已保存任务或重新打开智栏。';
          this.publish();
        }
      });
      this.watch();
      // Reconnection reads only; an interrupted worker never resumes analysis automatically.
      if (this.mode === 'remote' && this.current) void this.restoreTask(this.current.id);
    } catch {
      this.connected = false;
      this.message = '无法连接整理任务，请重新打开智栏。';
      this.publish();
    }
  }
  private enqueue(action: () => Promise<void>): Promise<void> {
    this.editing++;
    this.publish();
    const operation = this.queue
      .then(async () => {
        if (!this.closed) await action();
      })
      .catch(async error => {
        if (this.closed) return;
        this.message =
          error instanceof Error && error.message === 'model-unconfigured'
            ? '请先在 AI 服务中为智能整理分配可用模型，再开始生成。'
            : error instanceof Error && error.message === 'organize-credential-required'
              ? '需要重新输入本次整理使用的 API Key，再点击继续；已完成建议保留。'
              : error instanceof Error &&
                  ['organize-task-conflict', 'organize-checkpoint-conflict'].includes(error.message)
                ? '整理进度已被其他页面更新，请重新读取任务后再操作。'
                : '整理请求未获确认，请重新读取已保存任务；不会自动重发分析或书签写入。';
        this.publish();
      })
      .finally(() => {
        this.editing--;
        this.publish();
      });
    this.queue = operation;
    return operation;
  }
  async refreshTasks(restoreLatest = false) {
    if (!this.port && !this.closed) {
      this.retries = 0;
      this.connect();
    }
    const context = this.context;
    try {
      const reply = await this.taskRpc({ version: 1, type: 'organizeTask', action: 'list' });
      if (this.closed || context !== this.context || !('tasks' in reply)) return;
      this.available = reply.tasks;
      this.publish();
      const latest = reply.tasks.find(task => task.readable && task.status !== 'invalid');
      if (restoreLatest && !this.current && latest) await this.restoreTask(latest.id);
    } catch {
      this.message = '无法读取已保存的整理任务，请重试；现有书签未修改。';
      this.publish();
    }
  }
  async restoreTask(id: string) {
    if (!this.port && !this.closed) this.connect();
    const context = ++this.context;
    const priorRequest = this.current?.id === id ? this.requestId : undefined;
    const priorResult = this.current?.id === id ? this.result : undefined;
    try {
      const reply = await this.taskRpc({ version: 1, type: 'organizeTask', action: 'get', id });
      if (this.closed || context !== this.context || !('task' in reply) || reply.task.id !== id) return;
      this.local.cancel();
      this.mode = 'remote';
      this.result = priorResult;
      this.requestId = priorRequest;
      this.message = undefined;
      this.accept(reply.task);
      this.watch();
      if (reply.task.submission || this.requestId) await this.observe();
    } catch {
      this.message = '无法恢复这项整理任务，请检查范围和模型配置；未自动继续分析。';
      this.publish();
    }
  }
  private async credential(required = false) {
    const value = await this.settings.snapshot();
    if (required && !value.key) throw Error('organize-credential-required');
    return value.key ? { revision: value.revision, identity: settingsIdentity(value), key: value.key } : undefined;
  }
  setTree(tree: TreeState) {
    this.tree = tree;
    this.local.setTree(tree);
    this.publish();
  }
  selectScope(id: string) {
    this.context++;
    this.mode = 'local';
    this.current = undefined;
    this.result = undefined;
    this.requestId = undefined;
    this.message = undefined;
    this.local.selectScope(id);
    this.watch();
    this.publish();
  }
  generate(preference?: OrganizePreference, options: GenerationOptions = {}) {
    this.context++;
    return this.enqueue(async () => {
      const scopeId = this.mode === 'remote' ? this.current!.state.scopeId : this.localState.scopeId;
      const credential = await this.credential();
      const reply = await this.taskRpc({
        version: 1,
        type: 'organizeTask',
        action: 'start',
        scopeId,
        preference: organizePreference(preference ?? { style: 'topic', instructions: '' }),
        options: {
          batchSize: options.batchSize ?? 100,
          cleanupEmpty: options.unfiledOnly ? false : options.cleanupEmpty,
          allowRename: options.unfiledOnly ? false : options.allowRename,
          unfiledOnly: options.unfiledOnly,
          protectedFolderIds: options.protectedFolderIds,
          rejectedSignatures: options.rejectedSignatures,
        },
        credential,
      });
      if (!('task' in reply)) throw Error('organize-task-unavailable');
      this.local.cancel();
      this.mode = 'remote';
      this.result = undefined;
      this.requestId = undefined;
      this.message = undefined;
      this.accept(reply.task);
      this.watch();
      void this.refreshTasks();
    });
  }
  private command(action: 'confirmFolders' | 'resume' | 'pause' | 'cancel' | 'returnToFolders') {
    return this.enqueue(async () => {
      if (!this.current) return;
      const credential =
        ['resume', 'confirmFolders'].includes(action) && this.current.needsCredential
          ? await this.credential(true)
          : undefined;
      const reply = await this.taskRpc({
        version: 1,
        type: 'organizeTask',
        action,
        id: this.current.id,
        expectedRevision: this.current.revision,
        ...(credential ? { credential } : {}),
      });
      if ('task' in reply) {
        this.message = undefined;
        this.accept(reply.task);
      }
    });
  }
  private edit(
    input: { ids: string[]; selected: boolean } | { actionId: string; targetId: string },
    saved?: () => void,
  ) {
    if (this.mode !== 'remote') {
      if ('ids' in input) this.local.toggleMany(input.ids, input.selected);
      else this.local.target(input.actionId, input.targetId);
      return;
    }
    return this.enqueue(async () => {
      if (!this.current) return;
      const reply = await this.taskRpc({
        version: 1,
        type: 'organizeTask',
        id: this.current.id,
        expectedRevision: this.current.revision,
        ...('ids' in input ? { action: 'select' as const, ...input } : { action: 'target' as const, ...input }),
      });
      if ('task' in reply) {
        this.message = undefined;
        this.accept(reply.task);
        saved?.();
      }
    });
  }
  toggle(id: string, selected: boolean) {
    return this.edit({ ids: [id], selected });
  }
  toggleMany(ids: string[], selected: boolean) {
    return this.edit({ ids, selected });
  }
  target(id: string, target: string) {
    return this.edit({ actionId: id, targetId: target });
  }
  async deselectForMemory(id: string) {
    if (this.mode !== 'remote') {
      this.local.toggle(id, false);
      return true;
    }
    const task = this.current;
    if (!task || !task.state.proposal?.actions.some(action => action.id === id)) return false;
    let saved = false;
    await this.edit({ ids: [id], selected: false }, () => {
      saved = true;
    });
    return (
      saved &&
      this.connected &&
      this.current?.id === task.id &&
      !this.current.state.busy &&
      !this.current.state.invalid &&
      !this.current.state.selected.includes(id) &&
      (this.current.revision > task.revision || !task.state.selected.includes(id))
    );
  }
  confirmFolders() {
    return this.command('confirmFolders');
  }
  resumeBatches() {
    return this.command('resume');
  }
  pauseBatches() {
    return this.command('pause');
  }
  returnToFolders() {
    return this.command('returnToFolders');
  }
  cancel() {
    if (this.mode === 'remote' && this.requestId) {
      this.message = '正在停止尚未发出的写入，请核对执行记录。';
      this.publish();
      return this.rpc({ version: 1, type: 'cancelMutation', requestId: this.requestId }).then(
        () => {},
        () => {
          this.message = '停止请求未获确认，请核对同一请求的执行记录。';
          this.publish();
        },
      );
    }
    if (this.mode === 'remote') return this.command('cancel');
    this.local.cancel();
  }
  scan() {
    this.context++;
    this.mode = 'local';
    this.current = undefined;
    this.result = undefined;
    this.requestId = undefined;
    this.message = undefined;
    this.local.scan();
  }
  choice(id: string, choice: DuplicateChoice) {
    this.local.choice(id, choice);
  }
  previewDuplicates() {
    return this.local.previewDuplicates();
  }
  async apply() {
    if (this.mode !== 'remote') return this.local.apply();
    return this.enqueue(async () => {
      const task = this.current;
      if (!task || this.requestId || task.submission) {
        await this.observe();
        return;
      }
      let live = true;
      this.lease = await this.open(() => {
        live = false;
      });
      const lease = this.lease;
      if (this.closed) {
        lease.close();
        this.lease = undefined;
        return;
      }
      lease.setActive?.(true);
      try {
        const raw = await this.rpc({
          version: 1,
          type: 'registerOrganizeTaskPreview',
          organizerContext: lease.token,
          checkpointId: task.id,
          checkpointRevision: task.revision,
        });
        const preview = z.strictObject({ status: z.literal('preview'), proposal: confirmSchema }).parse(raw).proposal;
        if (
          this.closed ||
          !live ||
          !preview.previewId ||
          preview.organizerContext !== lease.token ||
          preview.organizerBinding?.checkpointId !== task.id ||
          preview.organizerBinding.checkpointRevision !== task.revision
        )
          throw Error('organize-task-unavailable');
        this.requestId = preview.requestId;
        this.result = await submitMutation(preview, request => this.rpc(request));
        this.message = this.result.needsReconcile
          ? '执行结果需要核对，请读取同一请求的执行记录；不会重放。'
          : this.result.status === 'completed'
            ? '整理已完成，可从恢复记录核对或撤销。'
            : '执行已停止，请核对执行记录后再处理。';
        this.publish();
        const reply = await this.taskRpc({ version: 1, type: 'organizeTask', action: 'get', id: task.id });
        if ('task' in reply) this.accept(reply.task);
        void this.refreshTasks();
      } finally {
        lease.close();
        this.lease = undefined;
      }
    });
  }
  async observe(reconcile = false) {
    const id = this.requestId ?? this.current?.submission?.requestId;
    if (!id) return;
    try {
      const result = mutationResultSchema.parse(
        await this.rpc({ version: 1, type: reconcile ? 'reconcileMutation' : 'mutationStatus', requestId: id }),
      );
      if (this.closed || result.requestId !== id) return;
      this.result =
        result.reason === 'request-not-found' ? { ...result, status: 'unknown', needsReconcile: true } : result;
      this.message = this.result.needsReconcile
        ? '此请求的执行结果尚未确定，请查看恢复记录核对；不会自动重发。'
        : this.result.status === 'completed'
          ? '整理已完成，可从恢复记录核对或撤销。'
          : '执行已停止，请查看恢复记录。';
    } catch {
      this.message = '无法读取执行结果，请稍后核对同一请求编号；不会重放书签写入。';
    }
    this.publish();
  }
  dispose() {
    this.closed = true;
    this.context++;
    clearTimeout(this.retry);
    for (const stop of this.pending) stop();
    this.port?.disconnect();
    this.lease?.close();
    this.local.dispose();
  }
}
