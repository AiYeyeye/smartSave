import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import type { TreeSnapshot } from '../domain/node-reference';
import type { OrganizeProposal } from '../domain/organize-proposal';

export function OrganizeTreePreview({
  proposal,
  after,
  selected,
}: {
  proposal: OrganizeProposal;
  after: TreeSnapshot;
  selected: string[];
}) {
  const [before, setBefore] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const tree = before ? proposal.tree : after;
  const data = useMemo(() => {
    const nodes = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
    const original = new Map(proposal.tree.nodes.map(n => [n.ref.nativeId, n]));
    const rows: { id: string; depth: number; count: number }[] = [];
    const counts = new Map<string, number>();
    const count = (id: string): number => {
      if (counts.has(id)) return counts.get(id)!;
      const n = nodes.get(id);
      const value =
        n?.ref.kind === 'bookmark' ? 1 : (n?.childrenIds.reduce((total, child) => total + count(child), 0) ?? 0);
      counts.set(id, value);
      return value;
    };
    const visit = (id: string, depth: number) => {
      const node = nodes.get(id);
      if (node?.ref.kind !== 'folder') return;
      rows.push({ id, depth, count: count(id) });
      if (!collapsed.has(id)) node.childrenIds.forEach(child => visit(child, depth + 1));
    };
    visit(proposal.scope.nativeId, 0);
    return { nodes, original, rows };
  }, [tree, proposal, collapsed]);
  const actions = proposal.actions.filter(a => selected.includes(a.id));
  const countKind = (kind: string) => actions.filter(a => a.kind === kind).length;
  return (
    <section className="organize-tree-preview" aria-label="整体分类预览">
      <h3>{before ? '整理前的分类' : '预计整理后的分类'}</h3>
      <p className="hint">显示所选范围的完整分类，包括未改动的目录。勾选建议后同步更新；尚未修改书签。</p>
      <div className="actions">
        <button aria-pressed={!before} onClick={() => setBefore(false)}>
          整理后
        </button>
        <button aria-pressed={before} onClick={() => setBefore(true)}>
          整理前
        </button>
        <button onClick={() => setCollapsed(new Set())}>展开全部分类</button>
      </div>
      <p className="workflow-summary">
        新增 {countKind('create')} · 移动 {countKind('move')} · 合并 {countKind('merge')} · 重命名 {countKind('rename')}{' '}
        · 清理 {countKind('delete')}
      </p>
      <ul className="organize-classification-tree" aria-label={before ? '整理前分类树' : '整理后分类树'}>
        {data.rows.map(row => {
          const node = data.nodes.get(row.id)!;
          const original = data.original.get(row.id);
          const bookmarks = node.childrenIds.flatMap(id =>
            data.nodes.get(id)?.ref.kind === 'bookmark' ? [data.nodes.get(id)!] : [],
          );
          const hasFolders = node.childrenIds.some(id => data.nodes.get(id)?.ref.kind === 'folder');
          const changes = before
            ? []
            : [
                !original ? '新增' : '',
                original && original.title !== node.title ? '重命名' : '',
                original && original.parentId !== node.parentId ? '移动' : '',
              ].filter(Boolean);
          return (
            <li key={row.id} style={{ paddingLeft: `${Math.min(row.depth, 8) * 16}px` }}>
              <div className="organize-folder-line">
                <button
                  disabled={!hasFolders}
                  aria-label={`${collapsed.has(row.id) ? '展开' : '收起'}分类 ${node.title}`}
                  aria-expanded={hasFolders ? !collapsed.has(row.id) : undefined}
                  onClick={() =>
                    setCollapsed(old => {
                      const next = new Set(old);
                      if (next.has(row.id)) next.delete(row.id);
                      else next.add(row.id);
                      return next;
                    })
                  }
                >
                  {collapsed.has(row.id) ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </button>
                <Folder size={17} aria-hidden="true" />
                <strong>{node.title || '根目录'}</strong>
                {!!changes.length && <small>{changes.join('、')}</small>}
                <span>{row.count} 条书签</span>
              </div>
              {!!bookmarks.length && (
                <details className="organize-folder-bookmarks">
                  <summary>查看本层 {bookmarks.length} 条书签</summary>
                  <ul>
                    {bookmarks.map(n => (
                      <li key={n.ref.nativeId} title={n.title}>
                        {n.title}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
