import { useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsStore } from '../persistence/settings';
import type { AiServicesStore } from '../persistence/ai-services';
import { featureModelSettings } from '../adapters/feature-model-settings';
import { browserModelAuthority } from '../adapters/model-authority';
import { ModelTransport } from '../adapters/model-transport';
import { RecoveryWorkbench } from '../options/RecoveryWorkbench';
import { OrganizeController, type OrganizeState } from './organize-controller';
import { connectTree } from './tree-client';
import { organizePaths as pathLabels, organizeReview, organizeRejectionKey } from '../domain/organize-review';
import {
  scopeNodes,
  actionDependencies,
  pruneOrganizeSelection,
  type OrganizeAction,
} from '../domain/organize-proposal';
import { OrganizeTreePreview } from './OrganizeTreePreview';
import { OrganizeFlowDetails } from './OrganizeFlowDetails';
import { cancellable } from '../domain/cancellable';
import { OrganizeMemoryStore, emptyOrganizeMemory, type OrganizeMemory } from '../persistence/organize-memory';
import type { DuplicateChoice } from '../domain/exact-duplicates';
import { Select } from '../ui/Select';
import { WorkflowSteps } from '../ui/WorkflowSteps';
import { BusyIndicator } from '../ui/BusyIndicator';
import { ORGANIZE_STYLES, ORGANIZE_INSTRUCTIONS_LIMIT, type OrganizeStyle } from '../domain/organize-preferences';
import { ORGANIZE_BATCH_SIZE } from '../domain/organize-batches';
type CreateController = (emit: (state: OrganizeState) => void) => OrganizeController;
const actionNames = { create: '新建目录', move: '移动', merge: '合并目录', delete: '删除', rename: '重命名分类' };
export function OrganizeWorkbench({
  visible,
  settings,
  aiServices,
  createController,
  memoryStore,
}: {
  visible: boolean;
  settings?: SettingsStore;
  aiServices?: AiServicesStore;
  createController?: CreateController;
  memoryStore?: OrganizeMemoryStore;
}) {
  const [step, setStep] = useState(1);
  const [style, setStyle] = useState<OrganizeStyle>('topic');
  const [instructions, setInstructions] = useState('');
  const preferenceReady = style !== 'custom' || !!instructions.trim();
  const [cleanupEmpty, setCleanupEmpty] = useState(true);
  const [allowRename, setAllowRename] = useState(true);
  const [batchSizeInput, setBatchSizeInput] = useState(String(ORGANIZE_BATCH_SIZE));
  const batchSize = Number(batchSizeInput);
  const batchSizeValid = Number.isSafeInteger(batchSize) && batchSize >= 1;
  const [memory, setMemory] = useState<OrganizeMemory>(emptyOrganizeMemory);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryError, setMemoryError] = useState('');
  const memoryOperation = useRef(false);
  const memoryRead = useRef<AbortController | undefined>(undefined);
  const memoryOwner = useMemo(
    () => memoryStore ?? new OrganizeMemoryStore(typeof chrome !== 'undefined' ? chrome.storage?.local : undefined),
    [memoryStore],
  );
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [method, setMethod] = useState<'ai' | 'duplicates'>(settings ? 'ai' : 'duplicates');
  const [state, setState] = useState<OrganizeState>({
    tree: { status: 'loading' },
    scopeId: '',
    selected: [],
    targets: {},
    duplicates: [],
    choices: {},
    invalid: false,
    busy: false,
    message: '正在连接书签服务…',
  });
  const owner = useRef<OrganizeController | undefined>(undefined);
  useEffect(() => {
    const authority =
      !createController && settings && typeof chrome !== 'undefined'
        ? browserModelAuthority(featureModelSettings(settings, aiServices, 'organize'))
        : undefined;
    const transport = authority
      ? new ModelTransport(
          { fetch: (...args) => fetch(...args), contains: request => chrome.permissions.contains(request) },
          authority,
        )
      : undefined;
    const controller = createController
      ? createController(setState)
      : new OrganizeController(setState, authority, transport);
    owner.current = controller;
    const stop =
      !createController && typeof chrome !== 'undefined' && typeof chrome.runtime?.connect === 'function'
        ? connectTree(chrome.runtime, tree => controller.setTree(tree))
        : undefined;
    if (!createController && !stop) controller.setTree({ status: 'error', message: '书签服务不可用。' });
    return () => {
      stop?.();
      controller.dispose();
      memoryRead.current?.abort();
      owner.current = undefined;
    };
  }, [settings, aiServices, createController]);
  const folders = state.tree.status === 'ready' ? state.tree.snapshot.nodes.filter(n => n.childrenWritable) : [];
  const proposal = state.proposal;
  const installationId = state.tree.status === 'ready' ? state.tree.snapshot.installationId : undefined;
  useEffect(() => {
    if (!installationId) return;
    let active = true;
    setMemoryBusy(true);
    void memoryOwner
      .load(installationId)
      .then(value => {
        if (active) {
          setMemory(value);
          setMemoryError('');
        }
      })
      .catch(() => {
        if (active) setMemoryError('无法读取保护分类和拒绝记录，请重试后再生成。');
      })
      .finally(() => {
        if (active) setMemoryBusy(false);
      });
    return () => {
      active = false;
    };
  }, [installationId, memoryOwner]);
  const changeMemory = async (change: (value: OrganizeMemory) => OrganizeMemory, invalidate = false) => {
    if (!installationId || memoryOperation.current) return;
    memoryOperation.current = true;
    setMemoryBusy(true);
    if (invalidate) owner.current?.cancel();
    try {
      setMemory(await memoryOwner.update(installationId, change));
      setMemoryError('');
    } catch {
      setMemoryError('偏好保存失败，未记住此次更改；请重试。');
    } finally {
      memoryOperation.current = false;
      setMemoryBusy(false);
    }
  };
  const generate = async () => {
    if (!installationId || memoryOperation.current || !batchSizeValid) return;
    memoryOperation.current = true;
    setMemoryBusy(true);
    const read = new AbortController();
    memoryRead.current = read;
    const timer = setTimeout(() => read.abort(Error('读取整理偏好超时')), 10_000);
    try {
      const latest = await cancellable(memoryOwner.load(installationId), read.signal);
      clearTimeout(timer);
      if (read.signal.aborted) return;
      setMemory(latest);
      setMemoryError('');
      await owner.current?.generate(
        { style, instructions },
        {
          cleanupEmpty,
          allowRename,
          staged: true,
          batchSize,
          protectedFolderIds: latest.protectedFolderIds,
          rejectedSignatures: latest.rejected.map(r => r.signature),
        },
      );
    } catch {
      setMemoryError('整理偏好读取已停止或失败，请重试；未修改书签。');
    } finally {
      clearTimeout(timer);
      if (memoryRead.current === read) memoryRead.current = undefined;
      memoryOperation.current = false;
      setMemoryBusy(false);
    }
  };
  const rememberRejection = (action: OrganizeAction) => {
    if (!proposal) return;
    owner.current?.toggle(action.id, false);
    const signature = organizeRejectionKey(proposal, action, state.targets);
    void changeMemory(value => ({
      ...value,
      rejected: [
        ...value.rejected.filter(r => r.signature !== signature),
        { signature, label: `${actionNames[action.kind]}：${action.title}`.slice(0, 400) },
      ].slice(-500),
    }));
  };
  const review = useMemo(
    () => (proposal ? organizeReview(proposal, state.selected, state.targets) : undefined),
    [proposal, state.selected, state.targets],
  );
  const rejectionKeys = useMemo(
    () => new Map(proposal?.actions.map(action => [action.id, organizeRejectionKey(proposal, action, state.targets)])),
    [proposal, state.targets],
  );
  const ignoredActions = useMemo(() => {
    if (!proposal) return [];
    const eligible = new Set(
      pruneOrganizeSelection(
        proposal,
        proposal.actions
          .filter(action => !memory.rejected.some(r => r.signature === rejectionKeys.get(action.id)))
          .map(action => action.id),
        state.targets,
      ),
    );
    return proposal.actions.filter(action => !eligible.has(action.id));
  }, [proposal, memory.rejected, rejectionKeys, state.targets]);
  const scopedFolders = useMemo(() => {
    try {
      return state.tree.status === 'ready' && state.scopeId
        ? scopeNodes(state.tree.snapshot, state.scopeId).filter(n => n.ref.kind === 'folder')
        : [];
    } catch {
      return [];
    }
  }, [state.tree, state.scopeId]);
  const duplicateChoicesReady =
    state.duplicates.some(group => group.items.some(node => state.choices[node.ref.nativeId] === 'delete')) &&
    state.duplicates.every(
      group =>
        !group.items.some(node => state.choices[node.ref.nativeId] === 'delete') ||
        group.items.some(node => state.choices[node.ref.nativeId] === 'keep'),
    );
  const currentTree = state.tree.status === 'ready' ? state.tree.snapshot : undefined;
  const scopeProtected = useMemo(() => {
    const nodes = new Map(currentTree?.nodes.map(n => [n.ref.nativeId, n]));
    const seen = new Set<string>();
    let id: string | undefined = state.scopeId;
    while (id && !seen.has(id)) {
      if (memory.protectedFolderIds.includes(id)) return true;
      seen.add(id);
      id = nodes.get(id)?.parentId;
    }
    return false;
  }, [currentTree, state.scopeId, memory.protectedFolderIds]);
  const currentPaths = useMemo(() => pathLabels(currentTree), [currentTree]);
  const proposalPaths = useMemo(() => pathLabels(proposal?.tree), [proposal?.tree]);
  const projectedPaths = useMemo(() => pathLabels(review?.tree), [review?.tree]);
  const folderReview = state.pipeline?.stage === 'folders';
  const batchIncomplete = !!state.pipeline && state.pipeline.stage !== 'complete';
  const locked = (id: string) => state.pipeline?.lockedActionIds.includes(id) ?? false;
  const targetOptions = useMemo(
    () =>
      proposal?.targetIds.map(id => (
        <option key={id} value={id}>
          {(!folderReview && (projectedPaths.get(id) ?? projectedPaths.get(`$batch:create:${id}:$created`))) ||
            proposalPaths.get(id) ||
            proposal.actions.find(a => a.kind === 'create' && a.sourceId === id)?.title ||
            id}
        </option>
      )),
    [proposal, proposalPaths, projectedPaths, folderReview],
  );
  return (
    <section
      hidden={!visible}
      className="surface organize-workbench workflow-workbench"
      aria-label="整理工作台"
      aria-busy={state.busy && !state.pipeline?.finished.length}
    >
      <h2>整理书签</h2>
      <p>先确认文件夹分类，再分批查看书签建议，最后统一确认执行。</p>
      <WorkflowSteps
        labels={
          method === 'ai' ? ['选择范围', '分类方案', '分批书签', '确认执行'] : ['选择范围', '查看方案', '确认执行']
        }
        current={method === 'ai' ? (step === 3 ? 4 : step === 2 && state.pipeline && !folderReview ? 3 : step) : step}
      />
      <div hidden={step !== 1} className="workflow-stage">
        <h3>想整理哪个目录？</h3>
        <label>
          整理范围
          <Select
            aria-label="整理范围"
            disabled={state.busy}
            value={state.scopeId}
            onChange={e => {
              owner.current?.selectScope(e.target.value);
              setStep(1);
            }}
          >
            <option value="">请选择目录</option>
            {folders.map(n => (
              <option key={n.ref.nativeId} value={n.ref.nativeId}>
                {currentPaths.get(n.ref.nativeId) ?? n.title}
              </option>
            ))}
          </Select>
        </label>
        {state.tree.status === 'error' && <p role="alert">{state.tree.message}</p>}
        {state.tree.status === 'loading' && <p role="status">正在读取书签…</p>}
        <h3>选择整理方式</h3>
        <div className="workflow-choices">
          <label className="workflow-choice">
            <input
              type="radio"
              name="organize-method"
              checked={method === 'ai'}
              disabled={state.busy || !settings}
              onChange={() => setMethod('ai')}
            />
            <span>
              <strong>AI 整理目录</strong>
              <small>根据内容建议分类、移动和合并；由你决定采用哪些。</small>
            </span>
          </label>
          <label className="workflow-choice">
            <input
              type="radio"
              name="organize-method"
              checked={method === 'duplicates'}
              disabled={state.busy}
              onChange={() => setMethod('duplicates')}
            />
            <span>
              <strong>清理重复书签</strong>
              <small>本地查找链接完全相同的书签，手动选择保留项。</small>
            </span>
          </label>
        </div>
        {method === 'ai' && (
          <div className="organize-preferences">
            <label>
              分类方式
              <Select
                aria-label="分类方式"
                value={style}
                disabled={state.busy}
                onChange={e => {
                  owner.current?.cancel();
                  setStyle(e.target.value as OrganizeStyle);
                }}
              >
                {ORGANIZE_STYLES.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
            <p className="hint">{ORGANIZE_STYLES.find(option => option.id === style)?.hint}</p>
            <label>
              {style === 'custom' ? '你的分类要求（必填）' : '补充要求（选填）'}
              <textarea
                aria-label="分类要求"
                rows={3}
                maxLength={ORGANIZE_INSTRUCTIONS_LIMIT}
                value={instructions}
                disabled={state.busy}
                placeholder="例如：分成写作、画图、编程，目录用中文；拿不准的保持原位。"
                onChange={e => {
                  owner.current?.cancel();
                  setInstructions(e.target.value);
                }}
              />
            </label>
            <p className="hint">
              仅用于本次整理；要求会与所选范围的书签信息一起发送给 AI。{instructions.length}/
              {ORGANIZE_INSTRUCTIONS_LIMIT}
            </p>
          </div>
        )}
        {method === 'ai' && (
          <>
            <label>
              每批最多书签
              <input
                aria-label="每批最多书签"
                type="number"
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                value={batchSizeInput}
                aria-invalid={!batchSizeValid}
                aria-describedby={!batchSizeValid ? 'organize-batch-size-error' : undefined}
                disabled={state.busy || memoryBusy}
                onChange={e => {
                  owner.current?.cancel();
                  setBatchSizeInput(e.target.value);
                }}
              />
            </label>
            {!batchSizeValid && (
              <p id="organize-batch-size-error" role="alert">
                请输入大于或等于 1 的有效整数。
              </p>
            )}
            <p className="hint">
              默认每批最多 100
              条，可自定义数量。同时按内容长度自动拆分，每批完成就能查看。请保持本页面打开；切换页内栏目不影响生成，关闭或刷新页面会丢失本次进度。
            </p>
            <label className="organize-option">
              <input
                type="checkbox"
                checked={cleanupEmpty}
                disabled={state.busy || memoryBusy}
                onChange={e => {
                  owner.current?.cancel();
                  setCleanupEmpty(e.target.checked);
                }}
              />
              建议清理原有空分类和迁移后变空的分类
            </label>
            <label className="organize-option">
              <input
                type="checkbox"
                checked={allowRename}
                disabled={state.busy || memoryBusy}
                onChange={e => {
                  owner.current?.cancel();
                  setAllowRename(e.target.checked);
                }}
              />
              允许建议重命名分类
            </label>
            <details className="workflow-help">
              <summary>保护分类与已拒绝建议</summary>
              <p>勾选的分类及其内容保持不动；保存在本机，后续整理继续遵守。</p>
              {scopedFolders.map(folder => (
                <label className="organize-option" key={folder.ref.nativeId}>
                  <input
                    type="checkbox"
                    aria-label={`保护 ${folder.title}`}
                    checked={memory.protectedFolderIds.includes(folder.ref.nativeId)}
                    disabled={state.busy || memoryBusy}
                    onChange={e => {
                      const checked = e.target.checked;
                      void changeMemory(
                        value => ({
                          ...value,
                          protectedFolderIds: checked
                            ? [...new Set([...value.protectedFolderIds, folder.ref.nativeId])]
                            : value.protectedFolderIds.filter(id => id !== folder.ref.nativeId),
                        }),
                        true,
                      );
                    }}
                  />
                  {currentPaths.get(folder.ref.nativeId)}
                </label>
              ))}
              <p>已记住 {memory.rejected.length} 条拒绝建议；普通取消勾选只影响本次。</p>
              {memory.rejected.map(record => (
                <div key={record.signature}>
                  <span>{record.label}</span>
                  <button
                    disabled={state.busy || memoryBusy}
                    onClick={() =>
                      void changeMemory(value => ({
                        ...value,
                        rejected: value.rejected.filter(r => r.signature !== record.signature),
                      }))
                    }
                  >
                    恢复建议
                  </button>
                </div>
              ))}
              {!!memory.rejected.length && (
                <button
                  disabled={state.busy || memoryBusy}
                  onClick={() => void changeMemory(value => ({ ...value, rejected: [] }))}
                >
                  清空拒绝记录
                </button>
              )}
            </details>
          </>
        )}
        {memoryError && (
          <p role="alert">
            {memoryError}
            <button disabled={memoryBusy} onClick={() => void changeMemory(value => value)}>
              重试读取偏好
            </button>
          </p>
        )}
        {memoryBusy && !state.busy && <p role="status">正在读取或保存整理偏好…</p>}
        {method === 'ai' && scopeProtected && <p role="status">该范围位于受保护分类中，请取消保护或选择其他范围。</p>}
        <p className="hint">这一步只生成建议，不会修改书签。</p>
        <div className="workflow-footer">
          <button
            className="primary"
            disabled={
              !state.scopeId ||
              state.busy ||
              (method === 'ai' && (memoryBusy || !!memoryError || scopeProtected)) ||
              state.tree.status !== 'ready' ||
              (method === 'ai' && (!settings || !preferenceReady || !batchSizeValid))
            }
            onClick={() => {
              setStep(2);
              if (method === 'duplicates') owner.current?.scan();
              else void generate();
            }}
          >
            {method === 'ai' ? '下一步：生成整理方案' : '下一步：查找重复书签'}
          </button>
        </div>
      </div>
      <div hidden={step === 1} className="workflow-stage">
        <h3>
          {state.result
            ? '执行结果'
            : step === 3
              ? '确认所选操作'
              : folderReview
                ? '先核对文件夹分类'
                : state.pipeline
                  ? '分批查看书签建议'
                  : '查看并选择建议'}
        </h3>
        <div className="actions" hidden={!!state.failure && !state.busy}>
          <button
            disabled={!state.busy && !proposal && !memoryBusy}
            onClick={() => {
              memoryRead.current?.abort();
              owner.current?.cancel();
            }}
          >
            {state.busy && state.pipeline?.stage === 'bookmarks'
              ? '暂停后续批次'
              : state.busy || memoryBusy
                ? '停止当前任务'
                : '取消当前方案'}
          </button>
        </div>
        {memoryError && <p role="alert">{memoryError}</p>}
        {state.pipeline && (
          <section className="organize-batches" aria-label="分阶段整理进度">
            {folderReview ? (
              <>
                <p>
                  整理范围共 {state.pipeline.total} 条书签；每批最多 {state.pipeline.batchSize} 条。
                </p>
                <p>
                  当前先规划 {state.pipeline.folderCount} 个目录的分类结构，仅发送目录信息、书签数量和少量标题样本。
                </p>
                <p className="hint">确认分类后才逐批分析书签去向，内容过长会继续拆小。当前尚未开始书签批次。</p>
              </>
            ) : (
              <>
                <p role="status" aria-live="polite">
                  已完成 {state.pipeline.finished.length} / {state.pipeline.batchCount} 批，已分析{' '}
                  {state.pipeline.analyzed ?? state.pipeline.completed} / {state.pipeline.total} 条书签。
                </p>
                <p className="hint">分类结构已固定。下方显示已完成批次的预览；全部批次完成并由你确认后才修改书签。</p>
                <ol>
                  {state.pipeline.finished.map((batch, index) => (
                    <li key={index}>
                      <details>
                        <summary>
                          第 {index + 1} 批已完成 · {batch.count} 条书签 · {batch.actionIds.length} 条变更建议
                        </summary>
                        {batch.actionIds.length ? (
                          <ul>
                            {batch.actionIds.map(id => {
                              const action = proposal?.actions.find(a => a.id === id);
                              return (
                                <li key={id}>
                                  {action?.title}：{action?.reason}（{state.selected.includes(id) ? '已选' : '未选'}）
                                </li>
                              );
                            })}
                          </ul>
                        ) : (
                          <p>此批书签保持确认后的目录位置。</p>
                        )}
                      </details>
                    </li>
                  ))}
                </ol>
                {!state.busy && !state.invalid && !state.result && (
                  <button
                    onClick={() => {
                      owner.current?.returnToFolders();
                      setStep(2);
                    }}
                  >
                    更改文件夹方案并重新分析书签
                  </button>
                )}
              </>
            )}
          </section>
        )}
        {state.busy && <BusyIndicator label={state.message} />}
        {state.failure && !state.busy && (
          <section className="organize-failure" role="alert" aria-label="整理未完成">
            <h3>整理未完成</h3>
            <p>{state.message}</p>
            <p className="hint">
              {state.failure.bookmarkCount !== undefined &&
                `${folderReview ? '整理范围共' : state.pipeline ? '当前批次' : '本次参与整理'} ${state.failure.bookmarkCount} 条书签 · `}
              耗时 {state.failure.elapsedSeconds} 秒 · 失败阶段：
              {folderReview && state.failure.phase !== '书签请求准备' ? '文件夹分类 · ' : ''}
              {state.failure.phase}
            </p>
            {state.failure.outputTokenLimit !== undefined && (
              <p>
                本次请求的模型输出上限：{state.failure.outputTokenLimit.toLocaleString('en-US')}{' '}
                tokens（包含推理和正文）。
              </p>
            )}
            {state.failure.code === 'output-limit' && <a href="#ai-services">调整模型输出上限</a>}
            <details>
              <summary>错误详情</summary>
              <p>
                错误代码：<code>{state.failure.code}</code>。反馈问题时可附上此代码和调试日志。
              </p>
            </details>
          </section>
        )}
        {state.busy && state.progress && (
          <section className="organize-progress" aria-label="生成中的建议">
            <p className="hint">
              {folderReview
                ? '文件夹分类阶段'
                : `${state.pipeline ? '当前批次' : '本次参与整理'} ${state.progress.bookmarkCount} 条书签`}
              ，连接或连续无流数据的等待上限 {state.progress.timeoutSeconds}{' '}
              秒；持续收到数据会继续等待。非流式响应按总时间限制。
              这是超时上限，实际完成后即可继续，无需等满；可随时停止。
            </p>
            {state.progress.outputTokenLimit !== undefined && (
              <p className="hint">
                本次模型输出上限：{state.progress.outputTokenLimit.toLocaleString('en-US')} tokens（包含推理和正文）。
              </p>
            )}
            {!state.progress.streaming && <p className="hint">当前服务按完整响应返回，完成后显示方案。</p>}
            {!!state.progress.preview.length && (
              <>
                <h4>正在生成的建议</h4>
                <ul>
                  {state.progress.preview.map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ul>
                <p className="hint">先预览部分建议；完整方案返回并检查后，才能选择和确认执行。</p>
              </>
            )}
          </section>
        )}
        <div hidden={step !== 2 || !!state.result}>
          {state.duplicates.map(group => (
            <article key={group.url}>
              <h3>精确重复：{group.url}</h3>
              <p>保留至少一项；未选择的项目不删除。参数、片段和尾斜杠不同不会合并。</p>
              {group.items.map(node => (
                <label key={node.ref.nativeId}>
                  {node.title} ·{' '}
                  {proposalPaths.get(node.ref.nativeId) ?? currentPaths.get(node.ref.nativeId) ?? node.ref.nativeId}
                  <Select
                    aria-label={`${node.title} 保留或删除`}
                    disabled={state.busy || state.invalid}
                    value={state.choices[node.ref.nativeId] ?? 'unselected'}
                    onChange={e => owner.current?.choice(node.ref.nativeId, e.target.value as DuplicateChoice)}
                  >
                    <option value="unselected">未选择</option>
                    <option value="keep">明确保留</option>
                    <option value="delete" disabled={node.readOnly}>
                      明确删除
                    </option>
                  </Select>
                </label>
              ))}
            </article>
          ))}
          {!!state.duplicates.length && !proposal && (
            <button
              className="primary"
              disabled={state.busy || state.invalid || !duplicateChoicesReady}
              onClick={() => void owner.current?.previewDuplicates()}
            >
              生成去重预览
            </button>
          )}
          {!!state.duplicates.length && !proposal && !duplicateChoicesReady && (
            <p className="hint">选择要删除的重复项，并为同组书签指定至少一项保留。</p>
          )}
          {proposal && (
            <article>
              <h3>本次整理：{proposalPaths.get(proposal.scope.nativeId)}</h3>
              {!state.invalid && review?.tree && (
                <>
                  <OrganizeTreePreview proposal={proposal} after={review.tree} selected={state.selected} />
                  <OrganizeFlowDetails proposal={proposal} after={review.tree} />
                </>
              )}
              {review?.error && <p role="alert">{review.error}</p>}
              {state.invalid && <p role="alert">此方案已失效，请重新生成；下方仅保留旧建议供核对。</p>}
              <section className="organize-adjustments" aria-label="详细调整方案">
                <header className="organize-adjustments-heading">
                  <h3>详细调整方案</h3>
                  <p className="hint">逐条决定是否采用，下方选择会同步更新上方分类预览。</p>
                </header>
                {!!ignoredActions.length && (
                  <details className="workflow-help">
                    <summary>已按你的记录忽略 {ignoredActions.length} 条建议（含关联操作）</summary>
                    {ignoredActions.map(action => (
                      <p key={action.id}>
                        {action.title}
                        {memory.rejected.some(r => r.signature === rejectionKeys.get(action.id)) ? (
                          <button
                            disabled={state.busy || memoryBusy}
                            onClick={() =>
                              void changeMemory(value => ({
                                ...value,
                                rejected: value.rejected.filter(r => r.signature !== rejectionKeys.get(action.id)),
                              }))
                            }
                          >
                            恢复此建议
                          </button>
                        ) : (
                          <small>随前置建议一同忽略；恢复前置建议后可重新选择。</small>
                        )}
                      </p>
                    ))}
                  </details>
                )}
                <p className="hint">
                  先核对整体分类，再查看每条建议。取消勾选会同步取消依赖操作；勾选时会同时选中必要的前置操作。
                </p>
                {proposal.actions
                  .filter(action => !ignoredActions.includes(action))
                  .map(action => (
                    <div className="workflow-review-row" key={action.id}>
                      <label>
                        <input
                          type="checkbox"
                          aria-label={`选择 ${action.id}`}
                          checked={state.selected.includes(action.id)}
                          disabled={state.busy || state.invalid || !!state.result || locked(action.id)}
                          onChange={e => owner.current?.toggle(action.id, e.target.checked)}
                        />
                        {actionNames[action.kind]}：{action.title}
                      </label>
                      <p>当前路径：{action.kind === 'create' ? '新建目录' : proposalPaths.get(action.sourceId)}</p>
                      <div className="organize-reason">
                        <p>建议理由：{action.reason ?? '清理链接完全相同的重复书签，保留已明确指定的副本。'}</p>
                        {method === 'ai' && (
                          <button
                            className="organize-reject"
                            title="记住此选择，以后不再建议这个操作；仅本次不采用请取消勾选"
                            disabled={state.busy || state.invalid || !!state.result || memoryBusy || locked(action.id)}
                            onClick={() => rememberRejection(action)}
                          >
                            不再建议
                          </button>
                        )}
                      </div>
                      {action.newTitle && (
                        <p>
                          名称：{action.title} → <strong>{action.newTitle}</strong>
                        </p>
                      )}
                      {!!actionDependencies(proposal, action, state.targets).length && (
                        <p className="hint">
                          需要同时选择：
                          {actionDependencies(proposal, action, state.targets)
                            .map(id => proposal.actions.find(a => a.id === id)?.title ?? id)
                            .join('、')}
                        </p>
                      )}
                      {action.targetId && (
                        <label>
                          建议目标
                          <Select
                            aria-label={`${action.id} 目标`}
                            disabled={state.busy || state.invalid || !!state.result || locked(action.id)}
                            value={state.targets[action.id] ?? action.targetId}
                            onChange={e => owner.current?.target(action.id, e.target.value)}
                          >
                            {targetOptions}
                          </Select>
                        </label>
                      )}
                      {action.kind === 'merge' && (
                        <>
                          <p>
                            先迁移下列直接子项（包含其内容），然后仅移除空目录：{action.title}
                            。任何新增子项都将导致停止。
                          </p>
                          <ul>
                            {action.children.map(id => (
                              <li key={id}>{proposalPaths.get(id)}</li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  ))}
              </section>
            </article>
          )}
        </div>
        {step === 3 && !state.result && (
          <>
            <p className="workflow-summary">
              整理目录：{proposalPaths.get(proposal?.scope.nativeId ?? '')} · 已选 {state.selected.length} 项操作
            </p>
            <p>确认后将修改浏览器书签，写入前会自动备份。删除和合并操作也会执行，请确认上一步的选择。</p>
          </>
        )}
        <div className="workflow-footer organize-footer">
          <p
            className="organize-footer-status"
            role={state.invalid && !state.failure ? 'alert' : 'status'}
            aria-live="polite"
          >
            {state.failure && !state.busy
              ? '本次未生成完整方案，不能进入确认步骤。书签未修改，请按上方提示调整后重试。'
              : state.busy && state.pipeline?.stage === 'bookmarks'
                ? '可以查看已完成批次；后台继续生成后续建议，全部完成后才能确认执行。'
                : state.busy
                  ? state.progress
                    ? '方案尚未完成，收到完整方案并校验后才能继续。'
                    : state.message
                  : memoryBusy
                    ? '正在读取或保存整理偏好…'
                    : review?.error
                      ? review.error
                      : proposal &&
                          !folderReview &&
                          !state.invalid &&
                          proposal.actions.length > 0 &&
                          !state.selected.length
                        ? '方案已生成，请至少勾选一项建议后继续。'
                        : state.message}
          </p>
          {state.pipeline?.stage === 'bookmarks' &&
            !state.busy &&
            !state.invalid &&
            ['paused', 'failed'].includes(state.pipeline.status) && (
              <button
                className="primary"
                disabled={state.tree.status !== 'ready' || memoryBusy}
                onClick={() => void owner.current?.resumeBatches()}
              >
                继续未完成批次
              </button>
            )}
          {method === 'ai' && !state.busy && !state.result && (!proposal || state.invalid) && (
            <button
              className={state.failure?.code === 'output-limit' ? undefined : 'primary'}
              disabled={
                state.tree.status !== 'ready' || !preferenceReady || !batchSizeValid || memoryBusy || scopeProtected
              }
              onClick={() => {
                setStep(2);
                void generate();
              }}
            >
              重新生成方案
            </button>
          )}
          <button
            className={state.failure?.code === 'output-limit' ? 'primary' : undefined}
            disabled={state.busy}
            onClick={() => setStep(step === 3 && !state.result ? 2 : 1)}
          >
            {state.result ? '开始新的整理' : state.failure?.code === 'output-limit' ? '缩小整理范围' : '上一步'}
          </button>
          {!state.result &&
            (step === 2 && folderReview ? (
              <button
                className="primary"
                disabled={state.busy || state.invalid || memoryBusy || !!review?.error || !proposal}
                onClick={() => void owner.current?.confirmFolders()}
              >
                确认分类，开始分批整理书签
              </button>
            ) : step === 2 ? (
              <button
                className="primary"
                disabled={
                  state.busy ||
                  state.invalid ||
                  batchIncomplete ||
                  memoryBusy ||
                  !!review?.error ||
                  !proposal ||
                  !state.selected.length
                }
                onClick={() => setStep(3)}
              >
                下一步：确认操作
              </button>
            ) : (
              <button
                className="primary"
                disabled={
                  state.busy ||
                  state.invalid ||
                  batchIncomplete ||
                  memoryBusy ||
                  !!review?.error ||
                  !state.selected.length ||
                  !proposal
                }
                onClick={() => void owner.current?.apply()}
              >
                确认并执行 {state.selected.length} 项操作
              </button>
            ))}
        </div>
        {state.result && (
          <p>
            请求编号：{state.result.requestId}。状态 {state.result.status}；已完成 {state.result.completedSteps}，未完成{' '}
            {state.result.remainingSteps}。请读取下方恢复记录核对逐步回执。
          </p>
        )}
      </div>
      <details className="workflow-help">
        <summary>整理说明</summary>
        <p>
          只整理所选目录。重复链接按原始 URL
          精确匹配，参数、片段和尾斜杠不同不会合并。执行失败会停止，已经执行的操作需从恢复记录核对。
        </p>
      </details>
      <details className="workflow-help" onToggle={e => setRecoveryOpen(e.currentTarget.open)}>
        <summary>恢复与撤销记录</summary>
        <RecoveryWorkbench visible={visible && recoveryOpen} />
      </details>
    </section>
  );
}
