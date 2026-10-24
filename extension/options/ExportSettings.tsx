import { useEffect, useMemo, useRef, useState } from 'react';
import { WorkflowSteps } from '../ui/WorkflowSteps';
import { ExportTreeSelector } from './ExportTreeSelector';
import { createExportProjection, type ExportScope } from '../domain/export-projection';
import type { NodeRef, TreeState } from '../domain/node-reference';
import { fileOutputAncestry } from '../domain/file-output-scope';
import { serializeExportHTML, serializeExportJSON, serializeExportMarkdown } from '../export/serializers';
import { configureFileOutput, sendFileOutputCommand, fileOutputRefusal } from '../export/file-output-control';
import { FileOutputStore, type FileOutputRecord, type OutputFileHandle } from '../persistence/file-output';
import { connectTree } from '../panel/tree-client';
import { useI18n } from '../ui/i18n';

type GestureHandle = OutputFileHandle & {
  name?: string;
  requestPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState>;
};
type PickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<GestureHandle>;
};
const serializers = { JSON: serializeExportJSON, HTML: serializeExportHTML, Markdown: serializeExportMarkdown };
const extensions = { JSON: 'json', HTML: 'html', Markdown: 'md' };
const sameRef = (a: NodeRef, b: NodeRef) =>
  a.nativeId === b.nativeId && a.installationId === b.installationId && a.kind === b.kind;

/** Retained by App across navigation. Only explicit manual downloads write in this page;
 * automatic files belong exclusively to the worker, including initial catchup. */
export function ExportSettings({ visible }: { visible: boolean }) {
  const { t, message: translateMessage } = useI18n();
  const [store] = useState(() => new FileOutputStore());
  const [tree, setTree] = useState<TreeState>({ status: 'loading' });
  const currentTree = useRef(tree);
  currentTree.current = tree;
  const [scope, setScope] = useState<ExportScope>({ roots: [], excludedFolders: [] });
  const [step, setStep] = useState(1);
  const [format, setFormat] = useState<keyof typeof serializers>('HTML');
  const [consent, setConsent] = useState(false);
  const [record, setRecord] = useState<FileOutputRecord>();
  const [candidate, setCandidate] = useState<GestureHandle>();
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  const [message, setMessage] = useState<string | { format: keyof typeof serializers }>();
  const framed = typeof window !== 'undefined' && window.top !== window;
  const panelDocument = typeof location !== 'undefined' && /panel\/index\.html$/.test(location.pathname);
  const supported =
    !framed &&
    !panelDocument &&
    typeof (window as PickerWindow).showSaveFilePicker === 'function' &&
    typeof indexedDB !== 'undefined';
  async function refresh() {
    const version = ++revision.current;
    try {
      const value = await store.read();
      if (mounted.current && version === revision.current) setRecord(value);
    } catch {
      if (mounted.current && version === revision.current)
        setMessage('无法读取文件配置；已停止页面操作，请检查存储后刷新状态。');
    }
  }
  useEffect(() => {
    mounted.current = true;
    const stop =
      typeof chrome !== 'undefined' && typeof chrome.runtime?.connect === 'function'
        ? connectTree(chrome.runtime, setTree)
        : undefined;
    void refresh();
    return () => {
      mounted.current = false;
      revision.current++;
      stop?.();
    };
    // The store is page-local and stable; refresh is never an automatic writer.
  }, [store]);
  const nodes = tree.status === 'ready' ? tree.snapshot.nodes : [];
  const snapshot = tree.status === 'ready' ? tree.snapshot : undefined;
  // Projection validation walks the whole tree; recompute only when the snapshot identity or the scope changes, not on every render.
  const selection = useMemo(() => {
    try {
      if (!snapshot) throw Error('loading');
      const projection = createExportProjection(snapshot, scope, new Date().toISOString());
      let bookmarks = 0;
      let folders = 0;
      const pending = [...projection.document.roots];
      while (pending.length) {
        const node = pending.pop()!;
        if (node.type === 'bookmark') bookmarks++;
        else {
          folders++;
          pending.push(...node.children);
        }
      }
      return { error: '', bookmarks, folders };
    } catch {
      return { error: '请勾选要导出的内容。若所选目录已被删除，请重新选择。', bookmarks: 0, folders: 0 };
    }
  }, [snapshot, scope]);
  const scopeError = selection.error;
  function begin() {
    if (locked.current) return false;
    locked.current = true;
    revision.current++;
    setBusy(true);
    return true;
  }
  function finish() {
    locked.current = false;
    if (mounted.current) setBusy(false);
  }
  function manual(format: keyof typeof serializers) {
    try {
      if (currentTree.current.status !== 'ready') throw Error('tree');
      const projection = createExportProjection(currentTree.current.snapshot, scope, new Date().toISOString());
      const text = serializers[format](projection);
      const url = URL.createObjectURL(
        new Blob([text], {
          type:
            format === 'HTML'
              ? 'text/html;charset=utf-8'
              : format === 'JSON'
                ? 'application/json;charset=utf-8'
                : 'text/markdown;charset=utf-8',
        }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `bookmarks.${extensions[format]}`;
      anchor.rel = 'noopener';
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setMessage({ format });
    } catch {
      setMessage('导出被拒绝：请重新选择有效范围，或缩小过大的范围。');
    }
  }
  function pick() {
    if (!supported || !consent || scopeError || document.visibilityState === 'hidden' || !begin()) return;
    // The picker is invoked synchronously in the actual click turn, before any IDB/read await.
    try {
      const pending = (window as PickerWindow).showSaveFilePicker!({
        suggestedName: 'bookmarks.json',
        types: [{ description: t('JSON 专用输出'), accept: { 'application/json': ['.json'] } }],
      });
      void pending
        .then(
          handle => {
            if (mounted.current) {
              setCandidate(handle);
              setMessage('已选择候选文件；请点击授权并启用。现有目标尚未替换。');
            }
          },
          error => {
            if (mounted.current)
              setMessage(
                error instanceof DOMException && error.name === 'AbortError'
                  ? '已取消选择，现有输出目标不变。'
                  : '文件选择失败，现有输出目标不变。',
              );
          },
        )
        .finally(finish);
    } catch {
      setMessage('无法打开文件选择器，现有输出目标不变。');
      finish();
    }
  }
  function authorize(replace: boolean) {
    const handle: GestureHandle | undefined = replace ? candidate : record?.handle;
    if (
      !consent ||
      !handle?.requestPermission ||
      (replace && scopeError) ||
      document.visibilityState === 'hidden' ||
      !begin()
    )
      return;
    const generation = record?.generation;
    // Cached same-origin handle: requestPermission must not follow an asynchronous storage read.
    try {
      const permission = handle.requestPermission({ mode: 'readwrite' });
      void permission
        .then(async granted => {
          if (!mounted.current) return;
          if (granted !== 'granted') {
            setMessage('权限未授予，未启用或重试写入。请明确重新授权。');
            return;
          }
          if (replace) {
            const latest = currentTree.current;
            if (latest.status !== 'ready') throw Error('tree');
            createExportProjection(latest.snapshot, scope, new Date().toISOString());
            await configureFileOutput(handle, latest.snapshot, scope, store);
            if (mounted.current) setCandidate(undefined);
          } else {
            const latest = await store.read();
            if (!latest || latest.generation !== generation || !latest.enabled || latest.status === 'scope-invalid')
              throw Error('target-changed');
            const source = currentTree.current;
            if (
              source.status !== 'ready' ||
              JSON.stringify(fileOutputAncestry(source.snapshot, latest.scope)) !== JSON.stringify(latest.ancestry)
            )
              throw Error('scope');
            await sendFileOutputCommand({
              version: 1,
              type: 'fileOutput',
              action: 'retry',
              ticket: crypto.randomUUID(),
              expectedGeneration: latest.generation,
              expectedRevision: latest.controlRevision,
            });
          }
          if (mounted.current) {
            setMessage('后台已接受本次补写请求；不代表文件写入成功，请刷新状态查看持久回执。');
            await refresh();
          }
        })
        .catch(async error => {
          if (mounted.current) {
            setMessage(fileOutputRefusal(error));
            await refresh();
          }
        })
        .finally(finish);
    } catch {
      setMessage('授权失败，请使用可见页面重新授权。');
      finish();
    }
  }
  async function stop() {
    if (!begin()) return;
    try {
      await sendFileOutputCommand({ version: 1, type: 'fileOutput', action: 'stop', ticket: crypto.randomUUID() });
      await refresh();
      setMessage('已接受停止请求并撤销待启用配置；已发出的文件关闭无法撤回。');
    } catch (error) {
      setMessage(fileOutputRefusal(error));
    } finally {
      finish();
    }
  }
  const label = (ref: NodeRef) =>
    nodes.find(n => sameRef(n.ref, ref))?.title ?? t('失效内容 {id}', { id: ref.nativeId });
  return (
    <section hidden={!visible} className="surface workflow-workbench" aria-label={t('导出设置')} aria-busy={busy}>
      <h2>{t('导出书签')}</h2>
      <WorkflowSteps labels={[t('选择内容'), t('选择格式'), t('确认导出')]} current={step} />
      <div hidden={step !== 1} className="workflow-stage">
        <h3>{t('选择要导出的内容')}</h3>

        {tree.status === 'loading' && <p role="status">{t('正在读取书签…')}</p>}
        {tree.status === 'error' && <p role="alert">{translateMessage(tree.message)}</p>}
        {snapshot && <ExportTreeSelector tree={snapshot} scope={scope} disabled={busy} onChange={setScope} />}
        <div className="workflow-footer">
          <span className="hint">{t('已选 {bookmarks} 条书签 · {folders} 个目录', selection)}</span>
          <button disabled={busy || !scope.roots.length} onClick={() => setScope({ roots: [], excludedFolders: [] })}>
            {t('清空选择')}
          </button>
          <button className="primary" disabled={busy || !!scopeError} onClick={() => setStep(2)}>
            {t('下一步：选择格式')}
          </button>
        </div>
      </div>
      <div hidden={step !== 2} className="workflow-stage">
        <h3>{t('选择导出格式')}</h3>
        <div className="workflow-choices">
          {(['HTML', 'Markdown', 'JSON'] as const).map(value => (
            <label className="workflow-choice" key={value}>
              <input
                type="radio"
                name="export-format"
                checked={format === value}
                disabled={busy}
                onChange={() => setFormat(value)}
              />
              <span>
                <strong>
                  {value}
                  {value === 'HTML' ? t('（推荐）') : ''}
                </strong>
                <small>
                  {value === 'HTML'
                    ? t('可导入 Chrome、Edge 等浏览器')
                    : value === 'Markdown'
                      ? t('适合阅读、笔记和分享')
                      : t('保留完整书签数据，便于再次导入')}
                </small>
              </span>
            </label>
          ))}
        </div>
        <div className="workflow-footer">
          <button disabled={busy} onClick={() => setStep(1)}>
            {t('上一步')}
          </button>
          <button className="primary" disabled={busy || !!scopeError} onClick={() => setStep(3)}>
            {t('下一步：确认导出')}
          </button>
        </div>
      </div>
      <div hidden={step !== 3} className="workflow-stage">
        <h3>{t('确认并下载')}</h3>
        <p className="workflow-summary">
          {t('{bookmarks} 条书签 · {folders} 个目录 · {format} 格式', { ...selection, format })}
        </p>

        <div className="workflow-footer">
          <button disabled={busy} onClick={() => setStep(2)}>
            {t('上一步')}
          </button>
          <button className="primary" disabled={busy || !!scopeError} onClick={() => manual(format)}>
            {t('下载 {format}', { format })}
          </button>
        </div>
      </div>
      {scopeError && !!scope.roots.length && <p role="alert">{translateMessage(scopeError)}</p>}
      {message !== undefined && (
        <p role="status">
          {typeof message === 'string'
            ? translateMessage(message)
            : t('已发起 {format} 下载；请在浏览器下载记录中确认完成。', message)}
        </p>
      )}
      <details className="workflow-help">
        <summary>{t('自动更新 JSON 文件（可选）')}</summary>
        <h3>{t('自动 JSON 专用文件')}</h3>
        <p className="organize-notice">{t('提醒：授权后会持续覆盖这个文件；浏览器关闭时不会更新。')}</p>
        <label className="check">
          <input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} />
          {t('我同意专用输出覆盖规则')}
        </label>
        {!supported && (
          <p role="alert">{t('此环境不支持自动文件选择或持久句柄；仍可手动下载。不承诺后台文件输出。')}</p>
        )}
        <p>
          {t('当前文件：{name}', {
            name:
              (record?.handle as GestureHandle | undefined)?.name ??
              (record ? t('已授权文件（名称不可用）') : t('未配置')),
          })}
        </p>
        <p>
          {t('当前输出根：{roots}；排除：{excluded}', {
            roots: record?.scope.roots.map(label).join('、') || t('无'),
            excluded:
              [...(record?.scope.excludedFolders ?? []), ...(record?.scope.excludedBookmarks ?? [])]
                .map(label)
                .join('、') || t('无'),
          })}
        </p>
        <p>
          {t('持久状态：{status}；最近成功：{time}', {
            status: record?.status ?? t('未配置'),
            time: record?.lastSuccess ?? t('无'),
          })}
        </p>
        {record && ['paused', 'needs-permission', 'scope-invalid'].includes(record.status) && (
          <p role="alert">{t('输出已暂停：请重新授权文件，或重新选择导出范围。')}</p>
        )}
        <div className="actions">
          <button disabled={busy || !supported || !consent || !!scopeError} onClick={pick}>
            {t('选择专用 JSON 文件')}
          </button>
          {candidate && (
            <>
              <span>{t('候选文件：{name}', { name: candidate.name ?? t('名称不可用') })}</span>
              <button
                disabled={busy || !consent || !!scopeError || !candidate.requestPermission}
                onClick={() => authorize(true)}
              >
                {t('授权并启用所选文件')}
              </button>
              <button disabled={busy} onClick={() => setCandidate(undefined)}>
                {t('放弃候选文件')}
              </button>
            </>
          )}
          {candidate && !candidate.requestPermission && (
            <p role="alert">{t('此句柄不支持显式授权，不能启用自动输出。')}</p>
          )}
          <button
            disabled={
              busy ||
              !consent ||
              !record?.enabled ||
              record.status === 'scope-invalid' ||
              !(record.handle as GestureHandle).requestPermission
            }
            onClick={() => authorize(false)}
          >
            {t('重新授权并补写当前快照')}
          </button>
          <button disabled={busy || !supported} onClick={() => void stop()}>
            {t('停止自动输出')}
          </button>
          <button disabled={busy} onClick={() => void refresh()}>
            {t('刷新输出状态')}
          </button>
        </div>
      </details>
    </section>
  );
}
