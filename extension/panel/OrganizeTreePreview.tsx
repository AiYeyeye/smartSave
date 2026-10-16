import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import type { TreeSnapshot } from '../domain/node-reference';
import type { OrganizeProposal } from '../domain/organize-proposal';
import { useI18n } from '../ui/i18n';

export function OrganizeTreePreview({
  proposal,
  after,
  selected,
}: {
  proposal: OrganizeProposal;
  after: TreeSnapshot;
  selected: string[];
}) {
  const { t, message, language } = useI18n();
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
    <section className="organize-tree-preview" aria-label={t('整体分类预览')}>
      <h3>{t(before ? '整理前的分类' : '预计整理后的分类')}</h3>
      <div className="actions">
        <button aria-pressed={!before} onClick={() => setBefore(false)}>
          {t('整理后')}
        </button>
        <button aria-pressed={before} onClick={() => setBefore(true)}>
          {t('整理前')}
        </button>
        <button onClick={() => setCollapsed(new Set())}>{t('展开全部分类')}</button>
      </div>
      <p className="workflow-summary">
        {t('新增 {create} · 移动 {move} · 合并 {merge} · 重命名 {rename} · 清理 {remove}', {
          create: countKind('create'),
          move: countKind('move'),
          merge: countKind('merge'),
          rename: countKind('rename'),
          remove: countKind('delete'),
        })}
      </p>
      <ul className="organize-classification-tree" aria-label={t(before ? '整理前分类树' : '整理后分类树')}>
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
                  aria-label={t(collapsed.has(row.id) ? '展开分类 {title}' : '收起分类 {title}', { title: node.title })}
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
                <strong>{node.title || t('根目录')}</strong>
                {!!changes.length && <small>{changes.map(message).join(language === 'en' ? ', ' : '、')}</small>}
                <span>{t('{count} 条书签', { count: row.count })}</span>
              </div>
              {!!bookmarks.length && (
                <details className="organize-folder-bookmarks">
                  <summary>{t('查看本层 {count} 条书签', { count: bookmarks.length })}</summary>
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
