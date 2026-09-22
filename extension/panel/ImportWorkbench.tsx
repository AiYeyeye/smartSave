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
import type { ConfirmMutation } from '../schemas/messages';
import { ImportController, type ImportSubmission } from './import-controller';
import { ImportDrafts } from './import-drafts';
import { Select } from '../ui/Select';

const formats: ImportFormat[] = ['html', 'json', 'csv', 'txt', 'markdown'];
export function ImportWorkbench({ visible, settings }: { visible: boolean; settings?: SettingsStore }) {
  const [drafts] = useState(() => new ImportDrafts());
  const [store] = useState(() => new ImportCheckpointStore());
  const owner = useRef<{ pipeline: ImportPipeline; controller: ImportController } | undefined>(undefined);
  const parsing = useRef<AbortController | undefined>(undefined);
  const flight = useRef(false);
  const [tree, setTree] = useState<TreeSnapshot>();
  const [rootId, setRootId] = useState('');
  const [format, setFormat] = useState<ImportFormat>('html');
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
  const [message, setMessage] = useState('选择格式、文件和一个目标根目录。不会自动调用模型或重放任务。');
  const invalidate = () => {
    owner.current?.controller.cancel();
    setPreview(undefined);
  };
  useEffect(() => {
    if (!settings || typeof chrome === 'undefined') return;
    const authority = browserModelAuthority(settings);
    const transport = new ModelTransport(
      { fetch: (...args) => fetch(...args), contains: request => chrome.permissions.contains(request) },
      authority,
    );
    const controller = new ImportController(undefined, undefined, store);
    const pipeline = new ImportPipeline(transport, authority, store, setCheckpoint);
    owner.current = { pipeline, controller };
    let active = true;
    let revision = 0;
    const stop = authority.subscribe(() => {
      const current = ++revision;
      pipeline.cancel();
      controller.cancel();
      setPreview(undefined);
      setMessage('上下文已变化；预览失效。请明确恢复或重新分类，不会自动请求。');
      void authority
        .read()
        .then(context => {
          if (active && current === revision) setTree(context.tree);
        })
        .catch(() => {
          if (active) setTree(undefined);
        });
    });
    void authority
      .read()
      .then(context => {
        if (active) setTree(context.tree);
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
  }, [settings, store]);
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
  };
  const classify = (action: 'start' | 'resume' | 'recover' | 'reclassify') =>
    run(async () => {
      const root = tree?.nodes.find(n => n.ref.nativeId === rootId)?.ref;
      if (!root || !tree || !owner.current) return;
      invalidate();
      setSubmission({ state: 'idle' });
      const pipeline = owner.current.pipeline;
      const selection = { root, tree };
      const response =
        action === 'start' && source
          ? await pipeline.start({ ...selection, id: crypto.randomUUID(), source, format })
          : checkpoint && action === 'reclassify'
            ? await pipeline.reclassify(checkpoint.id, { ...selection, id: crypto.randomUUID() })
            : checkpoint && action === 'recover'
              ? await pipeline.recover(checkpoint.id, selection)
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
    <section hidden={!visible} className="surface" aria-label="导入工作台" aria-busy={busy}>
      <h2>导入并全量重新分类</h2>
      <p>
        从外部文件添加书签，与浏览器现有书签目录不同。支持 HTML、JSON、CSV、TXT、Markdown；不支持 Excel/PDF。UTF-8（可带
        BOM）或带 BOM 的 UTF-16。仅 HTTP(S) 可新建；不会保留旧目录结构或修改已有书签。
      </p>
      <label>
        导入格式
        <Select
          value={format}
          disabled={busy}
          onChange={e => {
            invalidate();
            setSource(undefined);
            setFormat(e.target.value as ImportFormat);
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
          disabled={busy}
          onChange={e => {
            const file = e.target.files?.[0];
            if (!file) return;
            void run(async () => {
              invalidate();
              setSource(undefined);
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
              setMessage(
                `解析完成：${parsed.encoding}，${parsed.items.length} 条原始项，${parsed.candidates.length} 个来源字段。`,
              );
            });
          }}
        />
      </label>
      <label>
        导入目标根
        <Select
          value={rootId}
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
      <p role="status">{message}</p>
      <button
        disabled={busy || !source || !rootId || !tree || !settings || !!checkpoint}
        onClick={() => void classify('start')}
      >
        明确请求 AI 全量分类
      </button>
      <button
        onClick={() => {
          parsing.current?.abort();
          owner.current?.pipeline.cancel();
          invalidate();
          setMessage('已请求暂停；已发起写入结果须核对日志。');
        }}
      >
        暂停分类 / 取消授权及未发起写入
      </button>
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
      {checkpoint && (
        <>
          <h3>任务 {checkpoint.id}</h3>
          <p>
            {checkpoint.runtime?.stage} · {checkpoint.phase} · 已分类 {checkpoint.classified.length} /{' '}
            {checkpoint.items.length}；已映射 {checkpoint.runtime?.mappedGroups.length ?? 0} 组
          </p>
          {checkpoint.requestId && <p>日志请求：{checkpoint.requestId}。checkpoint 阶段不代表写入完成。</p>}
          {(['resume', 'recover', 'reclassify'] as const).map((action, index) => (
            <button
              key={action}
              disabled={busy || journalOwned || !rootId || !tree}
              onClick={() => void classify(action)}
            >
              {['手动继续剩余分类', '服务重启后明确恢复并重新校验', '保留旧证据并重新分类'][index]}
            </button>
          ))}
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
          {checkpoint.items.map(({ item, titleLocked }) => (
            <article key={item.sourceOrdinal}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(item.sourceOrdinal)}
                  disabled={busy}
                  onChange={e => {
                    invalidate();
                    const next = e.target.checked
                      ? [...selected, item.sourceOrdinal]
                      : selected.filter(id => id !== item.sourceOrdinal);
                    drafts.set(checkpoint.id, { selected: next, edits, destinations });
                    setSelected(next);
                  }}
                />
                {item.rawURL}
              </label>
              <p>
                原始标题（{titleLocked ? 'AI 锁定' : '原文'}）：{item.title}；原目录：{JSON.stringify(item.oldPath)}
              </p>
              <p>
                来源 {item.sourceOrdinal} · {item.provenance.format} · {JSON.stringify(item.provenance.sourcePath)} ·
                UTF-16 [{item.sourceSpan.start}, {item.sourceSpan.end})
              </p>
              <label>
                明确编辑标题 {item.sourceOrdinal}
                <input
                  value={
                    edits[item.sourceOrdinal] ??
                    checkpoint.classified.find(row => row.sourceOrdinal === item.sourceOrdinal)?.title ??
                    item.title
                  }
                  disabled={busy}
                  onChange={e => {
                    invalidate();
                    const next = { ...edits, [item.sourceOrdinal]: e.target.value };
                    drafts.set(checkpoint.id, { selected, edits: next, destinations });
                    setEdits(next);
                  }}
                />
              </label>
              <label>
                明确调整目标 {item.sourceOrdinal}
                <Select
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
        </>
      )}
      {source &&
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
          {plan.command.operations.map(operation => (
            <p key={operation.id}>
              冻结步骤 {operation.id}：
              {operation.command.type === 'create'
                ? `${operation.command.title} · ${operation.command.url ?? '新目录'} · 目标 ${operation.command.parent.nativeId} · 依赖 ${operation.dependsOn.join(', ')}`
                : operation.command.type}
            </p>
          ))}
        </>
      )}
      {checkpoint?.phase === 'classified' && !plan && (
        <p>尚未校验整批预览；请点击校验。空选择或全部重复不会创建空目录。</p>
      )}
      {emptyDestination && <p role="status">请选择已勾选条目的目标，或取消勾选；空目标草稿不会发送预览请求。</p>}
      <button
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
              setMessage(request ? '整批预览已校验；仅一次确认后写入。' : '无新项；零写入。');
            }
          })
        }
      >
        校验所选整批预览
      </button>
      <button
        disabled={busy || !preview}
        onClick={() =>
          void run(async () => {
            if (!checkpoint || !owner.current) return;
            setPreview(undefined);
            await owner.current.controller.apply();
            const next = owner.current.controller.submission(checkpoint.id);
            setSubmission(next);
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
        一次确认并应用整批
      </button>
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
      <RecoveryWorkbench />
    </section>
  );
}
