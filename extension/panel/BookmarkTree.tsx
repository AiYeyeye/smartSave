import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import { BookmarkFavicon } from '../ui/BookmarkFavicon';
import type { TreeSnapshot, TreeState } from '../domain/node-reference';
import { StateMessage } from '../ui/StateMessage';
import { CommandMenu, type CommandMenuItem } from '../ui/CommandMenu';
import { connectTree } from './tree-client';
import { expansionKey, saveExpansion } from './expansion-memory';
import { canOpenUrl, openUrl } from '../domain/open-url';
import { BookmarkActions, MutationFeedback, type Mode } from './BookmarkActions';
import { prepareMove, resolveDropTarget } from './TreeDragController';
import { preflight } from '../domain/preflight';
import { submitMutation } from './mutation-client';
import type { ConfirmMutation, MutationResult } from '../schemas/messages';

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
  const drag = useRef<{ snapshot: TreeSnapshot; id: string } | undefined>(undefined);
  const [move, setMove] = useState<ConfirmMutation>();
  const [moveResult, setMoveResult] = useState<MutationResult>();
  const [dragError, setDragError] = useState('');
  const [placement, setPlacement] = useState<{ id: string; mode: 'before' | 'after' | 'inside' }>();
  const suppressOpen = useRef(false);
  const [moving, setMoving] = useState(false);
  const [formActive, setFormActive] = useState(false);
  const moveLock = useRef(false);
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
    if (!connectionReady || !source || moveLock.current || formActive || move) return;
    try {
      const request = prepareMove(source.snapshot, source.id, parentId, index);
      preflight(request, snapshot);
      setMove(request);
      setDragError('');
      setMoveResult(undefined);
    } catch {
      setDragError('无法移动：目标失效、只读、循环或树已变化，请重新拖拽。');
    }
  }
  async function confirmMove() {
    if (!connectionReady || !move || moveLock.current || formActive) return;
    try {
      preflight(move, snapshot);
    } catch {
      setDragError('书签已变化，请取消并重新拖拽。');
      return;
    }
    moveLock.current = true;
    setMoving(true);
    setMoveResult(await submitMutation(move));
    setMove(undefined);
    setMoving(false);
    moveLock.current = false;
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
  const visible: { id: string; depth: number }[] = [];
  const stack = snapshot.roots.map(id => ({ id, depth: 0 })).reverse();
  while (stack.length) {
    const row = stack.pop()!;
    const node = byId.get(row.id);
    if (!node) continue;
    visible.push(row);
    if (expanded[expansionKey(snapshot.installationId, row.id)]) {
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
    const value = !expanded[key];
    setExpanded(previous => ({ ...previous, [key]: value }));
    if (typeof chrome === 'undefined' || !chrome.storage) {
      setMemoryError(true);
      return;
    }
    void saveExpansion(chrome.storage.local, snapshot.installationId, id, value).catch(() => setMemoryError(true));
  }
  function startDrag(event: DragEvent, id: string, readOnly: boolean) {
    if (!connectionReady || readOnly || moving || move || formActive) {
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
  function menuItems(id: string): CommandMenuItem[] {
    const node = byId.get(id);
    if (!node) return [];
    const items: CommandMenuItem[] = [];
    if (node.ref.kind === 'folder' && node.childrenWritable) {
      items.push({ id: 'bookmark', label: '新建书签', onSelect: () => act(id, 'bookmark') });
      items.push({ id: 'folder', label: '新建目录', onSelect: () => act(id, 'folder') });
    }
    if (node.ref.kind === 'bookmark') {
      items.push({
        id: 'open',
        label: canOpenUrl(node.url) ? '打开' : '此协议不支持打开',
        disabled: !canOpenUrl(node.url),
        onSelect: () => {
          if (node.url) openUrl(node.url);
        },
      });
    }
    if (!node.readOnly) {
      items.push({ id: 'edit', label: '编辑 / 重命名', onSelect: () => act(id, 'edit') });
      items.push({ id: 'move', label: '移动', onSelect: () => act(id, 'move') });
      items.push({ id: 'delete', label: '删除', onSelect: () => act(id, 'delete') });
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
        initialMode={intentMode}
        interactionBlocked={!connectionReady || !!move || moving}
        onInteractionChange={active => {
          setFormActive(active);
          if (!active) setIntentMode(undefined);
        }}
      />
      {dragError && <p role="alert">{dragError}</p>}
      {move && (
        <div className="surface">
          <p>
            移动到{' '}
            {
              snapshot.nodes.find(n => 'parent' in move.command && n.ref.nativeId === move.command.parent.nativeId)
                ?.title
            }
            ，位置 {'index' in move.command ? move.command.index : ''}
          </p>
          <button disabled={moving} onClick={() => setMove(undefined)}>
            取消移动
          </button>
          <button disabled={moving || !connectionReady} onClick={() => void confirmMove()}>
            确认移动
          </button>
        </div>
      )}
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
          const open = !!expanded[expansionKey(snapshot.installationId, id)];
          const title = node.title || (node.ref.kind === 'folder' ? '书签根目录' : '无标题书签');
          return (
            <li
              key={id}
              className="bookmark-row"
              data-node-id={id}
              data-placement={placement?.id === id ? placement.mode : undefined}
              onPointerDown={() => {
                suppressOpen.current = false;
              }}
              onKeyDown={event => {
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
              style={{ paddingInlineStart: `${depth * 14}px` }}
              onContextMenu={event => {
                if (node.ref.kind !== 'folder') return;
                event.preventDefault();
                event.currentTarget.querySelector<HTMLButtonElement>('.command-trigger')?.click();
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
                  draggable={!node.readOnly && !moving && !move && !formActive}
                  onClick={() => toggle(id)}
                  onDragStart={event => startDrag(event, id, !!node.readOnly)}
                  onDragEnd={() => {
                    drag.current = undefined;
                    setPlacement(undefined);
                  }}
                >
                  {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                  <Folder aria-hidden="true" />
                  <span>{title}</span>
                  {node.readOnly && <small>只读</small>}
                </button>
              ) : (
                <div
                  className="bookmark-label"
                  draggable={!node.readOnly && !moving && !move && !formActive}
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
              {menuItems(id).length > 0 && <CommandMenu label={`${title} 操作`} items={menuItems(id)} />}
              {node.ref.kind === 'folder' && open && !node.childrenIds.length && <p className="hint">空文件夹</p>}
            </li>
          );
        })}
      </ul>
    </>
  );
}
