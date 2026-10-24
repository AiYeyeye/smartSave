import { useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsStore } from '../persistence/settings';
import type { AiServicesStore } from '../persistence/ai-services';
import { featureModelSettings } from '../adapters/feature-model-settings';
import { RecoveryWorkbench } from '../options/RecoveryWorkbench';
import { OrganizeController, type OrganizeState } from './organize-controller';
import { OrganizeTaskClient, type OrganizeWorkbenchOwner } from './organize-task-client';
import { connectTree } from './tree-client';
import { organizePaths as pathLabels, organizeReview, organizeRejectionKey } from '../domain/organize-review';
import { scopeNodes, pruneOrganizeSelection, type OrganizeAction } from '../domain/organize-proposal';
import { OrganizeScopeStep } from './OrganizeScopeStep';
import { OrganizeGenerationProgress } from './OrganizeGenerationProgress';
import { cancellable } from '../domain/cancellable';
import { OrganizeMemoryStore, emptyOrganizeMemory, type OrganizeMemory } from '../persistence/organize-memory';
import { Select } from '../ui/Select';
import { WorkflowSteps } from '../ui/WorkflowSteps';
import type { OrganizeStyle, OrganizeSubStyle } from '../domain/organize-preferences';
import { ORGANIZE_BATCH_SIZE } from '../domain/organize-batches';
import { DEFAULT_ORGANIZE_LEVELS, type OrganizeLevels } from '../domain/classification-policy';
import { useI18n } from '../ui/i18n';
import { organizeActionNames as actionNames } from './organize-action-text';
import { OrganizeReviewStep } from './OrganizeReviewStep';
import { OrganizeConfirmation } from './OrganizeConfirmation';
import { OrganizeInteractiveReview } from './OrganizeInteractiveReview';
type CreateController = (emit: (state: OrganizeState) => void) => OrganizeWorkbenchOwner;
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
  const { t, message, language } = useI18n();
  const [step, setStep] = useState(1);
  const [style, setStyle] = useState<OrganizeStyle>('topic');
  const [instructions, setInstructions] = useState('');
  const preferenceReady = style !== 'custom' || !!instructions.trim();
  const [cleanupEmpty, setCleanupEmpty] = useState(true);
  const [unfiledOnly, setUnfiledOnly] = useState(false);
  const [allowRename, setAllowRename] = useState(true);
  const [levels, setLevels] = useState<OrganizeLevels>(DEFAULT_ORGANIZE_LEVELS);
  const [subStyle, setSubStyle] = useState<OrganizeSubStyle | ''>('');
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
  const owner = useRef<OrganizeWorkbenchOwner | undefined>(undefined);
  useEffect(() => {
    const controller = createController
      ? createController(setState)
      : settings && typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function'
        ? new OrganizeTaskClient(setState, featureModelSettings(settings, aiServices, 'organize'))
        : new OrganizeController(setState);
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
  useEffect(() => {
    const update = () =>
      owner.current?.setVisible?.(visible && method === 'ai' && document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      owner.current?.setVisible?.(false);
    };
  }, [
    visible,
    method,
    state.task?.id,
    state.task?.revision,
    state.pipeline?.stage,
    state.pipeline?.status,
    settings,
    aiServices,
    createController,
  ]);
  useEffect(() => {
    if (state.task?.id) {
      setMethod('ai');
      setStep(state.task.requestId ? 3 : 2);
    }
  }, [state.task?.id, state.task?.requestId]);
  const folders = state.tree.status === 'ready' ? state.tree.snapshot.nodes.filter(n => n.childrenWritable) : [];
  const proposal = state.proposal;
  const [installationId, setInstallationId] = useState<string>();
  useEffect(() => {
    if (state.tree.status === 'ready') setInstallationId(state.tree.snapshot.installationId);
  }, [state.tree]);
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
    if (invalidate) await owner.current?.cancel();
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
    if (state.tree.status !== 'ready' || !installationId || memoryOperation.current || !batchSizeValid) return;
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
        {
          style,
          instructions,
          ...(subStyle && levels > 1 && !['custom', 'existing', 'numbered'].includes(style) ? { subStyle } : {}),
        },
        {
          cleanupEmpty,
          unfiledOnly,
          allowRename,
          levels,
          staged: true,
          contentFirst: true,
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
  const rememberRejection = async (action: OrganizeAction) => {
    if (!proposal) return;
    const signature = organizeRejectionKey(proposal, action, state.targets);
    const controller = owner.current;
    if (controller?.deselectForMemory) {
      if (!(await controller.deselectForMemory(action.id))) {
        setMemoryError('取消选择尚未保存，未记住此次拒绝；请重新读取任务后重试。');
        return;
      }
    } else await controller?.toggle(action.id, false);
    await changeMemory(value => ({
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
  const rootLabel = t('根目录');
  const currentPaths = useMemo(() => pathLabels(currentTree, rootLabel), [currentTree, rootLabel]);
  const proposalPaths = useMemo(() => pathLabels(proposal?.tree, rootLabel), [proposal?.tree, rootLabel]);
  const projectedPaths = useMemo(() => pathLabels(review?.tree, rootLabel), [review?.tree, rootLabel]);
  const folderReview = state.pipeline?.stage === 'folders' && !state.pipeline.contentPhase;
  const bookmarkMoves = useMemo(() => {
    const nodes = new Map(proposal?.tree.nodes.map(node => [node.ref.nativeId, node]));
    return (
      proposal?.actions.filter(
        action =>
          action.kind === 'move' &&
          nodes.get(action.sourceId)?.ref.kind === 'bookmark' &&
          !ignoredActions.includes(action),
      ) ?? []
    );
  }, [proposal, ignoredActions]);
  const targetLabels = useMemo(
    () =>
      new Map(
        proposal?.targetIds.map(id => [
          id,
          (!folderReview && (projectedPaths.get(id) ?? projectedPaths.get(`$batch:create:${id}:$created`))) ||
            proposalPaths.get(id) ||
            proposal.actions.find(a => a.kind === 'create' && a.sourceId === id)?.title ||
            id,
        ]),
      ),
    [proposal, proposalPaths, projectedPaths, folderReview],
  );
  const targetOptions = useMemo(
    () =>
      proposal?.targetIds.map(id => (
        <option key={id} value={id}>
          {targetLabels.get(id)}
        </option>
      )),
    [proposal, targetLabels],
  );
  return (
    <section
      hidden={!visible}
      className="surface organize-workbench workflow-workbench"
      aria-label={t('整理工作台')}
      aria-busy={state.busy && !state.pipeline?.finished.length}
    >
      <h2>{t('整理书签')}</h2>
      {state.task && (
        <details className="workflow-help organize-saved-tasks">
          <summary>{t('已保存的整理任务（{count}）', { count: state.task.available.length })}</summary>
          <label>
            {t('整理任务')}
            <Select
              aria-label={t('已保存的整理任务')}
              value={state.task.id ?? ''}
              disabled={state.busy || memoryBusy}
              onChange={event => {
                if (event.target.value) void owner.current?.restoreTask?.(event.target.value);
              }}
            >
              <option value="">{t('选择一项任务查看进度')}</option>
              {state.task.available.map(task => (
                <option key={task.id} value={task.id} disabled={!task.readable}>
                  {new Date(task.updatedAt).toLocaleString(language)} ·{' '}
                  {task.requestId
                    ? t('已提交')
                    : task.stage === 'complete'
                      ? t('待确认')
                      : task.stage === 'folders'
                        ? t('分类方案')
                        : t('书签分析')}{' '}
                  · {task.id.slice(0, 8)}
                </option>
              ))}
            </Select>
          </label>
          <button disabled={state.busy && state.task.connected} onClick={() => void owner.current?.refreshTasks?.()}>
            {t('重新读取任务列表')}
          </button>
          {state.task.id && (
            <button
              disabled={state.busy && state.task.connected}
              onClick={() => void owner.current?.restoreTask?.(state.task!.id!)}
            >
              {t('重新读取当前任务')}
            </button>
          )}
        </details>
      )}
      {state.task?.needsCredential && (
        <p role="status">
          {t('本次整理的临时 API Key 已不在后台内存中。请到')}
          <a href="#ai-services">{t('AI 服务')}</a> {t('重新输入，再明确继续；已完成建议保留。')}
        </p>
      )}
      {state.task && !state.task.connected && <p role="status">{t('正在重新连接整理任务…方案已保存，不会丢失。')}</p>}
      <WorkflowSteps
        labels={
          method === 'ai' && state.pipeline && !state.pipeline.contentPhase
            ? [t('选择范围'), t('分类方案'), t('分批书签'), t('确认执行')]
            : [t('选择范围'), t(method === 'ai' ? '生成与完整预览' : '查看方案'), t('确认执行')]
        }
        current={
          method === 'ai' && state.pipeline && !state.pipeline.contentPhase
            ? step === 3
              ? 4
              : step === 2 && !folderReview
                ? 3
                : step
            : step
        }
      />
      <OrganizeScopeStep
        hidden={step !== 1}
        state={state}
        modelAvailable={!!settings}
        method={method}
        setMethod={setMethod}
        style={style}
        setStyle={setStyle}
        instructions={instructions}
        setInstructions={setInstructions}
        unfiledOnly={unfiledOnly}
        setUnfiledOnly={setUnfiledOnly}
        cleanupEmpty={cleanupEmpty}
        setCleanupEmpty={setCleanupEmpty}
        allowRename={allowRename}
        setAllowRename={setAllowRename}
        levels={levels}
        setLevels={setLevels}
        subStyle={subStyle}
        setSubStyle={setSubStyle}
        batchSizeInput={batchSizeInput}
        setBatchSizeInput={setBatchSizeInput}
        batchSizeValid={batchSizeValid}
        preferenceReady={preferenceReady}
        scopeProtected={scopeProtected}
        memory={memory}
        memoryBusy={memoryBusy}
        memoryError={memoryError}
        changeMemory={changeMemory}
        folders={folders}
        scopedFolders={scopedFolders}
        currentPaths={currentPaths}
        cancel={() => {
          void owner.current?.cancel();
        }}
        onScopeChange={id => {
          owner.current?.selectScope(id);
          setStep(1);
        }}
        onStart={() => {
          setStep(2);
          if (method === 'duplicates') owner.current?.scan();
          else void generate();
        }}
      />
      <div hidden={step === 1} className="workflow-stage">
        <h3>
          {state.result
            ? t('执行结果')
            : state.task?.requestId
              ? t('正在执行整理')
              : step === 3
                ? t('确认所选操作')
                : folderReview
                  ? t('先核对文件夹分类')
                  : state.pipeline
                    ? t(state.pipeline.contentPhase ? '生成与完整预览' : '分批查看书签建议')
                    : t('查看并选择建议')}
        </h3>
        <div className="actions" hidden={!!state.result || (!!state.failure && !state.busy)}>
          <button
            disabled={!state.busy && !proposal && !memoryBusy}
            onClick={() => {
              memoryRead.current?.abort();
              owner.current?.cancel();
            }}
          >
            {state.busy && (state.pipeline?.stage === 'bookmarks' || state.pipeline?.contentPhase)
              ? t('暂停后续批次')
              : state.busy || memoryBusy
                ? t('停止当前任务')
                : t('取消当前方案')}
          </button>
        </div>
        {memoryError && <p role="alert">{message(memoryError)}</p>}
        <OrganizeGenerationProgress
          state={state}
          returnToFolders={() => {
            void owner.current?.returnToFolders();
            setStep(2);
          }}
        />
        {step === 2 && (
          <OrganizeInteractiveReview
            state={state}
            targets={targetLabels}
            review={async edit => {
              if (!owner.current?.reviewContent) throw Error('unavailable');
              await owner.current.reviewContent(edit);
            }}
          />
        )}
        <OrganizeReviewStep
          hidden={step !== 2 || (!!state.pipeline?.contentPhase && !proposal)}
          state={state}
          method={method}
          memory={memory}
          memoryBusy={memoryBusy}
          currentPaths={currentPaths}
          proposalPaths={proposalPaths}
          targetLabels={targetLabels}
          targetOptions={targetOptions}
          review={review}
          bookmarkMoves={bookmarkMoves}
          ignoredActions={ignoredActions}
          rejectionKeys={rejectionKeys}
          duplicateChoicesReady={duplicateChoicesReady}
          changeMemory={changeMemory}
          rememberRejection={rememberRejection}
          commands={{
            choice: (id, choice) => owner.current?.choice(id, choice),
            previewDuplicates: async () => {
              await owner.current?.previewDuplicates();
            },
            toggle: (id, value) => owner.current?.toggle(id, value),
            toggleMany: (ids, value) => owner.current?.toggleMany(ids, value),
            target: (id, value) => owner.current?.target(id, value),
          }}
        />

        <OrganizeConfirmation
          state={state}
          step={step}
          setStep={setStep}
          method={method}
          memoryBusy={memoryBusy}
          proposalPaths={proposalPaths}
          review={review}
          preferenceReady={preferenceReady}
          batchSizeValid={batchSizeValid}
          scopeProtected={scopeProtected}
          generate={() => {
            void generate();
          }}
          commands={{
            repairBatches: () => owner.current?.repairBatches(),
            resumeBatches: () => owner.current?.resumeBatches(),
            confirmFolders: () => owner.current?.confirmFolders(),
            apply: async () => {
              await owner.current?.apply();
            },
            observe: async reconcile => {
              await owner.current?.observe?.(reconcile);
            },
          }}
        />
      </div>
      <details className="workflow-help" onToggle={e => setRecoveryOpen(e.currentTarget.open)}>
        <summary>{t('恢复与撤销记录')}</summary>
        <RecoveryWorkbench visible={visible && recoveryOpen} />
      </details>
    </section>
  );
}
