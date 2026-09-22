import { useEffect, useMemo, useRef, useState } from 'react';
import { createExportProjection, type ExportScope } from '../domain/export-projection';
import type { NodeRef, TreeState } from '../domain/node-reference';
import { fileOutputAncestry } from '../domain/file-output-scope';
import { serializeExportHTML, serializeExportJSON, serializeExportMarkdown } from '../export/serializers';
import { configureFileOutput, sendFileOutputCommand, fileOutputRefusal } from '../export/file-output-control';
import { FileOutputStore, type FileOutputRecord, type OutputFileHandle } from '../persistence/file-output';
import { connectTree } from '../panel/tree-client';

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
  const [store] = useState(() => new FileOutputStore());
  const [tree, setTree] = useState<TreeState>({ status: 'loading' });
  const currentTree = useRef(tree);
  currentTree.current = tree;
  const [scope, setScope] = useState<ExportScope>({ roots: [], excludedFolders: [] });
  const [consent, setConsent] = useState(false);
  const [record, setRecord] = useState<FileOutputRecord>();
  const [candidate, setCandidate] = useState<GestureHandle>();
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  const [message, setMessage] = useState('请选择导出目录；导出排除与 AI 设置相互独立。');
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
  const folders =
    tree.status === 'ready' ? tree.snapshot.nodes.filter(n => n.ref.kind === 'folder' && n.parentId !== undefined) : [];
  const snapshot = tree.status === 'ready' ? tree.snapshot : undefined;
  // Projection validation walks the whole tree; recompute only when the snapshot identity or the scope changes, not on every render.
  const scopeError = useMemo(() => {
    try {
      if (!snapshot) throw Error('loading');
      createExportProjection(snapshot, scope, new Date().toISOString());
      return '';
    } catch {
      return '范围无效或书签尚未就绪：请明确选择现有目录，不会自动替换已删除的根。';
    }
  }, [snapshot, scope]);
  function toggle(field: keyof ExportScope, ref: NodeRef, checked: boolean) {
    setScope(old => ({
      ...old,
      [field]: checked ? [...old[field], ref] : old[field].filter(value => !sameRef(value, ref)),
    }));
  }
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
      setMessage(`已发起 ${format} 下载；请在浏览器下载记录中确认完成。`);
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
        types: [{ description: 'JSON 专用输出', accept: { 'application/json': ['.json'] } }],
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
  const label = (ref: NodeRef) => folders.find(n => sameRef(n.ref, ref))?.title ?? `失效目录 ${ref.nativeId}`;
  return (
    <section hidden={!visible} className="surface" aria-label="导出设置" aria-busy={busy}>
      <h2>导出书签</h2>
      <p>
        JSON、HTML、Markdown 使用同一只读快照；保留原始 URL 和空目录，不包含模型、密钥、规则或日志。不是完整恢复备份。
      </p>
      <fieldset disabled={busy}>
        <legend>导出范围（独立于 AI）</legend>
        {folders.map(node => (
          <div key={node.ref.nativeId}>
            <span>
              {node.title || '未命名目录'}（{node.ref.nativeId}）
            </span>
            <label>
              <input
                type="checkbox"
                aria-label={`导出 ${node.title}`}
                checked={scope.roots.some(ref => sameRef(ref, node.ref))}
                onChange={e => toggle('roots', node.ref, e.target.checked)}
              />
              包含目录
            </label>
            <label>
              <input
                type="checkbox"
                aria-label={`排除 ${node.title}`}
                checked={scope.excludedFolders.some(ref => sameRef(ref, node.ref))}
                onChange={e => toggle('excludedFolders', node.ref, e.target.checked)}
              />
              排除子树
            </label>
          </div>
        ))}
        <p>
          已选根：{scope.roots.map(label).join('、') || '无'}；排除：
          {scope.excludedFolders.map(label).join('、') || '无'}
        </p>
        <button onClick={() => setScope({ roots: [], excludedFolders: [] })}>清空范围并重新选择</button>
      </fieldset>
      {scopeError && <p role="alert">{scopeError}</p>}
      <div className="actions">
        {(Object.keys(serializers) as (keyof typeof serializers)[]).map(format => (
          <button key={format} disabled={busy || !!scopeError} onClick={() => manual(format)}>
            下载 {format}
          </button>
        ))}
      </div>
      <h3>自动 JSON 专用文件</h3>
      <p>
        首次授权后会覆盖此专用输出文件及外部修改，不反向同步，不逐次确认，不自动换路径。后台是唯一自动写入者；浏览器关闭时不运行。文件关闭成功且持久回执匹配后才记录成功；中断可能已更新文件但没有成功回执。
      </p>
      <label>
        <input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} />
        我同意专用输出覆盖规则
      </label>
      {!supported && <p role="alert">此环境不支持自动文件选择或持久句柄；仍可手动下载。不承诺后台文件输出。</p>}
      <p>
        当前文件：
        {(record?.handle as GestureHandle | undefined)?.name ?? (record ? '已授权文件（名称不可用）' : '未配置')}
      </p>
      <p>
        当前输出根：{record?.scope.roots.map(label).join('、') || '无'}；排除：
        {record?.scope.excludedFolders.map(label).join('、') || '无'}
      </p>
      <p>
        持久状态：{record?.status ?? '未配置'}；最近成功：{record?.lastSuccess ?? '无'}
      </p>
      {record && ['paused', 'needs-permission', 'scope-invalid'].includes(record.status) && (
        <p role="alert">
          输出已暂停。权限或文件错误请明确重新授权；范围失效请清空并重新选择目录，再选择文件启用。不会自动重试或回退全树。
        </p>
      )}
      <div className="actions">
        <button disabled={busy || !supported || !consent || !!scopeError} onClick={pick}>
          选择专用 JSON 文件
        </button>
        {candidate && (
          <>
            <span>候选文件：{candidate.name ?? '名称不可用'}</span>
            <button
              disabled={busy || !consent || !!scopeError || !candidate.requestPermission}
              onClick={() => authorize(true)}
            >
              授权并启用所选文件
            </button>
            <button disabled={busy} onClick={() => setCandidate(undefined)}>
              放弃候选文件
            </button>
          </>
        )}
        {candidate && !candidate.requestPermission && <p role="alert">此句柄不支持显式授权，不能启用自动输出。</p>}
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
          重新授权并补写当前快照
        </button>
        <button disabled={busy || !supported} onClick={() => void stop()}>
          停止自动输出
        </button>
        <button disabled={busy} onClick={() => void refresh()}>
          刷新输出状态
        </button>
      </div>
      <p role="status">{message}</p>
    </section>
  );
}
