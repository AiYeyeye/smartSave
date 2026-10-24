import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import type { TreeSnapshot } from '../domain/node-reference';
import { organizePaths } from '../domain/organize-review';
import { useI18n } from '../ui/i18n';
import './folder-tree-picker.css';

/** Folders of a snapshot, without the browser's untitled read-only root. */
function folderIndex(tree: TreeSnapshot) {
  const nodes = new Map(tree.nodes.filter(node => node.ref.kind === 'folder').map(node => [node.ref.nativeId, node]));
  const root = tree.roots.length === 1 ? nodes.get(tree.roots[0]!) : undefined;
  const hiddenRoot = root && !root.title && root.parentId === undefined && !root.childrenWritable ? root : undefined;
  const roots = (hiddenRoot?.childrenIds ?? tree.roots).filter(key => nodes.has(key));
  return { nodes, hiddenRoot, roots };
}

/** Every folder above `id`, outermost first; a tree opened on `id` expands exactly this path. */
export function folderAncestors(tree: TreeSnapshot, id: string): string[] {
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  const chain: string[] = [];
  const visited = new Set<string>();
  let key = nodes.get(id)?.parentId;
  while (key && !visited.has(key)) {
    visited.add(key);
    chain.unshift(key);
    key = nodes.get(key)?.parentId;
  }
  return chain;
}

/** Selected folder title and its path below the hidden root, for triggers and summaries. */
export function useFolderLabel(tree: TreeSnapshot, value: string) {
  const { t } = useI18n();
  const { nodes, hiddenRoot } = useMemo(() => folderIndex(tree), [tree]);
  const paths = useMemo(() => organizePaths(tree, t('根目录')), [tree, t]);
  const fullPath = paths.get(value) ?? '';
  return {
    title: nodes.get(value)?.title,
    path: hiddenRoot ? fullPath.replace(`${paths.get(hiddenRoot.ref.nativeId)} / `, '') : fullPath,
  };
}

/**
 * A real expandable folder tree. Expansion, focus and selection are local draft state; nothing here writes.
 * `expanded` is controlled so a caller can keep it in a draft across reopen.
 */
export function FolderTree({
  tree,
  value,
  onChoose,
  expanded,
  onExpandedChange,
  disabled = false,
  id,
  labelledBy,
  compact = false,
}: {
  tree: TreeSnapshot;
  value: string;
  onChoose: (id: string) => void;
  expanded: ReadonlySet<string>;
  onExpandedChange: (next: Set<string>) => void;
  disabled?: boolean;
  id?: string;
  labelledBy?: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const items = useRef(new Map<string, HTMLDivElement>());
  const [focus, setFocus] = useState(value);
  const { nodes, roots } = useMemo(() => folderIndex(tree), [tree]);
  const paths = useMemo(() => organizePaths(tree, t('根目录')), [tree, t]);
  useEffect(() => {
    items.current.get(value)?.scrollIntoView?.({ block: 'nearest' });
    // Only on mount and when the selection itself changes.
  }, [value]);
  const rows: { id: string; depth: number; parent?: string; children: string[]; pos: number; size: number }[] = [];
  const seen = new Set<string>();
  const stack = roots
    .map((key, index) => ({
      id: key,
      depth: 1,
      parent: undefined as string | undefined,
      pos: index + 1,
      size: roots.length,
    }))
    .reverse();
  while (stack.length) {
    const item = stack.pop()!;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const node = nodes.get(item.id);
    if (!node) continue;
    const children = node.childrenIds.filter(key => nodes.has(key) && !seen.has(key));
    rows.push({ ...item, children });
    if (expanded.has(item.id))
      for (let index = children.length - 1; index >= 0; index--)
        stack.push({
          id: children[index]!,
          depth: item.depth + 1,
          parent: item.id,
          pos: index + 1,
          size: children.length,
        });
  }
  const active = rows.some(row => row.id === focus) ? focus : rows[0]?.id;
  function move(key: string | undefined) {
    if (!key) return;
    setFocus(key);
    items.current.get(key)?.focus();
    items.current.get(key)?.scrollIntoView?.({ block: 'nearest' });
  }
  function toggle(key: string) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onExpandedChange(next);
    move(key);
  }
  function choose(key: string) {
    if (disabled || !nodes.get(key)?.childrenWritable) return;
    setFocus(key);
    onChoose(key);
  }
  function keys(event: KeyboardEvent, index: number) {
    if (disabled) return;
    const row = rows[index]!;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'ArrowUp') move(rows[Math.max(0, index - 1)]?.id);
    if (event.key === 'ArrowDown') move(rows[Math.min(rows.length - 1, index + 1)]?.id);
    if (event.key === 'Home') move(rows[0]?.id);
    if (event.key === 'End') move(rows.at(-1)?.id);
    if (event.key === 'ArrowLeft') {
      if (expanded.has(row.id)) toggle(row.id);
      else move(row.parent);
    }
    if (event.key === 'ArrowRight' && row.children.length) {
      if (!expanded.has(row.id)) toggle(row.id);
      else move(row.children[0]);
    }
    if (event.key === 'Enter' || event.key === ' ') choose(row.id);
  }
  const indent = compact ? 16 : 14;
  return (
    <div
      id={id}
      role="tree"
      aria-labelledby={labelledBy}
      className={compact ? 'folder-picker-tree is-compact' : 'folder-picker-tree'}
    >
      {rows.map((row, index) => {
        const node = nodes.get(row.id)!;
        const isOpen = expanded.has(row.id);
        const Icon = isOpen ? FolderOpen : Folder;
        return (
          <div
            key={row.id}
            ref={element => {
              if (element) items.current.set(row.id, element);
              else items.current.delete(row.id);
            }}
            role="treeitem"
            aria-label={node.title || t('根目录')}
            aria-level={row.depth}
            aria-posinset={row.pos}
            aria-setsize={row.size}
            aria-selected={row.id === value}
            aria-expanded={row.children.length ? isOpen : undefined}
            aria-disabled={disabled || !node.childrenWritable}
            tabIndex={!disabled && row.id === active ? 0 : -1}
            className="folder-picker-row"
            style={{ paddingInlineStart: 4 + Math.min(row.depth - 1, compact ? 8 : 6) * indent }}
            title={paths.get(row.id)}
            onFocus={() => setFocus(row.id)}
            onClick={() => choose(row.id)}
            onKeyDown={event => keys(event, index)}
          >
            {row.children.length ? (
              <button
                type="button"
                tabIndex={-1}
                disabled={disabled}
                className="folder-picker-toggle"
                aria-label={t(isOpen ? '收起目录：{folder}' : '展开目录：{folder}', { folder: node.title })}
                onClick={event => {
                  event.stopPropagation();
                  toggle(row.id);
                }}
              >
                <ChevronRight aria-hidden="true" className={isOpen ? 'is-open' : undefined} />
              </button>
            ) : (
              <span className="folder-picker-leaf" />
            )}
            <Icon aria-hidden="true" />
            <span className="folder-picker-name">{node.title || t('根目录')}</span>
            {row.id === value && <Check aria-hidden="true" className="folder-picker-check" />}
          </div>
        );
      })}
      {!rows.length && <p className="hint">{t('暂无可选目录')}</p>}
    </div>
  );
}

/** A local single-folder draft picker. Expansion and focus never grant write authority. */
export function FolderTreePicker({
  tree,
  value,
  onChange,
  disabled = false,
  label,
}: {
  tree: TreeSnapshot;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  label: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const { title, path } = useFolderLabel(tree, value);
  return (
    <div
      className="folder-picker"
      onKeyDown={event => {
        if (open && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <span id={`${id}-label`} className="folder-picker-label">
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        className="folder-picker-trigger"
        aria-label={label}
        aria-haspopup="tree"
        aria-expanded={open}
        aria-controls={`${id}-tree`}
        disabled={disabled}
        title={path}
        onClick={() => {
          if (!open) setExpanded(new Set([...expanded, ...folderAncestors(tree, value)]));
          setOpen(previous => !previous);
        }}
      >
        <Folder aria-hidden="true" />
        <span>
          <strong>{title || t('请明确选择目录')}</strong>
          {path && path !== title && <small>{path}</small>}
        </span>
        <ChevronDown aria-hidden="true" className={open ? 'is-open' : undefined} />
      </button>
      {open && (
        <FolderTree
          id={`${id}-tree`}
          labelledBy={`${id}-label`}
          tree={tree}
          value={value}
          disabled={disabled}
          expanded={expanded}
          onExpandedChange={setExpanded}
          onChoose={key => {
            onChange(key);
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      )}
    </div>
  );
}
