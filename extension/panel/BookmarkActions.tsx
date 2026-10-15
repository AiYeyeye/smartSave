import { useEffect, useRef, useState, type Ref } from 'react';
import { useI18n } from '../ui/i18n';
import type { TreeSnapshot } from '../domain/node-reference';
import { preflight } from '../domain/preflight';
import type { Command, ConfirmMutation, MutationResult } from '../schemas/messages';
import { ImpactConfirmDialog } from '../ui/ImpactConfirmDialog';
import { Select } from '../ui/Select';
import { BusyIndicator } from '../ui/BusyIndicator';
import { prepareMove, prepareMutation } from './TreeDragController';
import { submitMutation, type SendMutation } from './mutation-client';

export type Mode = 'bookmark' | 'folder' | 'edit' | 'move' | 'delete';
type Draft = {
  mode: Mode;
  snapshot: TreeSnapshot;
  selectedId: string;
  title: string;
  url: string;
  parentId: string;
  index: number;
  folderTitle: string;
  newFolder: boolean;
};
export function MutationFeedback({ result }: { result: MutationResult }) {
  const { t, message } = useI18n();
  const labels = {
    completed: '已完成',
    rejected: '未执行操作，请检查连接或重新操作',
    failed: '失败，未完成',
    partial: '部分完成，后续操作已停止',
    unknown: '结果未知，请检查操作记录，勿重复提交',
  };
  return (
    <p role={result.status === 'completed' ? 'status' : 'alert'}>
      {t('{status} · 已完成 {completed} 步 / 剩余 {remaining} 步', {
        status: message(labels[result.status]),
        completed: result.completedSteps,
        remaining: result.remainingSteps,
      })}
      {result.needsReconcile && t(' · 需要协调检查')}
      {result.reason === 'invalid-sender' && t(' · 侧边栏授权尚未恢复，请等待连接恢复后重新操作')}
      {result.reason === 'preview-unavailable' && t(' · 操作准备失败，请重新选择目标')}
      <small>{t('请求编号：{id}', { id: result.requestId })}</small>
    </p>
  );
}
export function BookmarkActions({
  snapshot,
  selectedId,
  send,
  interactionBlocked = false,
  onInteractionChange,
  hideCommands = false,
  initialMode,
  containerRef,
}: {
  snapshot: TreeSnapshot;
  selectedId: string | undefined;
  send?: SendMutation;
  interactionBlocked?: boolean;
  onInteractionChange?: (active: boolean, busy: boolean) => void;
  hideCommands?: boolean;
  initialMode?: Mode;
  containerRef?: Ref<HTMLElement>;
}) {
  const { t, message } = useI18n();
  const [draft, setDraft] = useState<Draft>();
  const [result, setResult] = useState<MutationResult>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const started = useRef('');
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    onInteractionChange?.(!!draft || busy, busy);
  }, [draft, busy, onInteractionChange]);
  const selected = snapshot.nodes.find(n => n.ref.nativeId === selectedId);
  useEffect(() => {
    if (!draft || draft.mode === 'delete') return;
    const node = form.current;
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
    node?.querySelector<HTMLElement>('input,select,textarea')?.focus();
  }, [draft?.mode, draft?.selectedId]);
  function begin(mode: Mode) {
    if (!selected || lock.current || interactionBlocked) return;
    if ((mode === 'edit' || mode === 'move' || mode === 'delete') && selected.readOnly) return;
    setResult(undefined);
    setDraft({
      mode,
      snapshot: structuredClone(snapshot),
      selectedId: selected.ref.nativeId,
      title: mode === 'edit' ? selected.title : '',
      url: mode === 'edit' ? (selected.url ?? '') : '',
      parentId: mode === 'move' ? '' : selected.ref.nativeId,
      index: 0,
      folderTitle: '',
      newFolder: false,
    });
  }
  useEffect(() => {
    const key = initialMode && selectedId ? `${selectedId}:${initialMode}` : '';
    if (key && initialMode && started.current !== key) {
      started.current = key;
      begin(initialMode);
    }
    if (!key) started.current = '';
  }, [initialMode, selectedId]);
  function requestFor(d: Draft): ConfirmMutation {
    const node = d.snapshot.nodes.find(n => n.ref.nativeId === d.selectedId)!;
    let command: Command;
    if (d.mode === 'move') return prepareMove(d.snapshot, d.selectedId, d.parentId, d.index);
    if (d.mode === 'edit')
      command = {
        type: 'update',
        target: node.ref,
        changes: { title: d.title, ...(node.ref.kind === 'bookmark' && d.url !== node.url ? { url: d.url } : {}) },
      };
    else if (d.mode === 'delete')
      command = { type: node.ref.kind === 'folder' ? 'deleteSubtree' : 'remove', target: node.ref };
    else if (d.mode === 'bookmark' && d.newFolder)
      command = {
        type: 'createFolderAndBookmark',
        parent: node.ref,
        folderTitle: d.folderTitle,
        title: d.title,
        url: d.url,
      };
    else
      command = { type: 'create', parent: node.ref, title: d.title, ...(d.mode === 'bookmark' ? { url: d.url } : {}) };
    return prepareMutation(d.snapshot, command);
  }
  let request: ConfirmMutation | undefined;
  let invalid = '';
  if (draft) {
    try {
      request = requestFor(draft);
      preflight(request, snapshot);
    } catch {
      invalid = '内容或目标无效，或书签已变化；请取消并重新选择，不会自动改用其他目录。';
    }
  }
  async function confirm(nextDraft?: Draft) {
    if ((!request && !nextDraft) || (!nextDraft && invalid) || lock.current || interactionBlocked) return;
    let submitted: ConfirmMutation;
    try {
      submitted = nextDraft ? requestFor(nextDraft) : request!;
      preflight(submitted, snapshot);
    } catch {
      return;
    }
    lock.current = true;
    if (nextDraft) setDraft(nextDraft);
    setBusy(true);
    const response = await submitMutation(submitted, send);
    setResult(response);
    setDraft(undefined);
    setBusy(false);
    lock.current = false;
  }
  function patch(value: Partial<Draft>) {
    setDraft(current => (current ? { ...current, ...value } : current));
  }
  const descendants = new Set<string>();
  if (draft?.mode === 'delete') {
    const byId = new Map(draft.snapshot.nodes.map(n => [n.ref.nativeId, n]));
    const pending = [...(byId.get(draft.selectedId)?.childrenIds ?? [])];
    while (pending.length) {
      const id = pending.pop()!;
      if (descendants.has(id)) continue;
      descendants.add(id);
      pending.push(...(byId.get(id)?.childrenIds ?? []));
    }
  }
  const deleteCount = descendants.size;
  const disabled = busy || !!draft || interactionBlocked;
  const destination = draft ? draft.snapshot.nodes.find(n => n.ref.nativeId === draft.selectedId) : selected;
  return (
    <section ref={containerRef} className="bookmark-actions" aria-label={t('书签操作')}>
      {hideCommands && draft && (draft.mode === 'bookmark' || draft.mode === 'folder') && (
        <p className="hint">{t('目标目录：{title}', { title: destination?.title || t('无标题') })}</p>
      )}
      {!hideCommands && (
        <>
          <p className="hint">
            {selected
              ? t('已选择：{title}', { title: selected.title || t('无标题') })
              : t('选择一项后管理；移动也可使用键盘表单。')}
          </p>
          <div className="actions">
            <button disabled={disabled || !selected?.childrenWritable} onClick={() => begin('bookmark')}>
              {t('新建书签')}
            </button>
            <button disabled={disabled || !selected?.childrenWritable} onClick={() => begin('folder')}>
              {t('新建目录')}
            </button>
            <button disabled={disabled || !selected || selected.readOnly} onClick={() => begin('edit')}>
              {t('编辑 / 重命名')}
            </button>
            <button disabled={disabled || !selected || selected.readOnly} onClick={() => begin('move')}>
              {t('移动')}
            </button>
            <button disabled={disabled || !selected || selected.readOnly} onClick={() => begin('delete')}>
              {t('删除')}
            </button>
          </div>
        </>
      )}
      {draft && draft.mode !== 'delete' && (
        <form
          ref={form}
          className="surface"
          onSubmit={event => {
            event.preventDefault();
            void confirm();
          }}
        >
          {draft.mode !== 'move' ? (
            <>
              <label className="field">
                {t('标题')}
                <input value={draft.title} disabled={busy} onChange={event => patch({ title: event.target.value })} />
              </label>
              {(draft.mode === 'bookmark' ||
                (draft.mode === 'edit' &&
                  draft.snapshot.nodes.find(n => n.ref.nativeId === draft.selectedId)?.ref.kind === 'bookmark')) && (
                <label className="field">
                  {t('网址')}
                  <input value={draft.url} disabled={busy} onChange={event => patch({ url: event.target.value })} />
                </label>
              )}
              {draft.mode === 'bookmark' && (
                <>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={draft.newFolder}
                      onChange={event => patch({ newFolder: event.target.checked })}
                    />
                    {t('在新目录中创建书签')}
                  </label>
                  {draft.newFolder && (
                    <label className="field">
                      {t('新目录名称')}
                      <input value={draft.folderTitle} onChange={event => patch({ folderTitle: event.target.value })} />
                    </label>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <label className="field">
                {t('目标目录')}
                <Select
                  aria-label={t('目标目录')}
                  value={draft.parentId}
                  disabled={busy || interactionBlocked}
                  onChange={event => {
                    const parentId = event.target.value;
                    if (!parentId) {
                      patch({ parentId, index: 0 });
                      return;
                    }
                    const next = {
                      ...draft,
                      parentId,
                      index: Math.max(
                        0,
                        (draft.snapshot.nodes.find(node => node.ref.nativeId === parentId)?.childrenIds.length ?? 0) -
                          (draft.snapshot.nodes.find(node => node.ref.nativeId === draft.selectedId)?.parentId ===
                          parentId
                            ? 1
                            : 0),
                      ),
                    };
                    void confirm(next);
                  }}
                >
                  <option value="">{t('请选择目录')}</option>
                  {draft.snapshot.nodes
                    .filter(n => n.childrenWritable)
                    .map(n => (
                      <option key={n.ref.nativeId} value={n.ref.nativeId}>
                        {n.title || t('根目录')}（{n.ref.nativeId}）
                      </option>
                    ))}
                </Select>
              </label>
              <p className="hint">{t('选择目标目录后立即移动到末尾。')}</p>
            </>
          )}
          {invalid && <p role="alert">{message(invalid)}</p>}
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => setDraft(undefined)}>
              {t('取消')}
            </button>
            {draft.mode !== 'move' && (
              <button type="submit" disabled={busy || !!invalid}>
                {t('确认保存')}
              </button>
            )}
          </div>
        </form>
      )}
      {draft?.mode === 'delete' && (
        <ImpactConfirmDialog
          disabled={!!invalid}
          busy={busy}
          onCancel={() => setDraft(undefined)}
          onConfirm={() => void confirm()}
        >
          <p>
            {t('删除“{title}”及 {count} 个子项。中途变化会停止，已完成部分不会自动回滚。', {
              title: draft.snapshot.nodes.find(n => n.ref.nativeId === draft.selectedId)?.title ?? '',
              count: deleteCount,
            })}
          </p>
          {invalid && <p role="alert">{message(invalid)}</p>}
        </ImpactConfirmDialog>
      )}
      {busy && <BusyIndicator label={draft?.mode === 'move' ? t('正在移动书签…') : t('正在提交，请勿重复操作。')} />}
      {result && <MutationFeedback result={result} />}
    </section>
  );
}
