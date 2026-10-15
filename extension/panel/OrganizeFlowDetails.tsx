import { useMemo } from 'react';
import { organizePaths } from '../domain/organize-review';
import { scopeNodes, type OrganizeProposal } from '../domain/organize-proposal';
import type { TreeSnapshot } from '../domain/node-reference';

export function OrganizeFlowDetails({ proposal, after }: { proposal: OrganizeProposal; after: TreeSnapshot }) {
  const groups = useMemo(() => {
    const beforePaths = organizePaths(proposal.tree);
    const afterPaths = organizePaths(after);
    const next = new Map(after.nodes.map(n => [n.ref.nativeId, n]));
    const result = new Map<string, Map<string, string[]>>();
    for (const node of scopeNodes(proposal.tree, proposal.scope.nativeId)) {
      if (node.ref.kind !== 'bookmark') continue;
      const from = beforePaths.get(node.parentId ?? '') ?? '';
      const target = next.get(node.ref.nativeId);
      const to = target ? (afterPaths.get(target.parentId ?? '') ?? '') : '删除重复书签';
      if (from === to) continue;
      const destinations = result.get(from) ?? new Map<string, string[]>();
      destinations.set(to, [...(destinations.get(to) ?? []), node.title]);
      result.set(from, destinations);
    }
    return result;
  }, [proposal, after]);
  return (
    <section className="organize-flow-details" aria-label="分类内容去向">
      <h3>分类如何拆分与合并</h3>
      {groups.size === 0 && <p className="hint">当前选择不改变书签的分类路径；目录清理和其他调整见下方。</p>}
      {[...groups].map(([from, destinations]) => (
        <article key={from}>
          <h4>{from}</h4>
          <p className="hint">
            {destinations.size > 1 ? `分别归入 ${destinations.size} 个去向` : '整体去向如下'}
            ；下方只列出路径发生变化的书签。
          </p>
          {[...destinations].map(([to, titles]) => (
            <details key={to}>
              <summary>
                → {to} · {titles.length} 条书签
              </summary>
              <ul>
                {titles.map((title, index) => (
                  <li key={index}>{title}</li>
                ))}
              </ul>
            </details>
          ))}
        </article>
      ))}
    </section>
  );
}
