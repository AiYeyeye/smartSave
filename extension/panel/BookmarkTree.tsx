import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CheckSquare,
  ChevronRight,
  ExternalLink,
  Folder,
  FolderInput,
  SquarePen,
  Trash2,
  AppWindow,
  VenetianMask,
  Copy,
  Pin,
} from 'lucide-react';
import { BookmarkFavicon } from '../ui/BookmarkFavicon';
import type { TreeSnapshot, TreeState } from '../domain/node-reference';
import { StateMessage } from '../ui/StateMessage';
import { CommandMenu, type CommandMenuItem } from '../ui/CommandMenu';
import { connectTree } from './tree-client';
import { expansionKey, saveExpansion } from './expansion-memory';
import { canOpenUrl, openUrl, openBookmarkUrl, type BookmarkOpenTarget } from '../domain/open-url';
import { BookmarkActions, MutationFeedback, type Mode } from './BookmarkActions';
import { prepareMove, resolveDropTarget } from './TreeDragController';
import { preflight } from '../domain/preflight';
import { submitMutation } from './mutation-client';
import type { ConfirmMutation, MutationResult } from '../schemas/messages';
import { BusyIndicator } from '../ui/BusyIndicator';

export function BookmarkTree({ batchNonce = 0 }: { batchNonce?: number }) {
  const [state, setState] = useState<TreeState>({ status: 'loading' });
  const [retry, setRetry] = useState(0);
  const [lastSnapshot, setLastSnapshot] = useState<TreeSnapshot>();
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.connect) {
      setState({ status: 'error', message: '尚未连接书签' });
      return;
    }
    return connectTree(chrome.runtime, next => {
      if (next.status === 'ready') setLastSnapshot(next.snapshot);
      setState(next);
    });
  }, [retry]);
  const snapshot = state.status === 'ready' ? state.snapshot : lastSnapshot;
  return (
    <>
      {state.status !== 'ready' && (
        <StateMessage
          kind={state.status === 'loading' ? 'loading' : 'error'}
          title={state.status === 'loading' ? (snapshot ? '正在重新连接书签' : '正在读取书签') : state.message}
        >
          <p>{snapshot ? '保留上次列表供查看；连接恢复前不能修改。不会自动重放操作。' : '等待浏览器提供当前目录。'}</p>
          {state.status === 'error' && (
            <>
              <button onClick={() => setRetry(value => value + 1)}>重试读取</button>
              <p>若重试仍失败，请关闭并重新打开智栏以重新绑定身份。</p>
            </>
          )}
        </StateMessage>
      )}
      {snapshot && <TreeRows snapshot={snapshot} batchNonce={batchNonce} connectionReady={state.status === 'ready'} />}
    </>
  );
}
export function TreeRows({
  snapshot,
  batchNonce = 0,
  connectionReady = true,
}: {
  snapshot: TreeSnapshot;
  batchNonce?: number;
  connectionReady?: boolean;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string>();
  const [intentMode, setIntentMode] = useState<Mode>();
  const [batch, setBatch] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [openError, setOpenError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [menuId, setMenuId] = useState<string>();
  const drag = useRef<{ snapshot: TreeSnapshot; id: string } | undefined>(undefined);
  const [moveResult, setMoveResult] = useState<MutationResult>();
  const [dragError, setDragError] = useState('');
  const [placement, setPlacement] = useState<{ id: string; mode: 'before' | 'after' | 'inside' }>();
  const suppressOpen = useRef(false);
  const [moving, setMoving] = useState(false);
  const [formActive, setFormActive] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  const actionsHost = useRef<HTMLElement>(null);
  const moveLock = useRef(false);
  const mutationBlockReason = !connectionReady
    ? '书签连接尚未恢复，恢复后才能修改。'
    : moving || formBusy
      ? '正在提交书签操作，请等待完成。'
      : formActive
        ? '有尚未完成的书签操作，请先完成或取消。'
        : undefined;
  useEffect(() => {
    if (batchNonce) {
      setBatch(true);
      setChecked(new Set());
    }
  }, [batchNonce]);
  function drop(parentId: string, index: number) {
    const source = drag.current;
    drag.current = undefined;
    setPlacement(undefined);
    suppressOpen.current = true;
    if (!connectionReady || !source || moveLock.current || formActive) return;
    try {
      const request = prepareMove(source.snapshot, source.id, parentId, index);
      preflight(request, snapshot);
      void executeMove(request);
    } catch {
      setDragError('无法移动：目标失效、只读、循环或树已变化，请重新拖拽。');
    }
  }
  async function executeMove(request: ConfirmMutation) {
    if (!connectionReady || moveLock.current || formActive) return;
    try {
      preflight(request, snapshot);
    } catch {
      setDragError('书签已变化，请取消并重新拖拽。');
      return;
    }
    moveLock.current = true;
    setMoving(true);
    setDragError('');
    setMoveResult(undefined);
    try {
      setMoveResult(await submitMutation(request));
    } finally {
      setMoving(false);
      moveLock.current = false;
    }
  }
  const [memoryError, setMemoryError] = useState(false);
  useEffect(() => {
    let active = true;
    let changed = false;
    if (typeof chrome === 'undefined' || !chrome.storage) {
      setMemoryError(true);
      return;
    }
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      changed = true;
      setExpanded(previous => {
        const next = { ...previous };
        for (const [key, change] of Object.entries(changes))
          if (key.startsWith('tree.expanded.')) next[key] = change.newValue === true;
        return next;
      });
    };
    chrome.storage.onChanged.addListener(listener);
    async function load() {
      try {
        const values = await chrome.storage.local.get(
          snapshot.nodes.map(node => expansionKey(snapshot.installationId, node.ref.nativeId)),
        );
        if (!active) return;
        if (changed) {
          changed = false;
          void load();
          return;
        }
        setExpanded(previous => ({
          ...Object.fromEntries(
            Object.entries(values)
              .filter(([key, value]) => key.startsWith('tree.expanded.') && typeof value === 'boolean')
              .map(([key, value]) => [key, value === true]),
          ),
          ...previous,
        }));
      } catch {
        if (active) setMemoryError(true);
      }
    }
    void load();
    return () => {
      active = false;
      if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) chrome.storage.onChanged.removeListener(listener);
    };
  }, [snapshot.installationId, snapshot.nodes]);
  const byId = useMemo(() => new Map(snapshot.nodes.map(node => [node.ref.nativeId, node])), [snapshot.nodes]);
  // The browser's invisible root ("0") is structural: show its children (书签栏 / 其他书签) as the top level.
  const topLevel = (() => {
    if (snapshot.roots.length !== 1) return snapshot.roots;
    const only = byId.get(snapshot.roots[0]!);
    return only && only.parentId === undefined && !only.title && only.childrenIds.length
      ? only.childrenIds
      : snapshot.roots;
  })();
  // Until the user toggles it, the first top-level folder (usually 书签栏) starts open.
  const isOpen = (id: string) => {
    const key = expansionKey(snapshot.installationId, id);
    return key in expanded ? !!expanded[key] : id === topLevel[0];
  };
  const visible: { id: string; depth: number }[] = [];
  const stack = topLevel.map(id => ({ id, depth: 0 })).reverse();
  while (stack.length) {
    const row = stack.pop()!;
    const node = byId.get(row.id);
    if (!node) continue;
    visible.push(row);
    if (isOpen(row.id)) {
      for (let i = node.childrenIds.length - 1; i >= 0; i--)
        stack.push({ id: node.childrenIds[i]!, depth: row.depth + 1 });
    }
  }
  function toggle(id: string) {
    if (suppressOpen.current) {
      suppressOpen.current = false;
      return;
    }
    const key = expansionKey(snapshot.installationId, id);
    const value = !isOpen(id);
    setExpanded(previous => ({ ...previous, [key]: value }));
    if (typeof chrome === 'undefined' || !chrome.storage) {
      setMemoryError(true);
      return;
    }
    void saveExpansion(chrome.storage.local, snapshot.installationId, id, value).catch(() => setMemoryError(true));
  }
  function startDrag(event: DragEvent, id: string, readOnly: boolean) {
    if (!connectionReady || readOnly || moving || moveLock.current || formActive) {
      event.preventDefault();
      return;
    }
    suppressOpen.current = true;
    drag.current = { snapshot: structuredClone(snapshot), id };
    event.dataTransfer.clearData();
    event.dataTransfer.setData('application/x-zhilan-node', id);
    event.dataTransfer.effectAllowed = 'move';
  }
  function act(id: string, mode: Mode) {
    if (!connectionReady) return;
    setSelectedId(id);
    setIntentMode(mode);
  }
  function siblingIndex(nodeId: string): { parentId: string; index: number; siblings: string[] } | undefined {
    const node = byId.get(nodeId);
    if (!node || node.parentId === undefined || node.readOnly) return;
    const parent = byId.get(node.parentId);
    if (!parent) return;
    return { parentId: node.parentId, index: node.index, siblings: parent.childrenIds };
  }
  function moveBy(id: string, delta: number) {
    if (!connectionReady || moving || moveLock.current || formActive) return;
    const info = siblingIndex(id);
    if (!info) return;
    const next = info.index + delta;
    if (next < 0 || next >= info.siblings.length) return;
    try {
      const request = prepareMove(snapshot, id, info.parentId, next);
      preflight(request, snapshot);
      void executeMove(request);
    } catch {
      setDragError('无法移动：目标失效、只读、循环或树已变化。');
    }
  }
  function menuItems(id: string): CommandMenuItem[] {
    const node = byId.get(id);
    if (!node) return [];
    const items: CommandMenuItem[] = [];
    if (formActive && !formBusy)
      items.push({
        id: 'resume',
        label: '返回当前操作',
        icon: <SquarePen aria-hidden="true" />,
        onSelect: () => {
          const host = actionsHost.current;
          host?.scrollIntoView?.({ block: 'nearest' });
          host
            ?.querySelector<HTMLElement>(
              'input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)',
            )
            ?.focus();
        },
      });
    if (node.ref.kind === 'bookmark') {
      const targets: { target: BookmarkOpenTarget; label: string; icon: typeof ExternalLink }[] = [
        { target: 'tab', label: '在新标签页打开', icon: ExternalLink },
        { target: 'window', label: '在新窗口中打开', icon: AppWindow },
        { target: 'incognito', label: '在无痕窗口中打开', icon: VenetianMask },
      ];
      for (const { target, label, icon: Icon } of targets)
        items.push({
          id: `open-${target}`,
          label,
          icon: <Icon aria-hidden="true" />,
          disabled: !canOpenUrl(node.url),
          onSelect: () => {
            setOpenError('');
            if (node.url) void openBookmarkUrl(node.url, target).catch((error: Error) => setOpenError(error.message));
          },
        });
      items.push({
        id: 'copy',
        label: '复制链接',
        icon: <Copy aria-hidden="true" />,
        separatorBefore: true,
        disabled: !node.url,
        onSelect: () => {
          setCopyStatus('');
          setOpenError('');
          if (node.url) {
            try {
              void navigator.clipboard.writeText(node.url).then(
                () => setCopyStatus('已复制链接'),
                () => setOpenError('无法复制链接，请检查剪贴板权限后重试。'),
              );
            } catch {
              setOpenError('无法复制链接，请检查剪贴板权限后重试。');
            }
          }
        },
      });
      items.push({
        id: 'select',
        label: checked.has(id) ? '取消选择书签' : '选择书签',
        icon: <CheckSquare aria-hidden="true" />,
        onSelect: () => {
          setBatch(true);
          toggleCheck(id, !checked.has(id));
        },
      });
    }
    const info = siblingIndex(id);
    const canReorder = !!info && !node.readOnly;
    if (canReorder) {
      items.push({
        id: 'top',
        label: '置顶',
        icon: <Pin aria-hidden="true" />,
        separatorBefore: items.length > 0,
        disabled: info!.index <= 0 || !connectionReady || moving || formActive,
        disabledReason: mutationBlockReason ?? '已在当前目录首位。',
        onSelect: () => moveBy(id, -info!.index),
      });
      items.push({
        id: 'up',
        label: '上移',
        icon: <ArrowUp aria-hidden="true" />,
        disabled: info!.index <= 0 || !connectionReady || moving || formActive,
        disabledReason: mutationBlockReason ?? '已在当前目录首位。',
        onSelect: () => moveBy(id, -1),
      });
      items.push({
        id: 'down',
        label: '下移',
        icon: <ArrowDown aria-hidden="true" />,
        disabled: info!.index >= info!.siblings.length - 1 || !connectionReady || moving || formActive,
        disabledReason: mutationBlockReason ?? '已在当前目录末位。',
        onSelect: () => moveBy(id, 1),
      });
    }
    if (!node.readOnly) {
      const disabled = !connectionReady || moving || formActive;
      items.push({
        id: 'edit',
        label: node.ref.kind === 'bookmark' ? '编辑' : '重命名',
        icon: <SquarePen aria-hidden="true" />,
        disabled,
        disabledReason: mutationBlockReason,
        onSelect: () => act(id, 'edit'),
      });
      items.push({
        id: 'move',
        label: '移入…',
        icon: <FolderInput aria-hidden="true" />,
        disabled,
        disabledReason: mutationBlockReason,
        onSelect: () => act(id, 'move'),
      });
      items.push({
        id: 'delete',
        label: '删除',
        icon: <Trash2 aria-hidden="true" />,
        disabled,
        disabledReason: mutationBlockReason,
        onSelect: () => act(id, 'delete'),
      });
    }
    if (node.ref.kind === 'folder' && node.childrenWritable) {
      const disabled = !connectionReady || moving || formActive;
      items.push({
        id: 'bookmark',
        label: '新建书签',
        disabled,
        disabledReason: mutationBlockReason,
        onSelect: () => act(id, 'bookmark'),
      });
      items.push({
        id: 'folder',
        label: '新建目录',
        disabled,
        disabledReason: mutationBlockReason,
        onSelect: () => act(id, 'folder'),
      });
    }
    return items;
  }
  function toggleCheck(id: string, on: boolean) {
    setChecked(previous => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  const only = [...checked][0];
  const onlyNode = only ? byId.get(only) : undefined;
  const canMutate = connectionReady && checked.size === 1 && !!onlyNode && !onlyNode.readOnly;
  if (!snapshot.nodes.length)
    return (
      <StateMessage kind="empty" title="暂无书签">
        浏览器尚未返回目录。
      </StateMessage>
    );
  return (
    <>
      <BookmarkActions
        snapshot={snapshot}
        selectedId={selectedId}
        hideCommands
        containerRef={actionsHost}
        initialMode={intentMode}
        interactionBlocked={!connectionReady || moving}
        onInteractionChange={(active, busy) => {
          setFormActive(active);
          setFormBusy(busy);
          if (!active) setIntentMode(undefined);
        }}
      />
      {dragError && <p role="alert">{dragError}</p>}
      {openError && <p role="alert">{openError}</p>}
      {copyStatus && <p role="status">{copyStatus}</p>}
      {moving && <BusyIndicator label="正在移动书签…" />}
      {moveResult && <MutationFeedback result={moveResult} />}
      {memoryError && <p role="alert">展开状态无法记忆，本次仍可浏览。</p>}
      {batch && (
        <div className="batch-bar" role="region" aria-label="批量管理">
          <p>已选 {checked.size} 项</p>
          {checked.size > 1 && <p role="status">当前版本暂不支持批量修改，请只选择一项进行编辑、移动或删除</p>}
          <button disabled={!canMutate} onClick={() => only && act(only, 'edit')}>
            编辑 / 重命名
          </button>
          <button disabled={!canMutate} onClick={() => only && act(only, 'move')}>
            移动
          </button>
          <button disabled={!canMutate} onClick={() => only && act(only, 'delete')}>
            删除
          </button>
          <button
            type="button"
            onClick={() => {
              setBatch(false);
              setChecked(new Set());
            }}
          >
            退出选择
          </button>
        </div>
      )}
      <ul className="bookmark-tree" aria-label="原生书签">
        {visible.map(({ id, depth }) => {
          const node = byId.get(id)!;
          const open = isOpen(id);
          const title = node.title || (node.ref.kind === 'folder' ? '书签根目录' : '无标题书签');
          return (
            <li
              key={id}
              className={
                'bookmark-row' +
                (node.ref.kind === 'folder' ? ' is-folder' : ' is-bookmark') +
                (placement?.id === id && placement.mode === 'inside' ? ' drop-into' : '') +
                (placement?.id === id && placement.mode === 'before' ? ' drop-before' : '') +
                (placement?.id === id && placement.mode === 'after' ? ' drop-after' : '')
              }
              data-node-id={id}
              data-placement={placement?.id === id ? placement.mode : undefined}
              onPointerDown={() => {
                suppressOpen.current = false;
              }}
              onKeyDown={event => {
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault();
                  setMenuId(id);
                }
                if (event.key === 'Escape') {
                  drag.current = undefined;
                  setPlacement(undefined);
                }
              }}
              onDragLeave={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPlacement(undefined);
              }}
              onDragOver={event => {
                if (!drag.current || !connectionReady) return;
                const bounds = event.currentTarget.getBoundingClientRect();
                const ratio = (event.clientY - bounds.top) / bounds.height;
                const mode =
                  node.ref.kind === 'folder' && ratio >= 0.25 && ratio <= 0.75
                    ? 'inside'
                    : ratio < 0.5
                      ? 'before'
                      : 'after';
                const target = resolveDropTarget(byId, drag.current.id, id, mode);
                if (target) {
                  event.preventDefault();
                  setPlacement(previous => (previous?.id === id && previous.mode === mode ? previous : { id, mode }));
                } else setPlacement(undefined);
              }}
              onDrop={event => {
                event.preventDefault();
                if (placement?.id !== id || !drag.current) return;
                const target = resolveDropTarget(byId, drag.current.id, id, placement.mode);
                if (target) drop(target.parentId, target.index);
              }}
              style={{ paddingInlineStart: `${depth * 16}px`, ['--depth' as string]: depth }}
              onContextMenu={event => {
                if (menuItems(id).length === 0) return;
                event.preventDefault();
                setMenuId(id);
              }}
            >
              {!node.readOnly && node.parentId !== undefined && (
                <span
                  className="drop-zone"
                  aria-label={`移到 ${title} 前`}
                  onDragOver={event => {
                    event.stopPropagation();
                    if (connectionReady && drag.current && resolveDropTarget(byId, drag.current.id, id, 'before')) {
                      event.preventDefault();
                      setPlacement(previous =>
                        previous?.id === id && previous.mode === 'before' ? previous : { id, mode: 'before' },
                      );
                    } else setPlacement(undefined);
                  }}
                  onDrop={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    const target = drag.current && resolveDropTarget(byId, drag.current.id, id, 'before');
                    if (target) drop(target.parentId, target.index);
                  }}
                />
              )}
              {batch && (
                <label className="batch-check">
                  <input
                    type="checkbox"
                    checked={checked.has(id)}
                    onChange={event => toggleCheck(id, event.target.checked)}
                    aria-label={`选择 ${title}`}
                  />
                </label>
              )}
              {node.ref.kind === 'folder' ? (
                <button
                  className="folder-row"
                  aria-expanded={open}
                  draggable={!node.readOnly && !moving && !formActive}
                  onClick={() => toggle(id)}
                  onDragStart={event => startDrag(event, id, !!node.readOnly)}
                  onDragEnd={() => {
                    drag.current = undefined;
                    setPlacement(undefined);
                  }}
                >
                  <ChevronRight aria-hidden="true" />
                  <Folder aria-hidden="true" />
                  <span>{title}</span>
                  {node.readOnly && depth > 0 && <small>只读</small>}
                </button>
              ) : (
                <div
                  className="bookmark-label"
                  draggable={!node.readOnly && !moving && !formActive}
                  onDragStart={event => startDrag(event, id, !!node.readOnly)}
                  onDragEnd={() => {
                    drag.current = undefined;
                    setPlacement(undefined);
                  }}
                >
                  <BookmarkFavicon url={node.url} />
                  {canOpenUrl(node.url) ? (
                    <button
                      type="button"
                      className="bookmark-open"
                      title={node.url ? `${title}\n${node.url}` : title}
                      draggable={false}
                      onClick={() => {
                        if (suppressOpen.current) {
                          suppressOpen.current = false;
                          return;
                        }
                        if (node.url) openUrl(node.url);
                      }}
                    >
                      {title}
                    </button>
                  ) : (
                    <span>{title}</span>
                  )}
                </div>
              )}
              {node.ref.kind === 'folder' && node.childrenIds.length > 0 ? (
                <span className="row-count" aria-hidden="true">
                  {node.childrenIds.length}
                </span>
              ) : null}
              {menuItems(id).length > 0 && (
                <CommandMenu
                  label={`${title} 操作`}
                  items={menuItems(id)}
                  description={mutationBlockReason}
                  open={menuId === id}
                  onOpenChange={open => setMenuId(current => (open ? id : current === id ? undefined : current))}
                />
              )}
              {node.ref.kind === 'folder' && open && !node.childrenIds.length && <p className="hint">空文件夹</p>}
            </li>
          );
        })}
      </ul>
    </>
  );
}
