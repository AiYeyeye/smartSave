import { useMemo, useRef, useEffect, useState, type CSSProperties } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import type { ExportScope } from '../domain/export-projection';
import { exportSelection, toggleExportSelection } from '../domain/export-selection';
import type { TreeSnapshot } from '../domain/node-reference';
import { BookmarkFavicon } from '../ui/BookmarkFavicon';

function SelectionCheck({ mixed, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { mixed: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = mixed;
  }, [mixed]);
  return <input {...props} ref={input} type="checkbox" aria-checked={mixed ? 'mixed' : props.checked} />;
}

export function ExportTreeSelector({
  tree,
  scope,
  disabled,
  onChange,
}: {
  tree: TreeSnapshot;
  scope: ExportScope;
  disabled: boolean;
  onChange: (scope: ExportScope) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const nodes = useMemo(() => new Map(tree.nodes.map(node => [node.ref.nativeId, node])), [tree]);
  const selected = useMemo(() => exportSelection(tree, scope), [tree, scope]);
  const counts = useMemo(() => {
    const counts = new Map<string, { all: number; chosen: number }>();
    const visit = (id: string): { all: number; chosen: number } => {
      const node = nodes.get(id);
      if (!node || counts.has(id)) return counts.get(id) ?? { all: 0, chosen: 0 };
      const count = { all: 0, chosen: 0 };
      counts.set(id, count);
      if (!node.childrenIds.length) {
        count.all = 1;
        count.chosen = selected.has(id) ? 1 : 0;
      }
      for (const child of node.childrenIds) {
        const value = visit(child);
        count.all += value.all;
        count.chosen += value.chosen;
      }
      return count;
    };
    tree.roots.forEach(visit);
    return counts;
  }, [tree, nodes, selected]);
  const rows: { id: string; depth: number }[] = [];
  const seen = new Set<string>();
  function walk(id: string, depth: number) {
    const node = nodes.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    if (node.parentId === undefined) {
      node.childrenIds.forEach(child => walk(child, depth));
      return;
    }
    rows.push({ id, depth });
    if (!collapsed.has(id)) node.childrenIds.forEach(child => walk(child, depth + 1));
  }
  tree.roots.forEach(id => walk(id, 0));
  return (
    <ul className="bookmark-tree export-tree" aria-label="选择导出内容">
      {rows.map(({ id, depth }) => {
        const node = nodes.get(id)!;
        const folder = node.ref.kind === 'folder';
        const count = counts.get(id)!;
        const expanded = !collapsed.has(id);
        const title = node.title || (folder ? '未命名目录' : node.url || '未命名书签');
        return (
          <li key={id} className="bookmark-row export-tree-row" style={{ '--depth': depth } as CSSProperties}>
            {folder && node.childrenIds.length > 0 ? (
              <button
                type="button"
                className="export-tree-expand"
                aria-label={`${expanded ? '收起' : '展开'} ${title}`}
                aria-expanded={expanded}
                onClick={() =>
                  setCollapsed(old => {
                    const next = new Set(old);
                    if (expanded) next.add(id);
                    else next.delete(id);
                    return next;
                  })
                }
              >
                <ChevronRight style={{ transform: expanded ? 'rotate(90deg)' : undefined }} />
              </button>
            ) : (
              <span className="export-tree-spacer" />
            )}
            <label>
              <SelectionCheck
                aria-label={`导出 ${title}`}
                disabled={disabled}
                checked={count.chosen === count.all}
                mixed={count.chosen > 0 && count.chosen < count.all}
                onChange={e => onChange(toggleExportSelection(tree, scope, id, e.target.checked))}
              />
              {folder ? <Folder aria-hidden="true" /> : <BookmarkFavicon url={node.url!} />}
              <span className="export-tree-title" title={node.url || title}>
                {title}
              </span>
              {folder && (
                <span className="row-count">
                  {count.chosen}/{count.all}
                </span>
              )}
            </label>
          </li>
        );
      })}
    </ul>
  );
}
