import { eligibleImportDestination } from '../domain/import-preview';
import { importDiagnosticSources } from '../domain/import-sources';
import { useEffect, useRef, useState } from 'react';
import { browserModelAuthority } from '../adapters/model-authority';
import { ModelTransport } from '../adapters/model-transport';
import { ImportPipeline } from '../domain/import-pipeline';
import type { TreeSnapshot } from '../domain/node-reference';
import { IMPORT_RESOURCE_BUDGET, ImportParseError, type ImportFormat, type ImportResult } from '../import/contracts';
import { parseImportInWorker } from '../import/worker-client';
import { RecoveryWorkbench } from '../options/RecoveryWorkbench';
import { ImportCheckpointStore, type ImportCheckpoint } from '../persistence/import-checkpoints';
import type { SettingsStore } from '../persistence/settings';
import type { AiServicesStore } from '../persistence/ai-services';
import { featureModelSettings } from '../adapters/feature-model-settings';
import type { ConfirmMutation } from '../schemas/messages';
import { ImportController, type ImportSubmission } from './import-controller';
import { ImportDrafts } from './import-drafts';
import { Select } from '../ui/Select';
import { WorkflowSteps } from '../ui/WorkflowSteps';

const formats: ImportFormat[] = ['html', 'json', 'csv', 'txt', 'markdown'];
export function ImportWorkbench({
  visible,
  settings,
  aiServices,
}: {
  visible: boolean;
  settings?: SettingsStore;
  aiServices?: AiServicesStore;
}) {
  const [drafts] = useState(() => new ImportDrafts());
  const [store] = useState(() => new ImportCheckpointStore());
  const owner = useRef<{ pipeline: ImportPipeline; controller: ImportController } | undefined>(undefined);
  const parsing = useRef<AbortController | undefined>(undefined);
  const flight = useRef(false);
  const [tree, setTree] = useState<TreeSnapshot>();
  const [rootId, setRootId] = useState('');
  const [format, setFormat] = useState<ImportFormat>('html');
  const [step, setStep] = useState(1);
  const [fileName, setFileName] = useState('');
  const [fileRevision, setFileRevision] = useState(0);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [source, setSource] = useState<ImportResult>();
  const [checkpoint, setCheckpoint] = useState<ImportCheckpoint>();
  const [records, setRecords] = useState<Awaited<ReturnType<ImportCheckpointStore['list']>>>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [destinations, setDestinations] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<ConfirmMutation>();
  const [submission, setSubmission] = useState<ImportSubmission>({ state: 'idle' });
  const result = submission.result;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('先选择书签文件，读取完成后点击下一步。');
  // User edits drop the unapplied preview locally; only the explicit pause button signals the worker.
  const invalidate = () => {
    owner.current?.controller.invalidatePreview();
    setPreview(undefined);
    setStep(current => (current === 4 ? 3 : current));
  };
  useEffect(() => {
    if (!settings || typeof chrome === 'undefined') return;
    const authority = browserModelAuthority(featureModelSettings(settings, aiServices, 'import'));
    const transport = new ModelTransport(
      { fetch: (...args) => fetch(...args), contains: request => chrome.permissions.contains(request) },
      authority,
    );
    const controller = new ImportController(undefined, undefined, store);
    const pipeline = new ImportPipeline(transport, authority, store, setCheckpoint);
    owner.current = { pipeline, controller };
    let active = true;
    let revision = 0;
    const stop = authority.subscribe(change => {
      const current = ++revision;
      // Tree changes only refresh the view: classification and a registered preview are judged by their scope owners.
      if (change !== 'tree') {
        pipeline.cancel();
        controller.invalidatePreview();
        setPreview(undefined);
        setMessage('模型设置或权限已变化；预览失效。请明确继续或重新分类，不会自动请求。');
      }
      void authority
        .read()
        .then(context => {
          if (active && current === revision) setTree(context.tree);
        })
        .catch(() => {
          if (active && current === revision) setTree(undefined);
        });
    });
    const initialRevision = ++revision;
    void authority
      .read()
      .then(context => {
        if (active && initialRevision === revision) setTree(context.tree);
      })
      .catch(() => {});
    return () => {
      active = false;
      stop();
      parsing.current?.abort();
      pipeline.dispose();
      controller.dispose();
      owner.current = undefined;
    };
  }, [settings, aiServices, store]);
  const run = async (operation: () => Promise<void>) => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      setMessage(
        error instanceof ImportParseError
          ? `${error.code}: ${error.message}`
          : error instanceof Error &&
              [
                'import-reclassification-required',
                'import-checkpoint-recovery-required',
                'invalid-import-target',
                'invalid-import-selection',
                'privacy-excluded',
                'invalid-import-folder',
                'stale-import-authority',
                'invalid-import-authority',
                'import-preview-rejected',
                'import-cancelled',
                'import-authority-unavailable',
                'import-authority-disconnected',
                'import-transport-unavailable',
                'unsupported-import-checkpoint',
                'import-checkpoint-unavailable',
              ].includes(error.message)
            ? `${error.message}：请核对目标、任务及恢复日志，再明确恢复或重新校验；不会自动重试。`
            : '操作未获确认；请保留任务并核对恢复记录，不会自动重试。',
      );
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  const load = (value: ImportCheckpoint) => {
    invalidate();
    setCheckpoint(value);
    const draft = drafts.updateItems(
      value.id,
      value.items.map(row => row.item.sourceOrdinal),
    );
    setSelected(draft.selected);
    setEdits(draft.edits);
    setDestinations(draft.destinations ?? {});
    setSubmission(owner.current?.controller.observe(value) ?? { state: value.requestId ? 'journal-owned' : 'idle' });
    setRootId(value.root.nativeId);
    setStep(value.requestId ? 4 : 3);
  };
  const classify = (action: 'start' | 'resume' | 'reclassify') =>
    run(async () => {
      const root = tree?.nodes.find(n => n.ref.nativeId === rootId)?.ref;
      if (!root || !tree || !owner.current) return;
      invalidate();
      setSubmission({ state: 'idle' });
      const pipeline = owner.current.pipeline;
      const selection = { root };
      const response =
        action === 'start' && source
          ? await pipeline.start({ ...selection, id: crypto.randomUUID(), source, format })
          : checkpoint && action === 'reclassify'
            ? await pipeline.reclassify(checkpoint.id, { ...selection, id: crypto.randomUUID() })
            : checkpoint
              ? await pipeline.resume(checkpoint.id, selection)
              : undefined;
      if (!response) return;
      if (response.checkpoint) {
        setCheckpoint(response.checkpoint);
        const draft = drafts.updateItems(
          response.checkpoint.id,
          response.checkpoint.items.map(row => row.item.sourceOrdinal),
        );
        setSelected(draft.selected);
        setEdits(draft.edits);
        setDestinations(draft.destinations ?? {});
        setStep(3);
      }
      setMessage(
        response.status === 'classified'
          ? '全量分类完成；请检查整批预览。'
          : `已暂停：${response.reason}。仅保留已提交的进度。`,
      );
    });
  const selection = checkpoint
    ? {
        root: checkpoint.root,
        selectedSourceOrdinals: selected,
        destinationEdits: selected
          .filter(id => Object.hasOwn(destinations, id))
          .map(sourceOrdinal => ({ sourceOrdinal, folderId: destinations[sourceOrdinal]! })),
        titleEdits: selected
          .filter(id => Object.hasOwn(edits, id))
          .map(sourceOrdinal => ({ sourceOrdinal, title: edits[sourceOrdinal]! })),
      }
    : undefined;
  const plan = preview;
  const emptyDestination = selected.some(id => destinations[id] === '');
  const path = (id: string): string => {
    const labels: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      const node =
        tree?.nodes.find(n => n.ref.nativeId === current) ?? checkpoint?.newFolders.find(n => n.id === current);
      if (!node) {
        labels.unshift(current);
        break;
      }
      labels.unshift(node.title || '根目录');
      current = node.parentId;
    }
    return labels.join(' / ');
  };
  const journalOwned = submission.state === 'journal-owned' || submission.state === 'uncertain';
  return (
    <section hidden={!visible} className="surface workflow-workbench" aria-label="导入工作台" aria-busy={busy}>
      <h2>导入书签</h2>
      <p>读取文件，让 AI 重新分类，检查后再添加到浏览器。</p>
      <WorkflowSteps labels={['选择文件', '选择目标', '检查预览', '确认导入']} current={step} />
      <div hidden={step !== 1} className="workflow-stage">
        <h3>选择要导入的书签文件</h3>
        <p className="hint">支持浏览器导出的 HTML，以及 JSON、CSV、TXT、Markdown 文件。</p>
        <label>
          导入格式
          <Select
            value={format}
            aria-label="导入格式"
            disabled={busy}
            onChange={e => {
              invalidate();
              setSource(undefined);
              setCheckpoint(undefined);
              setSelected([]);
              setEdits({});
              setDestinations({});
              setSubmission({ state: 'idle' });
              setFileName('');
              setFormat(e.target.value as ImportFormat);
              setStep(1);
              setMessage('格式已更改，请重新选择文件。');
            }}
          >
            {formats.map(value => (
              <option key={value}>{value}</option>
            ))}
          </Select>
        </label>
        <label>
          导入文件
          <input
            type="file"
            key={`${format}:${fileRevision}`}
            accept={{ html: '.html,.htm', json: '.json', csv: '.csv', txt: '.txt', markdown: '.md,.markdown' }[format]}
            className="workflow-file-input"
            disabled={busy}
            onChange={e => {
              const file = e.target.files?.[0];
              if (!file) return;
              void run(async () => {
                invalidate();
                setSource(undefined);
                setFileName(file.name);
                setCheckpoint(undefined);
                setSelected([]);
                setEdits({});
                setDestinations({});
                setSubmission({ state: 'idle' });
                if (file.size > IMPORT_RESOURCE_BUDGET.bytes)
                  throw new ImportParseError('resource', '文件超过已测量的 32MiB 解析保护预算；不截断。');
                const abort = new AbortController();
                parsing.current = abort;
                const bytes = new Uint8Array(await file.arrayBuffer());
                const parsed = await parseImportInWorker(bytes, format, abort.signal);
                setSource(parsed);
                setMessage(`文件已读取：${parsed.items.length} 条原始项。点击下一步选择存放目录。`);
              });
            }}
          />
        </label>
        {source && (
          <p className="workflow-summary">
            {fileName || '已读取文件'} · {source.items.length} 条原始项
          </p>
        )}
        {source && (
          <details className="workflow-help">
            <summary>查看文件中的原始条目</summary>
            {source.items.map(item => (
              <p key={item.sourceOrdinal}>
                来源 {item.sourceOrdinal} · {item.rawURL} · {item.diagnostic ?? '待分类'} ·{' '}
                {JSON.stringify(item.provenance)} · 原目录 {JSON.stringify(item.oldPath)}
              </p>
            ))}
          </details>
        )}
        <div className="workflow-footer">
          <button className="primary" disabled={busy || !source || !settings || !tree} onClick={() => setStep(2)}>
            下一步：选择目标目录
          </button>
        </div>
        {!settings && <p role="alert">请先在 AI 服务中配置模型，再开始导入分类。</p>}
        {!tree && settings && <p role="status">正在连接书签服务，请稍候…</p>}
      </div>
      <div hidden={step !== 2} className="workflow-stage">
        <h3>书签要放在哪里？</h3>
        <label>
          导入目标根
          <Select
            value={rootId}
            aria-label="导入目标根"
            disabled={busy}
            onChange={e => {
              invalidate();
              setRootId(e.target.value);
            }}
          >
            <option value="">请选择一个目录</option>
            {tree?.nodes
              .filter(n => n.ref.kind === 'folder' && n.childrenWritable)
              .map(n => (
                <option key={n.ref.nativeId} value={n.ref.nativeId}>
                  {path(n.ref.nativeId)}
                </option>
              ))}
          </Select>
        </label>
        <p className="hint">AI 会把文件中的书签重新分类到此目录下。检查预览后，才会创建书签。</p>
        <div className="workflow-footer">
          <button disabled={busy || journalOwned} onClick={() => setStep(1)}>
            上一步
          </button>
          <button
            className="primary"
            disabled={busy || !source || !rootId || !tree || !settings || !!checkpoint}
            onClick={() => void classify('start')}
          >
            {busy ? '正在分类…' : '下一步：AI 分类并预览'}
          </button>
        </div>
        {checkpoint &&
          (['resume', 'reclassify'] as const).map((action, index) => (
            <button
              className={index === 0 ? 'primary' : undefined}
              key={action}
              disabled={busy || journalOwned || !rootId || !tree}
              onClick={() => void classify(action)}
            >
              {['继续分类', '重新分类'][index]}
            </button>
          ))}
      </div>
      <p role="status">{message}</p>
      {(busy || checkpoint || preview) && (
        <button
          onClick={() => {
            parsing.current?.abort();
            owner.current?.pipeline.cancel();
            owner.current?.controller.cancel();
            setPreview(undefined);
            setMessage('已请求暂停；已发起写入结果须核对日志。');
          }}
        >
          暂停当前任务
        </button>
      )}
      <details className="workflow-help">
        <summary>继续以前的导入任务</summary>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setRecords(await store.list());
            })
          }
        >
          读取导入任务列表
        </button>
        {records.map(record => (
          <p key={record.id}>
            {record.id} · {record.phase} · {record.status}
            <button
              disabled={busy || record.status === 'unknown'}
              onClick={() =>
                void run(async () => {
                  const value = await store.get(record.id);
                  if (value) {
                    load(value);
                    setMessage(
                      value.requestId
                        ? '此任务已交给写入日志；请读取恢复记录核对，不可重新分类。'
                        : '已加载；仅在明确点击后继续。',
                    );
                  }
                })
              }
            >
              加载任务
            </button>
          </p>
        ))}
      </details>
      <div hidden={step < 3} className="workflow-stage">
        <h3>{step === 4 ? '确认导入内容' : '检查分类结果'}</h3>
        {step === 3 && checkpoint && checkpoint.phase !== 'classified' && (
          <p role="status">分类尚未完成。可以先查看已有条目，再点击继续分类。</p>
        )}
        {checkpoint && (
          <>
            <p className="workflow-summary">
              已分类 {checkpoint.classified.length} / {checkpoint.items.length} 条 · 已选 {selected.length} 条
            </p>
            {checkpoint.requestId && <p>日志请求：{checkpoint.requestId}。checkpoint 阶段不代表写入完成。</p>}
            <details className="workflow-help">
              <summary>任务和跳过项详情</summary>
              <p>
                任务 {checkpoint.id} · {checkpoint.runtime?.stage} · {checkpoint.phase} · 已映射{' '}
                {checkpoint.runtime?.mappedGroups.length ?? 0} 组
              </p>
              {importDiagnosticSources(checkpoint).map(({ diagnostic, item }, index) => (
                <p key={index}>
                  {'count' in diagnostic ? (
                    `${diagnostic.reason === 'unmapped-candidates' ? `忽略了 ${diagnostic.count} 个未映射字段` : `跳过了 ${diagnostic.count} 个缺少 URL 字段的元素`}：${diagnostic.reason}`
                  ) : (
                    <>
                      {item
                        ? `${item.rawURL} · 原始标题：${item.title} · 原目录：${JSON.stringify(item.oldPath)} · 来源路径：${JSON.stringify(item.provenance.sourcePath ?? [])} · `
                        : '旧任务缺少此跳过项的原始证据；无法还原 URL/标题/路径。'}
                      来源 {diagnostic.sourceOrdinal}：{diagnostic.reason}
                      {'retainedSourceOrdinal' in diagnostic ? `；保留来源 ${diagnostic.retainedSourceOrdinal}` : ''}
                    </>
                  )}
                </p>
              ))}
            </details>
            {step === 3 && !journalOwned && (
              <details className="workflow-help">
                <summary>重新调整分类</summary>
                <button disabled={busy} onClick={() => setStep(2)}>
                  更改目标或重新分类
                </button>
              </details>
            )}
            <div hidden={step !== 3}>
              <p className="hint">取消不想导入的书签，也可以调整标题和存放目录。</p>
              {checkpoint.items.map(({ item, titleLocked }) => (
                <article className="workflow-review-row" key={item.sourceOrdinal}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(item.sourceOrdinal)}
                      disabled={busy || journalOwned}
                      onChange={e => {
                        invalidate();
                        const next = e.target.checked
                          ? [...selected, item.sourceOrdinal]
                          : selected.filter(id => id !== item.sourceOrdinal);
                        drafts.set(checkpoint.id, { selected: next, edits, destinations });
                        setSelected(next);
                      }}
                    />
                    {item.title || item.rawURL}
                  </label>
                  <p className="hint">{item.rawURL}</p>
                  <details className="workflow-help">
                    <summary>原始内容详情</summary>
                    <p>
                      原始标题（{titleLocked ? 'AI 锁定' : '原文'}）：{item.title}；原目录：
                      {JSON.stringify(item.oldPath)}
                    </p>
                    <p>
                      来源 {item.sourceOrdinal} · {item.provenance.format} ·{' '}
                      {JSON.stringify(item.provenance.sourcePath)} · UTF-16 [{item.sourceSpan.start},{' '}
                      {item.sourceSpan.end})
                    </p>
                  </details>
                  <label>
                    <span>书签标题</span>
                    <input
                      aria-label={`明确编辑标题 ${item.sourceOrdinal}`}
                      value={
                        edits[item.sourceOrdinal] ??
                        checkpoint.classified.find(row => row.sourceOrdinal === item.sourceOrdinal)?.title ??
                        item.title
                      }
                      disabled={busy || journalOwned}
                      onChange={e => {
                        invalidate();
                        const next = { ...edits, [item.sourceOrdinal]: e.target.value };
                        drafts.set(checkpoint.id, { selected, edits: next, destinations });
                        setEdits(next);
                      }}
                    />
                  </label>
                  <label>
                    <span>存放目录</span>
                    <Select
                      aria-label={`明确调整目标 ${item.sourceOrdinal}`}
                      disabled={busy || journalOwned}
                      value={
                        destinations[item.sourceOrdinal] ??
                        checkpoint.classified.find(row => row.sourceOrdinal === item.sourceOrdinal)?.folderId ??
                        ''
                      }
                      onChange={e => {
                        invalidate();
                        const next = { ...destinations, [item.sourceOrdinal]: e.target.value };
                        drafts.set(checkpoint.id, { selected, edits, destinations: next });
                        setDestinations(next);
                      }}
                    >
                      <option value="">请选择目标</option>
                      {[
                        ...(tree?.nodes
                          .filter(n => eligibleImportDestination(tree, checkpoint.root.nativeId, n.ref.nativeId))
                          .map(n => n.ref.nativeId) ?? []),
                        ...checkpoint.newFolders.map(f => f.id),
                      ].map(id => (
                        <option key={id} value={id}>
                          {path(id)}
                        </option>
                      ))}
                    </Select>
                  </label>
                </article>
              ))}
            </div>
          </>
        )}
        {step === 3 &&
          source &&
          !checkpoint &&
          source.items.map(item => (
            <p key={item.sourceOrdinal}>
              来源 {item.sourceOrdinal} · {item.rawURL} · {item.diagnostic ?? '待分类'} ·{' '}
              {JSON.stringify(item.provenance)} · 原目录 {JSON.stringify(item.oldPath)}
            </p>
          ))}
        {plan?.command.type === 'batch' && (
          <>
            <p>
              所选 {selected.length}；实际新建书签{' '}
              {plan.command.operations.filter(o => o.command.type === 'create' && o.command.url !== undefined).length}
              ；所需目录{' '}
              {plan.command.operations.filter(o => o.command.type === 'create' && o.command.url === undefined).length}
            </p>
            <p>确认后将添加这些书签到浏览器。写入前会自动备份，请核对所选内容。</p>
            <details className="workflow-help">
              <summary>查看即将创建的书签和目录</summary>
              {plan.command.operations.map(operation => (
                <p key={operation.id}>
                  冻结步骤 {operation.id}：
                  {operation.command.type === 'create'
                    ? `${operation.command.title} · ${operation.command.url ?? '新目录'} · 目标 ${operation.command.parent.nativeId} · 依赖 ${operation.dependsOn.join(', ')}`
                    : operation.command.type}
                </p>
              ))}
            </details>
          </>
        )}
        {checkpoint?.phase === 'classified' && !plan && !journalOwned && (
          <p className="hint">检查完成后点击下一步，系统会核对重复项和目标目录。</p>
        )}
        {emptyDestination && <p role="status">请选择已勾选条目的目标，或取消勾选；空目标草稿不会发送预览请求。</p>}
        <div className="workflow-footer">
          <button
            disabled={busy || journalOwned}
            onClick={() => {
              if (step === 4) invalidate();
              setStep(step === 4 ? 3 : 2);
            }}
          >
            上一步
          </button>
          {step === 3 && checkpoint?.phase !== 'classified' && !journalOwned && (
            <button className="primary" disabled={busy || !rootId || !tree} onClick={() => void classify('resume')}>
              继续分类
            </button>
          )}
          <button
            hidden={step !== 3 || checkpoint?.phase !== 'classified'}
            className="primary"
            disabled={
              busy ||
              emptyDestination ||
              checkpoint?.phase !== 'classified' ||
              !tree ||
              !rootId ||
              rootId !== checkpoint.root.nativeId ||
              journalOwned
            }
            onClick={() =>
              void run(async () => {
                if (checkpoint && selection && owner.current) {
                  const request = await owner.current.controller.preview(checkpoint.id, checkpoint.revision, selection);
                  setPreview(request);
                  if (request) setStep(4);
                  setMessage(request ? '预览已核对，请确认导入。' : '所选内容已存在，无需导入。');
                }
              })
            }
          >
            下一步：确认导入
          </button>
          <button
            hidden={step !== 4 || journalOwned}
            className="primary"
            disabled={busy || !preview}
            onClick={() =>
              void run(async () => {
                if (!checkpoint || !owner.current) return;
                setPreview(undefined);
                await owner.current.controller.apply();
                const next = owner.current.controller.submission(checkpoint.id);
                setSubmission(next);
                if (next.state === 'rejected-before-handoff') setStep(3);
                setMessage(
                  next.state === 'rejected-before-handoff'
                    ? '已拒绝且持久任务确认未交接；请重新校验预览。'
                    : next.state === 'uncertain'
                      ? '结果不确定；保留同一请求，读取恢复日志核对，禁止重新创建。'
                      : '已交接日志；请根据实际状态及回执核对。',
                );
              })
            }
          >
            确认并导入书签
          </button>
        </div>
        {submission.request && (
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (owner.current && checkpoint)
                  setSubmission(await owner.current.controller.retrySubmission(checkpoint.id));
              })
            }
          >
            读取同一请求结果（日志去重，不新建请求）
          </button>
        )}
        {result && (
          <p>
            请求 {result.requestId}：{result.status}；原因 {result.reason ?? '无'}；完成 {result.completedSteps}，剩余{' '}
            {result.remainingSteps}；{result.needsReconcile ? '需要核对，禁止盲目重试' : '以日志回执为准'}。
          </p>
        )}
        {result?.status === 'completed' && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              invalidate();
              setSource(undefined);
              setCheckpoint(undefined);
              setSelected([]);
              setEdits({});
              setDestinations({});
              setSubmission({ state: 'idle' });
              setFileName('');
              setFileRevision(value => value + 1);
              setStep(1);
              setMessage('选择下一个书签文件，读取完成后点击下一步。');
            }}
          >
            导入另一个文件
          </button>
        )}
      </div>
      <details className="workflow-help">
        <summary>支持的文件与导入说明</summary>
        <p>
          支持 HTML、JSON、CSV、TXT、Markdown；不支持 Excel/PDF。文件编码为 UTF-8（可带 BOM）或带 BOM 的 UTF-16。只添加
          HTTP(S) 链接，不修改已有书签；AI 会重新分类，不保留旧目录结构。
        </p>
      </details>
      <details className="workflow-help" onToggle={e => setRecoveryOpen(e.currentTarget.open)}>
        <summary>恢复与撤销记录</summary>
        <RecoveryWorkbench visible={visible && recoveryOpen} />
      </details>
    </section>
  );
}
