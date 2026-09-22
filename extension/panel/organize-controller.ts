import type { ModelAuthority } from '../adapters/model-authority';
import type { ModelTransport } from '../adapters/model-transport';
import type { TreeState } from '../domain/node-reference';
import {
  organizeCandidates,
  organizeProposal,
  organizeRequest,
  scopeNodes,
  type OrganizeProposal,
} from '../domain/organize-proposal';
import { duplicateProposal, exactDuplicates, type DuplicateChoice } from '../domain/exact-duplicates';
import type { MutationResult } from '../schemas/messages';
import { submitMutation, sendMutation, type SendMutation } from './mutation-client';
import { openOrganizerLease, type OpenOrganizerLease, type OrganizerLease } from './organizer-client';
export interface OrganizeState {
  tree: TreeState;
  scopeId: string;
  proposal?: OrganizeProposal;
  selected: string[];
  targets: Record<string, string>;
  duplicates: ReturnType<typeof exactDuplicates>;
  choices: Record<string, DuplicateChoice>;
  invalid: boolean;
  busy: boolean;
  message: string;
  result?: MutationResult;
}
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
  private lease?: OrganizerLease;
  private stop?: () => void;
  private applying = false;
  private pendingRequestId?: string;
  private scanTree?: Extract<TreeState, { status: 'ready' }>['snapshot'];
  constructor(
    private emit: (state: OrganizeState) => void,
    private authority?: ModelAuthority,
    private model?: Pick<ModelTransport, 'run' | 'cancel' | 'dispose'>,
    private open: OpenOrganizerLease = openOrganizerLease,
    private send: SendMutation = sendMutation,
  ) {
    this.stop = authority?.subscribe(() => this.invalidate());
  }
  private publish() {
    this.emit({
      ...this.state,
      selected: [...this.state.selected],
      targets: { ...this.state.targets },
      choices: { ...this.state.choices },
    });
  }
  private invalidate() {
    this.generation++;
    this.model?.cancel();
    this.lease?.close();
    this.lease = undefined;
    if (this.state.proposal || this.scanTree) {
      this.state.invalid = true;
      this.state.message = '范围、书签、隐私或模型设置已变化；旧提案已失效，保留选择供核对，请重新生成。';
    }
    this.publish();
  }
  setTree(tree: TreeState) {
    if (JSON.stringify(tree) !== JSON.stringify(this.state.tree)) this.invalidate();
    this.state.tree = structuredClone(tree);
    this.publish();
  }
  selectScope(id: string) {
    if (this.state.busy || id === this.state.scopeId) return;
    this.invalidate();
    this.state.scopeId = id;
    this.publish();
  }
  toggle(id: string, selected: boolean) {
    if (this.state.busy) return;
    this.state.selected = this.state.selected.filter(v => v !== id);
    if (selected) this.state.selected = [...this.state.selected, id];
    this.publish();
  }
  target(id: string, target: string) {
    if (this.state.busy) return;
    this.state.targets = { ...this.state.targets, [id]: target };
    this.publish();
  }
  choice(id: string, choice: DuplicateChoice) {
    if (this.state.busy || this.state.invalid) return;
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
    try {
      this.scanTree = structuredClone(this.state.tree.snapshot);
      this.state.duplicates = exactDuplicates(this.scanTree, this.state.scopeId);
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
    this.lease?.close();
    this.lease = undefined;
    this.state.busy = true;
    this.state.result = undefined;
    const generation = ++this.generation;
    this.publish();
    const lease = await this.open(() => this.invalidate());
    if (generation !== this.generation) {
      lease.close();
      throw Error('stale');
    }
    this.lease = lease;
    return generation;
  }
  private accept(proposal: OrganizeProposal) {
    this.state.proposal = proposal;
    this.state.selected = proposal.actions.map(a => a.id);
    this.state.targets = {};
    this.state.invalid = false;
    this.state.message = proposal.actions.length
      ? '请核对对象、路径、迁移子项和空目录移除；一次确认所选操作。'
      : '没有需要应用的操作。';
  }
  async generate() {
    if (this.state.busy) return;
    try {
      if (!this.authority || !this.model || this.state.tree.status !== 'ready') throw Error('unavailable');
      const generation = await this.begin();
      const context = await this.authority.read();
      if (
        generation !== this.generation ||
        !context.config ||
        JSON.stringify(context.tree) !== JSON.stringify(this.state.tree.snapshot)
      )
        throw Error('stale');
      const rootId = this.state.scopeId;
      const candidates = organizeCandidates(context.tree, rootId, context.privacy);
      const result = await this.model.run({
        ...context,
        config: context.config,
        request: {
          task: 'organize',
          rootId,
          itemIds: candidates.items.map(i => i.id),
          folderIds: candidates.folders.map(f => f.id),
        },
      });
      if (generation !== this.generation) throw Error('stale');
      if (result.status !== 'completed') throw Error('model-failed');
      this.scanTree = undefined;
      this.state.duplicates = [];
      this.accept(organizeProposal(context.tree, rootId, result.output, context.privacy));
    } catch {
      this.lease?.close();
      this.lease = undefined;
      this.state.invalid = true;
      this.state.message = '提案未生成或上下文已失效；未写入书签，请检查模型设置、权限与范围后重试。';
    } finally {
      this.state.busy = false;
      this.publish();
    }
  }
  async previewDuplicates() {
    if (this.state.busy || this.state.invalid || !this.scanTree) return;
    try {
      const tree = this.scanTree;
      const generation = await this.begin();
      if (
        generation !== this.generation ||
        this.state.tree.status !== 'ready' ||
        JSON.stringify(tree) !== JSON.stringify(this.state.tree.snapshot)
      )
        throw Error('stale');
      this.accept(duplicateProposal(tree, this.state.scopeId, this.state.choices));
    } catch {
      this.lease?.close();
      this.lease = undefined;
      this.state.proposal = undefined;
      this.state.selected = [];
      this.state.message = '去重预览不可用；每组必须明确保留至少一项，且范围与扫描必须仍有效。';
    } finally {
      this.state.busy = false;
      this.publish();
    }
  }
  async apply() {
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
    this.applying = true;
    this.state.busy = true;
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
    this.invalidate();
    this.stop?.();
    this.model?.dispose();
  }
}
