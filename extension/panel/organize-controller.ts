import type { ModelAuthority } from '../adapters/model-authority';
import { MODEL_BYTE_LIMITS } from '../adapters/model-byte-limits';
import { createDebugLog, type DebugDetail } from '../domain/debug-log';
import { cancellable } from '../domain/cancellable';
import { modelRequestBody, type ModelTransport } from '../adapters/model-transport';
import { OrganizeBatchExecutor } from './organize-batch-executor';
import { serializeAiPayload, serializedItemRequestSize } from '../domain/ai-payload';
import { parseModelOutput } from '../schemas/model-output';
import {
  exportOrganizeGeneration,
  restoreOrganizeGeneration,
  organizeBookmarkActions,
} from '../domain/organize-generation-checkpoint';
import {
  approvedOrganizeFolders,
  partitionOrganizeItems,
  ORGANIZE_REQUEST_BYTES,
  ORGANIZE_BATCH_SIZE,
  type OrganizeRequest,
} from '../domain/organize-batches';
import { modelOutputTokenLimit, modelStreaming } from '../domain/model-route';
import { organizeProgressPreview } from '../domain/organize-progress';
import { organizePreference, type OrganizePreference } from '../domain/organize-preferences';
import { defaultOrganizeScope, organizeRejectionKey } from '../domain/organize-review';
import { DEFAULT_CLASSIFICATION_POLICY } from '../domain/classification-policy';
import { dependencyDigest, settingsIdentity } from '../domain/context-dependencies';
import type { TreeSnapshot, TreeState } from '../domain/node-reference';
import {
  organizeCandidates,
  organizeProposal,
  organizeRequest,
  organizeCompilation,
  organizeCleanup,
  scopeNodes,
  type OrganizeProposal,
  organizePrivacy,
  actionDependencies,
  reconcileOrganizeSelection,
} from '../domain/organize-proposal';
import { duplicateProposal, exactDuplicates, type DuplicateChoice } from '../domain/exact-duplicates';
import { submitMutation, sendMutation, type SendMutation } from './mutation-client';
import { openOrganizerLease, type OpenOrganizerLease, type OrganizerLease } from './organizer-client';
import type { OrganizeState, GenerationOptions, StagedRun } from '../domain/organize-state';
export type { OrganizeState } from '../domain/organize-state';
/** The organize scope is the selected root and every descendant; changes elsewhere in the tree are not this task's concern. */
const scopeDependencies = (tree: TreeSnapshot, rootId: string) =>
  dependencyDigest(tree, { task: 'organize', rootId, itemIds: [], folderIds: [] });
const PREPARE_TIMEOUT_MS = 10_000;
const MODEL_WAIT_MS = 180_000;
type OrganizeModel = Pick<ModelTransport, 'run' | 'cancel' | 'dispose'> & {
  fork?: () => Pick<ModelTransport, 'run' | 'cancel' | 'dispose'>;
};
const failureMessages: Record<string, string> = {
  'organize-credential-required': '本次整理使用的临时密钥已失效。请重新输入密钥后继续；已完成建议保留。',
  'checkpoint-unavailable': '无法保存整理进度，已停止生成。请检查本机存储后重试；未修改书签。',
  'folder-context-too-large': '分类目录连同提示词超过 1 MiB 请求上限，请选择一个子目录后重新整理。',
  'bookmark-context-too-large':
    '单条书签连同分类目录和提示词超过 1 MiB 请求上限。请缩小整理范围，或检查过长的标题和网址后重试。',
  'invalid-organize-stage': '模型未按当前整理阶段返回建议，请重试本阶段。',
  'invalid-organize-plan': '确认后的分类结构无法使用，请返回调整文件夹方案。',
  'output-limit':
    '模型达到输出额度上限，未能生成完整方案；思考内容也会占用额度。请在 AI 服务中调整所选模型的最大输出 tokens 后重试；也可缩小整理范围。延长等待时间无法解决此问题。',
  'provider-error':
    '模型服务返回了失败或相互矛盾的完成状态，方案无法使用。请稍后重试；反复出现时，在 AI 服务中测试连接或更换模型。',
  'http-error': '模型服务返回异常，未能完成本次生成。请稍后重试；反复出现时检查 AI 服务连接。',
  'connection-or-configuration': '未能连接模型服务或接收回复。请检查网络及 AI 服务中的地址、模型配置，测试连接后重试。',
  'network-error': '接收模型回复时网络连接中断，本次回复未完整接收。请检查网络或模型服务后重试；已完成的批次会保留。',
  'stale-context': '整理期间书签或模型配置发生变化，本次回复已失效。请重新生成方案。',
  redirect: '模型服务地址发生重定向，连接已停止。请在 AI 服务中核对并填写实际接口地址后重试。',
  cancelled: '本次生成已停止。请重新生成方案。',
  empty: '模型已结束回复，但没有返回整理建议。请重新生成；反复出现时更换模型。',
  refused: '模型服务拒绝了本次整理请求。请调整分类要求或整理范围后重试。',
  'payload-too-large': '本次整理内容超过请求大小上限。请缩小整理范围，按子目录分批整理。',
  'overlapping-merge': '模型同时建议合并分类和单独移动其中的内容，操作存在冲突，方案已拒绝。请重新生成或缩小整理范围。',
  'privacy-excluded-descendant': '模型建议会影响已排除的子目录内容，方案已拒绝。请缩小整理范围后重试。',
  'protected-source': '模型建议修改不可移动或删除的根分类，方案已拒绝。请重新生成或选择子目录。',
  'invalid-output': '模型返回的分类或操作不符合整理规则，方案校验未通过。请重新生成或缩小整理范围。',
  'response-too-large': '模型返回的数据超过处理限额。请缩小整理目录后重试。',
  timeout: '模型等待超时，请重试或缩小整理目录。',
  'prepare-timeout': '连接书签或读取设置超时，请重新连接后重试。',
  permission: '模型服务尚未授权，请在 AI 服务中检查权限。',
  schema: '模型没有返回有效整理方案，请重试或更换模型。',
  'model-unconfigured': '尚未配置整理模型，请先在 AI 服务中配置连接。',
  'http-401': '模型服务密钥无效，请检查 AI 服务配置。',
  'http-403': '模型服务拒绝了访问，请检查服务权限。',
  'http-429': '模型服务请求过多或额度不足，请稍后重试。',
  incomplete: '模型回复未完成，请重试或缩小整理目录。',
  'tree-unavailable': '书签服务暂时未连接，请等待连接恢复后重试。',
  unavailable: '整理服务不可用，请检查模型配置和书签连接。',
  'authority-unavailable': '整理服务连接超时，请重新连接后重试。',
  'authority-disconnected': '整理连接已中断，请重新生成方案。',
  stale: '整理范围或配置已变化，请重新生成方案。',
  'missing-organize-instructions': '请填写自定义分类要求。',
  'invalid-organize-preference': '分类要求无效或过长，请调整后重试。',
  'privacy-excluded': '此整理范围已被保护或排除，请更换目录或取消该范围的保护后重试。',
  'protected-folder': '建议会改动受保护分类或其路径，请调整范围后重新生成。',
  'unsafe-folder-removal': '模型建议删除仍有内容或不可修改的分类，方案已拒绝，请重新生成。',
};
const failureMessage = (reason: string) => {
  return Object.hasOwn(failureMessages, reason)
    ? failureMessages[reason]
    : '整理过程发生未识别错误，未能生成可执行方案。请重新生成；若仍失败，请在设置中查看调试日志，并反馈本页的错误阶段与代码。';
};
export class OrganizeController {
  private state: OrganizeState = {
    tree: { status: 'loading' },
    scopeId: '',
    selected: [],
    targets: {},
    duplicates: [],
    choices: {},
    invalid: false,
    busy: false,
    message: '请选择整理范围；扫描与提案都不会自动写入。',
  };
  private generation = 0;
  private scopeInitialized = false;
  private lease?: OrganizerLease;
  private stop?: () => void;
  private applying = false;
  private pendingRequestId?: string;
  private scanTree?: Extract<TreeState, { status: 'ready' }>['snapshot'];
  /** Scope digest recorded when the retained baseline (scan or proposal) was taken. */
  private scopeDigest?: string;
  private operation?: { generation: number; controller: AbortController; timer: ReturnType<typeof setTimeout> };
  private reviewing = false;
  private staged?: StagedRun;
  private runId?: string;
  private runStartedAt = 0;
  private debug = createDebugLog('organizer');
  private record(event: string, detail?: DebugDetail) {
    this.debug(event, {
      runId: this.runId,
      elapsedMs: this.runStartedAt ? Date.now() - this.runStartedAt : undefined,
      generation: this.generation,
      stage: this.state.pipeline?.stage,
      busy: this.state.busy,
      ...detail,
    });
  }
  constructor(
    private emit: (state: OrganizeState) => void,
    private authority?: ModelAuthority,
    private model?: OrganizeModel,
    private open: OpenOrganizerLease = openOrganizerLease,
    private send: SendMutation = sendMutation,
    private runtime: { generationOnly?: boolean; persist?: () => Promise<void> } = {},
  ) {
    // Tree changes arrive through setTree and are judged against the retained scope; settings/permissions revoke outright.
    this.stop = authority?.subscribe(change => {
      if (change !== 'tree')
        this.invalidate(undefined, change === 'permissions' ? 'permissions-changed' : 'settings-changed');
    });
  }
  private publish() {
    this.emit({
      ...this.state,
      selected: [...this.state.selected],
      targets: { ...this.state.targets },
      choices: { ...this.state.choices },
    });
  }
  private clearReview() {
    this.reviewing = false;
  }
  private stopAnalysisClock() {
    const pipeline = this.state.pipeline;
    if (pipeline?.activeSince === undefined) return;
    this.state.pipeline = {
      ...pipeline,
      elapsedMs: (pipeline.elapsedMs ?? 0) + Math.max(0, Date.now() - pipeline.activeSince),
      activeSince: undefined,
    };
  }
  private invalidate(message?: string, cause = 'context-changed') {
    this.stopAnalysisClock();
    this.record('invalidated', { cause, receivedChars: this.state.progress?.receivedChars });
    this.staged = undefined;
    if (this.state.pipeline) this.state.pipeline = { ...this.state.pipeline, status: 'invalid' };
    this.state.failure = undefined;
    this.clearReview();
    this.state.progress = undefined;
    this.generation++;
    if (this.operation) {
      clearTimeout(this.operation.timer);
      this.operation.controller.abort(Error('cancelled'));
      this.operation = undefined;
    }
    this.model?.cancel();
    this.lease?.close();
    this.lease = undefined;
    if (this.state.busy && !this.applying) {
      this.state.busy = false;
      this.state.message = '已停止本次生成；未修改书签，可以重新生成。';
    }
    if (this.state.proposal || this.scanTree) {
      this.state.invalid = true;
      this.state.message = '范围、书签、隐私或模型设置已变化；旧提案已失效，保留选择供核对，请重新生成。';
    }
    if (message) this.state.message = message;
    this.publish();
  }
  setTree(tree: TreeState) {
    this.state.tree = structuredClone(tree);
    if (tree.status === 'ready' && !this.scopeInitialized) {
      this.scopeInitialized = true;
      this.state.scopeId = defaultOrganizeScope(tree.snapshot);
    }
    // Only a change inside the retained scope invalidates; loading/error carry no scope evidence and wait for ready.
    if (
      tree.status === 'ready' &&
      !this.state.invalid &&
      (this.state.proposal || this.scanTree) &&
      this.scopeDigest !== undefined &&
      scopeDependencies(tree.snapshot, this.state.scopeId) !== this.scopeDigest
    )
      this.invalidate(undefined, 'scope-tree-changed');
    this.publish();
  }
  selectScope(id: string) {
    if (this.state.busy) return;
    this.scopeInitialized = true;
    if (id === this.state.scopeId) return;
    this.invalidate(undefined, 'scope-selected');
    this.state.scopeId = id;
    this.publish();
  }
  toggle(id: string, selected: boolean) {
    this.toggleMany([id], selected);
  }
  toggleMany(ids: string[], selected: boolean) {
    if (this.state.busy || this.state.invalid || !this.state.proposal) return;
    const proposal = this.state.proposal;
    const locked = new Set(this.state.pipeline?.lockedActionIds);
    const actions = new Map(proposal.actions.map(action => [action.id, action]));
    const changed = new Set(ids.filter(id => actions.has(id) && !locked.has(id)));
    if (!changed.size) return;
    const chosen = new Set(this.state.selected.filter(id => !changed.has(id)));
    const add = (value: string) => {
      if (chosen.has(value)) return;
      const action = actions.get(value);
      if (!action) return;
      chosen.add(value);
      actionDependencies(proposal, action, this.state.targets).forEach(add);
    };
    if (selected) changed.forEach(add);
    this.state.selected = reconcileOrganizeSelection(proposal, [...chosen], this.state.targets);
    this.publish();
  }
  target(id: string, target: string) {
    if (this.state.busy || this.state.invalid || !this.state.proposal) return;
    if (this.state.pipeline?.lockedActionIds.includes(id)) return;
    this.state.targets = { ...this.state.targets, [id]: target };
    this.state.selected = reconcileOrganizeSelection(this.state.proposal, this.state.selected, this.state.targets);
    this.publish();
  }
  choice(id: string, choice: DuplicateChoice) {
    if (this.state.busy || this.state.invalid) return;
    this.clearReview();
    this.lease?.close();
    this.lease = undefined;
    this.state.proposal = undefined;
    this.state.selected = [];
    this.state.targets = {};
    this.state.choices = { ...this.state.choices, [id]: choice };
    this.state.message = '去重选择已修改；请重新预览后确认。';
    this.publish();
  }
  cancel() {
    this.record('cancel-requested', { cause: 'user-or-preference' });
    if (!this.applying && this.staged?.approved && this.state.busy) {
      this.pauseBatches();
      return;
    }
    if (this.applying) {
      if (this.pendingRequestId && typeof chrome !== 'undefined')
        chrome.runtime.sendMessage({ version: 1, type: 'cancelMutation', requestId: this.pendingRequestId }, () => {
          if (chrome.runtime.lastError) {
            this.state.message = '停止请求未获确认；请核对恢复记录，不重放。';
            this.publish();
          }
        });
      return;
    }
    this.invalidate();
    this.publish();
  }
  scan() {
    if (this.state.busy || this.state.tree.status !== 'ready') return;
    this.invalidate();
    this.state.pipeline = undefined;
    try {
      this.scanTree = structuredClone(this.state.tree.snapshot);
      this.state.duplicates = exactDuplicates(this.scanTree, this.state.scopeId);
      this.scopeDigest = scopeDependencies(this.scanTree, this.state.scopeId);
      this.state.choices = {};
      this.state.proposal = undefined;
      this.state.result = undefined;
      this.state.invalid = false;
      this.state.message = '本地扫描完成；每组需明确选择保留和删除，不默认删除。';
    } catch {
      this.scanTree = undefined;
      this.state.message = '范围不可用，请重新选择。';
    }
    this.publish();
  }
  private async begin() {
    this.state.failure = undefined;
    this.clearReview();
    this.state.progress = undefined;
    this.lease?.close();
    this.lease = undefined;
    this.runId = crypto.randomUUID();
    this.runStartedAt = Date.now();
    this.state.busy = true;
    this.state.result = undefined;
    const generation = ++this.generation;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Error('prepare-timeout')), PREPARE_TIMEOUT_MS);
    this.operation = { generation, controller, timer };
    this.record('begin');
    this.state.message = '正在连接整理服务并读取当前书签…';
    this.publish();
    if (this.runtime.generationOnly) return generation;
    const pending = this.open(() => {
      if (generation === this.generation)
        this.invalidate('整理连接已中断，当前方案已失效；请重新生成。未自动执行书签操作。', 'lease-disconnected');
    }, this.runId);
    void pending.then(
      lease => {
        if (controller.signal.aborted || generation !== this.generation) lease.close();
      },
      () => {},
    );
    const lease = await cancellable(pending, controller.signal);
    if (generation !== this.generation) {
      lease.close();
      throw Error('stale');
    }
    this.lease = lease;
    return generation;
  }
  private accept(proposal: OrganizeProposal, rejected: string[] = []) {
    this.state.proposal = proposal;
    this.state.targets = {};
    this.state.selected = reconcileOrganizeSelection(
      proposal,
      proposal.actions.filter(a => !rejected.includes(organizeRejectionKey(proposal, a, {}))).map(a => a.id),
      {},
    );
    this.state.invalid = false;
    this.state.message = proposal.actions.length
      ? `方案已生成，共 ${proposal.actions.length} 项建议；请核对后点击“下一步：确认操作”。`
      : '分析已完成，没有需要应用的操作。';
    if (proposal.actions.length || this.state.pipeline?.stage === 'folders') {
      this.retainReview();
    } else {
      this.lease?.close();
      this.lease = undefined;
    }
  }
  async generate(
    preference: OrganizePreference = { style: 'topic', instructions: '' },
    options: GenerationOptions = {},
  ) {
    if (this.state.busy) return;
    let generation = this.generation;
    const startedAt = Date.now();
    let phase: NonNullable<OrganizeState['failure']>['phase'] = '准备整理';
    this.state.failure = undefined;
    this.staged = undefined;
    this.state.pipeline = undefined;
    try {
      const selectedPreference = organizePreference(preference);
      options = structuredClone(options);
      if (options.unfiledOnly) options = { ...options, staged: true, cleanupEmpty: false, allowRename: false };
      if (!this.authority || !this.model || this.state.tree.status !== 'ready') throw Error('unavailable');
      this.state.proposal = undefined;
      this.state.selected = [];
      this.state.duplicates = [];
      const pending = this.begin();
      generation = this.generation;
      await pending;
      const operation = this.operation!;
      const context = await cancellable(this.authority.read(), operation.controller.signal);
      const rootId = this.state.scopeId;
      if (!context.config) throw Error('model-unconfigured');
      const outputTokenLimit = modelOutputTokenLimit(context.config);
      if (
        generation !== this.generation ||
        this.state.tree.status !== 'ready' ||
        context.tree.installationId !== this.state.tree.snapshot.installationId ||
        scopeDependencies(context.tree, rootId) !== scopeDependencies(this.state.tree.snapshot, rootId)
      )
        throw Error('stale');
      const candidates = organizeCandidates(
        context.tree,
        rootId,
        organizePrivacy(context.tree, context.privacy, options.protectedFolderIds),
      );
      clearTimeout(operation.timer);
      const directBookmarks = new Set(
        context.tree.nodes
          .filter(node => node.ref.kind === 'bookmark' && node.parentId === rootId && !node.readOnly)
          .map(node => node.ref.nativeId),
      );
      const itemIds = candidates.items
        .map(item => item.id)
        .filter(id => !options.unfiledOnly || directBookmarks.has(id));
      const candidateIds = new Set(itemIds);
      const bookmarkCount = context.tree.nodes.filter(
        node => node.ref.kind === 'bookmark' && candidateIds.has(node.ref.nativeId),
      ).length;
      const request: OrganizeRequest = {
        task: 'organize',
        preference: selectedPreference,
        rootId,
        itemIds,
        folderIds: candidates.folders.map(f => f.id),
      };
      if (options.staged) {
        const bookmarks = new Set(context.tree.nodes.filter(n => n.ref.kind === 'bookmark').map(n => n.ref.nativeId));
        this.staged = {
          requiresCredential: !!context.key,
          context: { ...context, config: context.config },
          preference: selectedPreference,
          options,
          request,
          bookmarkIds: request.itemIds.filter(id => bookmarks.has(id)),
          queue: [],
        };
        request.stage = 'folders';
        request.itemIds = request.itemIds.filter(id => !bookmarks.has(id));
        request.sampleLimit = 2;
        while (this.requestSize(this.staged, request) > ORGANIZE_REQUEST_BYTES && request.sampleLimit > 0)
          request.sampleLimit--;
        if (this.requestSize(this.staged, request) > MODEL_BYTE_LIMITS.requestBytes)
          throw Error('folder-context-too-large');
        this.state.pipeline = {
          stage: 'folders',
          status: 'running',
          total: bookmarkCount,
          batchSize: options.batchSize ?? ORGANIZE_BATCH_SIZE,
          folderCount: request.folderIds.length,
          completed: 0,
          elapsedMs: 0,
          activeSince: Date.now(),
          batchCount: 0,
          finished: [],
          lockedActionIds: [],
        };
        if (this.runtime.persist) await this.persistGeneration();
        if (generation !== this.generation || operation.controller.signal.aborted) throw Error('cancelled');
      }
      // A per-run budget, not a completion estimate or a change to saved model settings.
      const timeoutMs = Math.max(context.config.timeoutMs, MODEL_WAIT_MS);
      // Preparation timer is cleared above. Only transport owns model waiting;
      // a second total timer here would still abort a healthy continuing SSE stream.
      this.state.progress = {
        phase: 'waiting',
        streaming: modelStreaming(context.config),
        receivedChars: 0,
        preview: [],
        timeoutSeconds: Math.ceil(timeoutMs / 1000),
        bookmarkCount,
        outputTokenLimit,
      };
      this.state.message = `AI 正在分析 ${candidates.items.length} 项内容，生成整理方案…`;
      phase = '模型生成';
      this.publish();
      const result = options.unfiledOnly
        ? { status: 'completed' as const, output: { moves: [], newFolders: [], merges: [] } }
        : await cancellable(
            this.model.run({
              diagnosticRunId: this.runId,
              ...context,
              config: context.config,
              signal: operation.controller.signal,
              timeoutMs,
              policy: { ...DEFAULT_CLASSIFICATION_POLICY, allowRename: options.allowRename ?? true },
              onProgress: progress => {
                if (generation !== this.generation || operation.controller.signal.aborted) return;
                const preview =
                  progress.phase === 'validating'
                    ? (this.state.progress?.preview ?? [])
                    : organizeProgressPreview(
                        progress.text,
                        options.staged
                          ? JSON.parse(serializeAiPayload(context.tree, context.privacy, request))
                          : candidates,
                      );
                this.state.progress = {
                  phase: progress.phase,
                  streaming: progress.streaming,
                  receivedChars: progress.receivedChars,
                  preview,
                  timeoutSeconds: Math.ceil(timeoutMs / 1000),
                  bookmarkCount,
                  outputTokenLimit,
                };
                this.state.message = progress.retry
                  ? `服务繁忙，${progress.retry.delaySeconds} 秒后重试（${progress.retry.attempt}/3），可随时取消。`
                  : progress.phase === 'validating'
                    ? '正在校验返回的整理内容…'
                    : progress.receivedChars > 0
                      ? '正在接收 AI 整理建议…'
                      : progress.phase === 'receiving'
                        ? '模型服务已响应，正在生成整理建议…'
                        : '正在等待 AI 返回整理建议…';
                this.publish();
              },
              request,
            }),
            operation.controller.signal,
          );
      if (generation !== this.generation) throw Error('stale');
      if (result.status !== 'completed') throw Error(result.detail ?? result.reason ?? 'model-failed');
      phase = '方案校验';
      if (options.staged) {
        const output = parseModelOutput(result.output, {
          ...JSON.parse(serializeAiPayload(context.tree, context.privacy, request)),
          rootId,
        });
        if (!('moves' in output)) throw Error('invalid-organize-stage');
        this.staged!.folderOutput = output;
      }
      this.scanTree = undefined;
      this.state.duplicates = [];
      this.scopeDigest = scopeDependencies(context.tree, rootId);
      this.accept(
        organizeProposal(
          context.tree,
          rootId,
          result.output,
          context.privacy,
          options.staged ? { ...options, cleanupEmpty: options.cleanupEmpty === false ? false : undefined } : options,
        ),
        options.rejectedSignatures,
      );
      if (this.state.pipeline) {
        this.state.pipeline = { ...this.state.pipeline, status: 'review' };
        this.state.message = options.unfiledOnly
          ? `只整理当前目录直接收藏的 ${bookmarkCount} 条书签，沿用现有分类；确认后开始分析，子目录内容保持原位。`
          : '文件夹方案已生成。先核对分类树与目录变更，再确认分类并开始分批整理书签；此时不会写入。';
        await this.persistGeneration();
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.lease?.close();
      this.lease = undefined;
      this.state.invalid = true;
      if (this.state.pipeline) this.state.pipeline = { ...this.state.pipeline, status: 'failed' };
      const reason = error instanceof Error ? error.message : '';
      this.state.failure = {
        code: Object.hasOwn(failureMessages, reason) ? reason : 'unknown-error',
        phase,
        elapsedSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
        bookmarkCount: this.state.progress?.bookmarkCount,
        outputTokenLimit: this.state.progress?.outputTokenLimit,
      };
      const timeout =
        reason === 'timeout' && this.state.progress
          ? `等待连接、后续流数据或完整非流式响应超过 ${this.state.progress.timeoutSeconds} 秒，请重试。`
          : failureMessage(reason);
      this.state.message = `${timeout} 未修改书签。`;
    } finally {
      this.finish(generation);
    }
  }
  private retainReview() {
    // Review belongs to the live workbench session, not a wall-clock deadline.
    // Scope/settings changes and actual lease loss still revoke the proposal.
    this.reviewing = true;
    this.lease?.setActive?.(true);
  }
  private async persistGeneration() {
    try {
      await this.runtime.persist?.();
    } catch {
      throw Error('checkpoint-unavailable');
    }
  }
  private requestSize(run: StagedRun, request: OrganizeRequest) {
    return new TextEncoder().encode(
      modelRequestBody(
        run.context.config,
        'organize',
        serializeAiPayload(run.context.tree, run.context.privacy, request),
        { ...DEFAULT_CLASSIFICATION_POLICY, allowRename: run.options.allowRename ?? true },
      ),
    ).byteLength;
  }
  /** Confirm taxonomy only; native writes still require the final apply step. */
  async confirmFolders() {
    if (
      this.state.busy ||
      this.state.invalid ||
      !this.staged ||
      !this.state.proposal ||
      this.state.pipeline?.stage !== 'folders'
    )
      return;
    const run = this.staged;
    try {
      run.folderReview = {
        proposal: this.state.proposal,
        selected: [...this.state.selected],
        targets: { ...this.state.targets },
      };
      run.approved = approvedOrganizeFolders(this.state.proposal, this.state.selected, this.state.targets);
      run.request = {
        ...run.request,
        stage: 'bookmarks',
        omittedItemsUnchanged: true,
        destinations: run.approved.destinations,
        placements: Object.fromEntries(run.bookmarkIds.map(id => [id, run.approved!.placements.get(id)!])),
        sampleLimit: undefined,
      };
      run.queue = partitionOrganizeItems(
        run.bookmarkIds,
        serializedItemRequestSize(
          serializeAiPayload(run.context.tree, run.context.privacy, { ...run.request, itemIds: run.bookmarkIds }),
          this.requestSize(run, { ...run.request, itemIds: [] }),
        ),
        run.options.batchSize,
        MODEL_BYTE_LIMITS.requestBytes,
      );
      run.acceptedBatches = new Map();
      run.batchIds = new Map(run.queue.map(ids => [ids, crypto.randomUUID()]));
      run.finishedBatches = [];
      run.concurrency = this.model?.fork ? 2 : 1;
      this.state.proposal = run.approved.proposal;
      this.state.targets = {};
      this.state.selected = run.approved.proposal.actions.map(a => a.id);
      this.state.pipeline = {
        ...this.state.pipeline,
        stage: 'bookmarks',
        status: 'paused',
        elapsedMs: 0,
        activeSince: undefined,
        batchCount: run.queue.length,
        lockedActionIds: [...this.state.selected],
      };
      if (this.runtime.persist) await this.persistGeneration();
      await this.resumeBatches();
    } catch (error) {
      if (error instanceof Error && error.message === 'checkpoint-unavailable') this.state.invalid = true;
      this.state.failure = {
        code:
          error instanceof Error && Object.hasOwn(failureMessages, error.message)
            ? error.message
            : 'invalid-organize-plan',
        phase: '书签请求准备',
        elapsedSeconds: 0,
        bookmarkCount: run.bookmarkIds.length,
      };
      this.state.message = `${failureMessage(this.state.failure.code)} 未修改书签。`;
      this.publish();
    }
  }
  pauseBatches() {
    if (!this.staged?.approved || !this.state.pipeline || !this.state.busy || this.applying) return;
    this.record('paused');
    this.stopAnalysisClock();
    this.generation++;
    if (this.operation) {
      clearTimeout(this.operation.timer);
      this.operation.controller.abort(Error('cancelled'));
      this.operation = undefined;
    }
    this.model?.cancel();
    this.state.busy = false;
    this.state.progress = undefined;
    this.state.failure = undefined;
    this.state.pipeline = { ...this.state.pipeline, status: 'paused' };
    this.state.message = '已暂停。已完成批次保留，继续时只处理尚未完成的书签。未修改书签。';
    this.retainReview();
    this.publish();
  }
  returnToFolders() {
    if (
      this.state.busy ||
      this.state.invalid ||
      !this.staged?.folderReview ||
      !this.state.pipeline ||
      this.state.result
    )
      return;
    const review = this.staged.folderReview;
    this.staged.approved = undefined;
    this.staged.queue = [];
    this.staged.acceptedBatches?.clear();
    this.staged.finishedBatches = [];
    this.staged.batchIds?.clear();
    this.state.proposal = review.proposal;
    this.state.selected = [...review.selected];
    this.state.targets = { ...review.targets };
    this.state.failure = undefined;
    this.state.pipeline = {
      ...this.state.pipeline,
      stage: 'folders',
      status: 'review',
      finished: [],
      completed: 0,
      analyzed: 0,
      elapsedMs: 0,
      activeSince: undefined,
      batchCount: 0,
      lockedActionIds: [],
    };
    this.state.message = '已返回文件夹方案；后续书签建议已清除，确认新的分类后会重新分批分析。未修改书签。';
    this.retainReview();
    this.publish();
  }
  async resumeBatches() {
    const run = this.staged;
    if (
      this.state.busy ||
      this.state.invalid ||
      !run?.approved ||
      !this.authority ||
      !this.model ||
      this.state.pipeline?.stage !== 'bookmarks'
    )
      return;
    let generation = this.generation;
    const startedAt = Date.now();
    let phase: NonNullable<OrganizeState['failure']>['phase'] = '准备整理';
    let executor: OrganizeBatchExecutor | undefined;
    try {
      const pending = this.begin();
      generation = this.generation;
      await pending;
      const operation = this.operation!;
      const checkContext = async () => {
        const current = await cancellable(this.authority!.read(), operation.controller.signal);
        if (run.requiresCredential && !current.key) throw Error('organize-credential-required');
        if (
          scopeDependencies(current.tree, run.request.rootId) !== this.scopeDigest ||
          current.tree.installationId !== run.context.tree.installationId ||
          settingsIdentity(current) !== settingsIdentity(run.context) ||
          current.key !== run.context.key
        )
          throw Error('stale-context');
      };
      await checkContext();
      if (generation !== this.generation) return;
      run.acceptedBatches ??= new Map();
      run.concurrency ??= this.model.fork ? 2 : 1;
      this.state.pipeline = {
        ...this.state.pipeline!,
        status: 'running',
        concurrency: run.concurrency,
        activeSince: Date.now(),
      };
      executor = new OrganizeBatchExecutor(
        run.acceptedBatches,
        async (ids, signal) => {
          const request: OrganizeRequest = { ...run.request, itemIds: ids };
          if (this.requestSize(run, request) > MODEL_BYTE_LIMITS.requestBytes)
            throw Error('bookmark-context-too-large');
          const timeoutMs = Math.max(run.context.config.timeoutMs, MODEL_WAIT_MS);
          const model = this.model!.fork?.() ?? this.model!;
          try {
            const result = await cancellable(
              model.run({
                diagnosticRunId: this.runId,
                ...run.context,
                request,
                signal,
                timeoutMs,
                policy: { ...DEFAULT_CLASSIFICATION_POLICY, allowRename: run.options.allowRename ?? true },
                onProgress: update => {
                  if (generation !== this.generation || operation.controller.signal.aborted) return;
                  this.state.progress = {
                    phase: update.phase,
                    streaming: update.streaming,
                    receivedChars: update.receivedChars,
                    preview: [],
                    timeoutSeconds: Math.ceil(timeoutMs / 1000),
                    bookmarkCount: ids.length,
                    outputTokenLimit: modelOutputTokenLimit(run.context.config),
                  };
                  if (update.retry) {
                    if (update.retry.httpStatus === 429) {
                      run.concurrency = 1;
                      executor?.reduceConcurrency();
                      this.state.pipeline = { ...this.state.pipeline!, concurrency: 1 };
                    }
                    this.state.message = `服务繁忙，${update.retry.delaySeconds} 秒后重试（${update.retry.attempt}/3），可随时暂停。`;
                  }
                  this.publish();
                },
              }),
              signal,
            );
            if (result.status !== 'completed') return result;
            const output = parseModelOutput(result.output, {
              ...JSON.parse(serializeAiPayload(run.context.tree, run.context.privacy, request)),
              rootId: request.rootId,
            });
            return { status: 'completed', output };
          } finally {
            if (model !== this.model) model.dispose();
          }
        },
        run.concurrency,
        operation.controller.signal,
        () => {
          if (generation !== this.generation || operation.controller.signal.aborted) return;
          this.state.pipeline = {
            ...this.state.pipeline!,
            analyzed:
              this.state.pipeline!.completed +
              run.queue.filter(ids => run.acceptedBatches!.has(ids)).reduce((total, ids) => total + ids.length, 0),
          };
          this.publish();
        },
        this.runtime.persist ? () => this.persistGeneration() : undefined,
      );
      while (run.queue.length) {
        const ids = run.queue[0]!;
        const request: OrganizeRequest = { ...run.request, itemIds: ids };
        if (this.requestSize(run, request) > MODEL_BYTE_LIMITS.requestBytes) throw Error('bookmark-context-too-large');
        const timeoutMs = Math.max(run.context.config.timeoutMs, MODEL_WAIT_MS);
        clearTimeout(operation.timer);
        phase = '模型生成';
        const batchNumber = this.state.pipeline!.finished.length + 1;
        this.state.message = `正在生成第 ${batchNumber} / ${this.state.pipeline!.batchCount} 批建议（${ids.length} 条书签）…`;
        this.state.progress = {
          phase: 'waiting',
          streaming: modelStreaming(run.context.config),
          receivedChars: 0,
          preview: [],
          timeoutSeconds: Math.ceil(timeoutMs / 1000),
          bookmarkCount: ids.length,
          outputTokenLimit: modelOutputTokenLimit(run.context.config),
        };
        this.publish();
        const result = await executor.next(run.queue);
        executor.consume(ids);
        if (generation !== this.generation || operation.controller.signal.aborted) return;
        if (result.status !== 'completed') {
          if (
            (result.detail === 'output-limit' ||
              result.reason === 'payload-too-large' ||
              result.reason === 'response-too-large') &&
            ids.length > 1
          ) {
            const half = Math.ceil(ids.length / 2);
            run.queue.splice(0, 1, ids.slice(0, half), ids.slice(half));
            this.state.pipeline = { ...this.state.pipeline!, batchCount: this.state.pipeline!.batchCount + 1 };
            this.state.message = '这一批内容过长，已自动拆成更小的批次；已完成的结果不受影响。';
            this.publish();
            continue;
          }
          throw Error(result.detail ?? result.reason);
        }
        phase = '方案校验';
        const output = parseModelOutput(result.output, {
          ...JSON.parse(serializeAiPayload(run.context.tree, run.context.privacy, request)),
          rootId: request.rootId,
        });
        if (!('moves' in output)) throw Error('invalid-organize-stage');
        const actions = organizeBookmarkActions(output, run, this.state.pipeline!.lockedActionIds);
        const proposal = { ...this.state.proposal!, actions: [...this.state.proposal!.actions, ...actions] };
        if (proposal.actions.length)
          organizeCompilation(
            proposal,
            proposal.actions.map(a => a.id),
            {},
            'batch-preview',
          );
        this.state.proposal = proposal;
        this.state.selected = reconcileOrganizeSelection(
          proposal,
          [
            ...this.state.selected,
            ...actions
              .filter(a => !run.options.rejectedSignatures?.includes(organizeRejectionKey(proposal, a, {})))
              .map(a => a.id),
          ],
          this.state.targets,
        );
        run.queue.shift();
        run.finishedBatches ??= [];
        run.finishedBatches.push({ ids, output });
        this.state.pipeline = {
          ...this.state.pipeline!,
          completed: this.state.pipeline!.completed + ids.length,
          finished: [...this.state.pipeline!.finished, { count: ids.length, actionIds: actions.map(a => a.id) }],
        };
        this.state.message = `第 ${batchNumber} 批已完成，可先查看下方分类预览和详细建议。`;
        this.publish();
      }
      const cleaned = organizeCleanup(this.state.proposal!, run.context.privacy, run.options);
      const oldActions = new Set(this.state.proposal!.actions.map(a => a.id));
      this.state.proposal = cleaned;
      this.state.selected = reconcileOrganizeSelection(
        cleaned,
        [
          ...this.state.selected,
          ...cleaned.actions
            .filter(
              a =>
                !oldActions.has(a.id) &&
                !run.options.rejectedSignatures?.includes(organizeRejectionKey(cleaned, a, {})),
            )
            .map(a => a.id),
        ],
        this.state.targets,
      );
      this.state.pipeline = { ...this.state.pipeline!, stage: 'complete', status: 'review' };
      this.state.message = `全部 ${this.state.pipeline.finished.length} 批已完成，已核对 ${this.state.pipeline.completed} 条书签。${cleaned.actions.length ? '请检查整体分类和所选建议后再确认执行。' : '没有需要应用的操作。'}`;
      await this.persistGeneration();
      this.retainReview();
    } catch (error) {
      if (generation !== this.generation) return;
      const reason = error instanceof Error ? error.message : '';
      if (reason === 'checkpoint-unavailable') this.state.invalid = true;
      if (reason === 'stale-context' || reason === 'stale') {
        this.invalidate('书签或配置已变化，之前的批次已失效；请重新生成文件夹方案。未修改书签。');
        return;
      }
      this.state.failure = {
        code: Object.hasOwn(failureMessages, reason) ? reason : 'unknown-error',
        phase,
        elapsedSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
        bookmarkCount: run.queue[0]?.length,
        outputTokenLimit: modelOutputTokenLimit(run.context.config),
      };
      this.state.pipeline = { ...this.state.pipeline!, status: 'failed' };
      this.state.message = `${failureMessage(reason)} 已保留 ${this.state.pipeline.finished.length} 批结果，可继续未完成批次。未修改书签。`;
      this.retainReview();
    } finally {
      executor?.stop();
      this.finish(generation);
    }
  }
  async previewDuplicates() {
    if (this.state.busy || this.state.invalid || !this.scanTree) return;
    let generation = this.generation;
    try {
      const tree = this.scanTree;
      const pending = this.begin();
      generation = this.generation;
      await pending;
      if (
        generation !== this.generation ||
        this.state.tree.status !== 'ready' ||
        scopeDependencies(this.state.tree.snapshot, this.state.scopeId) !== this.scopeDigest
      )
        throw Error('stale');
      this.accept(duplicateProposal(tree, this.state.scopeId, this.state.choices));
    } catch {
      if (generation !== this.generation) return;
      this.lease?.close();
      this.lease = undefined;
      this.state.proposal = undefined;
      this.state.selected = [];
      this.state.message = '去重预览不可用；每组必须明确保留至少一项，且范围与扫描必须仍有效。';
    } finally {
      this.finish(generation);
    }
  }
  private finish(generation: number) {
    if (generation !== this.generation) return;
    this.stopAnalysisClock();
    this.record('finished', { failureCode: this.state.failure?.code, invalid: this.state.invalid });
    if (this.operation?.generation === generation) {
      clearTimeout(this.operation.timer);
      this.operation = undefined;
    }
    this.state.busy = false;
    this.state.progress = undefined;
    this.lease?.setActive?.(this.reviewing);
    this.publish();
  }
  async checkpoint(id: string, revision: number) {
    if (!this.staged || !this.state.pipeline || this.state.invalid) return undefined;
    return exportOrganizeGeneration(this.state, this.staged, id, revision);
  }
  async restoreCheckpoint(checkpoint: unknown, options: { allowMissingCredential?: boolean } = {}) {
    if (!this.runtime.generationOnly || !this.authority || this.state.busy) throw Error('unavailable');
    this.invalidate(undefined, 'restore-checkpoint');
    const generation = await this.begin();
    const operation = this.operation!;
    try {
      const context = await cancellable(this.authority.read(), operation.controller.signal);
      const restored = await cancellable(
        restoreOrganizeGeneration(checkpoint, context, options),
        operation.controller.signal,
      );
      const latest = await cancellable(this.authority.read(), operation.controller.signal);
      if (
        latest.tree.installationId !== context.tree.installationId ||
        scopeDependencies(latest.tree, restored.state.scopeId) !==
          scopeDependencies(context.tree, restored.state.scopeId) ||
        settingsIdentity(latest) !== settingsIdentity(context) ||
        latest.revision !== context.revision ||
        latest.key !== context.key
      )
        throw Error('stale-context');
      if (generation !== this.generation || operation.controller.signal.aborted) throw Error('stale-context');
      this.state = restored.state;
      this.staged = restored.run;
      this.scopeInitialized = true;
      this.scopeDigest = scopeDependencies(context.tree, this.state.scopeId);
      this.retainReview();
    } catch (error) {
      this.state.invalid = true;
      throw error;
    } finally {
      this.finish(generation);
    }
  }
  async apply() {
    if (this.runtime.generationOnly) return;
    if (this.state.pipeline && this.state.pipeline.stage !== 'complete') return;
    if (this.state.busy || this.state.invalid || !this.state.proposal || !this.lease || this.state.result) return;
    let request;
    try {
      request = organizeRequest(this.state.proposal, this.state.selected, this.state.targets, this.lease.token);
    } catch {
      this.state.message = '选择或目标无效，依赖目录必须同时勾选；请调整或重新生成。';
      this.publish();
      return;
    }
    this.pendingRequestId = request.requestId;
    this.clearReview();
    this.applying = true;
    this.lease.setActive?.(true);
    this.state.busy = true;
    this.state.message = '正在备份并执行所选整理操作…';
    this.publish();
    const result = await submitMutation(request, this.send);
    this.pendingRequestId = undefined;
    this.applying = false;
    this.state.result = result;
    this.state.invalid = true;
    this.lease?.close();
    this.lease = undefined;
    this.state.busy = false;
    this.state.message = `${result.status}：已完成 ${result.completedSteps} 步，未完成 ${result.remainingSteps} 步。${result.needsReconcile ? '结果未知，请在备份与恢复中核对；不自动重放。' : '可在备份与恢复中预览安全撤销。'}`;
    this.publish();
  }
  folders() {
    return this.state.tree.status === 'ready' ? this.state.tree.snapshot.nodes.filter(n => n.childrenWritable) : [];
  }
  scopeCount() {
    try {
      return this.state.tree.status === 'ready' ? scopeNodes(this.state.tree.snapshot, this.state.scopeId).length : 0;
    } catch {
      return 0;
    }
  }
  dispose() {
    this.invalidate(undefined, 'disposed');
    this.stop?.();
    this.model?.dispose();
  }
}
