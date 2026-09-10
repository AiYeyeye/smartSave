import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, Bookmark } from 'lucide-react';
import type { TreeSnapshot, TreeState } from '../domain/node-reference';
import { StateMessage } from '../ui/StateMessage';
import { connectTree } from './tree-client';
import { expansionKey, saveExpansion } from './expansion-memory';
import { canOpenUrl, openUrl } from '../domain/open-url';
import { BookmarkActions, MutationFeedback } from './BookmarkActions';
import { prepareMove } from './TreeDragController';
import { preflight } from '../domain/preflight';
import { submitMutation } from './mutation-client';
import type { ConfirmMutation, MutationResult } from '../schemas/messages';

export function BookmarkTree() {
  const [state, setState] = useState<TreeState>({ status: 'loading' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.connect) { setState({ status: 'error', message: '尚未连接书签' }); return; }
    return connectTree(chrome.runtime, setState);
  }, [retry]);
  return <>{state.status === 'ready' ? <TreeRows snapshot={state.snapshot} /> : state.status === 'loading' ? <StateMessage kind="loading" title="正在读取书签">等待浏览器提供当前目录。</StateMessage> : <StateMessage kind="error" title={state.message}><button onClick={() => setRetry(value => value + 1)}>重试读取</button></StateMessage>}</>;
}
export function TreeRows({ snapshot }: { snapshot: TreeSnapshot }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string>();
  const drag = useRef<{ snapshot: TreeSnapshot; id: string } | undefined>(undefined);
  const [move, setMove] = useState<ConfirmMutation>();
  const [moveResult, setMoveResult] = useState<MutationResult>();
  const [dragError, setDragError] = useState('');
  const [moving, setMoving] = useState(false);
  const [formActive, setFormActive] = useState(false);
  const moveLock = useRef(false);
  function drop(parentId: string, index: number) {
    const source = drag.current; drag.current = undefined;
    if (!source || moveLock.current || formActive || move) return;
    try {
      const request = prepareMove(source.snapshot, source.id, parentId, index);
      preflight(request, snapshot); setMove(request); setDragError(''); setMoveResult(undefined);
    } catch { setDragError('无法移动：目标失效、只读、循环或树已变化，请重新拖拽。'); }
  }
  async function confirmMove() {
    if (!move || moveLock.current || formActive) return;
    try { preflight(move, snapshot); } catch { setDragError('书签已变化，请取消并重新拖拽。'); return; }
    moveLock.current = true; setMoving(true);
    setMoveResult(await submitMutation(move)); setMove(undefined); setMoving(false); moveLock.current = false;
  }
  const [memoryError, setMemoryError] = useState(false);
  useEffect(() => {
    let active = true;
    let changed = false;
    if (typeof chrome === 'undefined' || !chrome.storage) { setMemoryError(true); return; }
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      changed = true;
      setExpanded(previous => {
        const next = { ...previous };
        for (const [key, change] of Object.entries(changes)) if (key.startsWith('tree.expanded.')) next[key] = change.newValue === true;
        return next;
      });
    };
    chrome.storage.onChanged.addListener(listener);
    async function load() {
      try {
        const values = await chrome.storage.local.get(snapshot.nodes.map(node => expansionKey(snapshot.installationId, node.ref.nativeId)));
        if (!active) return;
        if (changed) { changed = false; void load(); return; }
        setExpanded(previous => ({ ...Object.fromEntries(Object.entries(values).filter(([key, value]) => key.startsWith('tree.expanded.') && typeof value === 'boolean').map(([key, value]) => [key, value === true])), ...previous }));
      } catch { if (active) setMemoryError(true); }
    }
    void load();
    return () => { active = false; chrome.storage.onChanged.removeListener(listener); };
  }, [snapshot.installationId, snapshot.nodes]);
  const byId = new Map(snapshot.nodes.map(node => [node.ref.nativeId, node]));
  const visible: { id: string; depth: number }[] = [];
  const stack = snapshot.roots.map(id => ({ id, depth: 0 })).reverse();
  while (stack.length) {
    const row = stack.pop()!;
    const node = byId.get(row.id);
    if (!node) continue;
    visible.push(row);
    if (expanded[expansionKey(snapshot.installationId, row.id)]) {
      for (let i = node.childrenIds.length - 1; i >= 0; i--) stack.push({ id: node.childrenIds[i]!, depth: row.depth + 1 });
    }
  }
  function toggle(id: string) {
    const key = expansionKey(snapshot.installationId, id);
    const value = !expanded[key];
    setExpanded(previous => ({ ...previous, [key]: value }));
    if (typeof chrome === 'undefined' || !chrome.storage) { setMemoryError(true); return; }
    void saveExpansion(chrome.storage.local, snapshot.installationId, id, value).catch(() => setMemoryError(true));
  }
  if (!snapshot.nodes.length) return <StateMessage kind="empty" title="暂无书签">浏览器尚未返回目录。</StateMessage>;
  return <><BookmarkActions snapshot={snapshot} selectedId={selectedId} interactionBlocked={!!move || moving} onInteractionChange={setFormActive} />
    <p className="hint">拖到目录内末尾，或拖到行前调整顺序；也可选择后使用“移动”。</p>
    {dragError && <p role="alert">{dragError}</p>}
    {move && <div className="surface"><p>移动到 {snapshot.nodes.find(n => 'parent' in move.command && n.ref.nativeId === move.command.parent.nativeId)?.title}，位置 {'index' in move.command ? move.command.index : ''}</p><button disabled={moving} onClick={() => setMove(undefined)}>取消移动</button><button disabled={moving} onClick={() => void confirmMove()}>确认移动</button></div>}
    {moveResult && <MutationFeedback result={moveResult} />}
    {memoryError && <p role="alert">展开状态无法记忆，本次仍可浏览。</p>}
    <ul className="bookmark-tree" aria-label="原生书签">
      {visible.map(({ id, depth }) => {
        const node = byId.get(id)!;
        const open = !!expanded[expansionKey(snapshot.installationId, id)];
        return <li key={id} className="bookmark-row" style={{ paddingInlineStart: `${depth * 16}px` }}>
          <div className="row-tools">
            <button aria-label={`选择 ${node.title || '无标题'}`} aria-pressed={selectedId === id} draggable={!node.readOnly && !moving && !move && !formActive} onClick={() => setSelectedId(id)} onDragStart={event => { if (node.readOnly || moving || move || formActive) { event.preventDefault(); return; } drag.current = { snapshot: structuredClone(snapshot), id }; event.dataTransfer.clearData(); event.dataTransfer.setData('application/x-zhilan-node', id); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { drag.current = undefined; }}>选择</button>
            {!node.readOnly && node.parentId !== undefined && <span className="drop-zone" onDragOver={event => { if (drag.current) event.preventDefault(); }} onDrop={event => { event.preventDefault(); const source = drag.current?.snapshot.nodes.find(n => n.ref.nativeId === drag.current?.id); drop(node.parentId!, node.index - (source && source.parentId === node.parentId && source.index < node.index ? 1 : 0)); }}>移至此项前</span>}
          </div>
          {node.ref.kind === 'folder' ? <button className="folder-row" aria-expanded={open} onClick={() => toggle(id)} onDragOver={event => { if (drag.current && node.childrenWritable) event.preventDefault(); }} onDrop={event => { event.preventDefault(); drop(id, node.childrenIds.length - (drag.current?.snapshot.nodes.find(n => n.ref.nativeId === drag.current?.id)?.parentId === id ? 1 : 0)); }}>{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}<Folder aria-hidden="true" /><span>{node.title || '书签根目录'}</span>{node.readOnly && <small>只读</small>}</button>
            : <div className="bookmark-label"><Bookmark aria-hidden="true" /><span>{node.title || '无标题书签'}<small>{node.url}</small>{canOpenUrl(node.url) ? <button draggable={false} onClick={() => { if (node.url) openUrl(node.url); }}>打开</button> : <small>此协议不支持打开</small>}</span></div>}
          {node.ref.kind === 'folder' && open && !node.childrenIds.length && <p className="hint">空文件夹</p>}
        </li>;
      })}
    </ul></>;
}
