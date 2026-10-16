import { useMemo } from 'react';
import { organizePaths } from '../domain/organize-review';
import { scopeNodes, type OrganizeProposal } from '../domain/organize-proposal';
import type { TreeSnapshot } from '../domain/node-reference';
import { useI18n } from '../ui/i18n';

export function OrganizeFlowDetails({ proposal, after }: { proposal: OrganizeProposal; after: TreeSnapshot }) {
  const { t } = useI18n();
  const groups = useMemo(() => {
    const beforePaths = organizePaths(proposal.tree);
    const afterPaths = organizePaths(after);
    const next = new Map(after.nodes.map(n => [n.ref.nativeId, n]));
    const result = new Map<string, Map<string | null, string[]>>();
    for (const node of scopeNodes(proposal.tree, proposal.scope.nativeId)) {
      if (node.ref.kind !== 'bookmark') continue;
      const from = beforePaths.get(node.parentId ?? '') ?? '';
      const target = next.get(node.ref.nativeId);
      const to = target ? (afterPaths.get(target.parentId ?? '') ?? '') : null;
      if (from === to) continue;
      const destinations = result.get(from) ?? new Map<string | null, string[]>();
      destinations.set(to, [...(destinations.get(to) ?? []), node.title]);
      result.set(from, destinations);
    }
    return result;
  }, [proposal, after]);
  if (!groups.size) return null;
  return (
    <section className="organize-flow-details" aria-label={t('分类内容去向')}>
      <h3>{t('分类如何拆分与合并')}</h3>
      {[...groups].map(([from, destinations]) => (
        <article key={from}>
          <h4>{from}</h4>
          {[...destinations].map(([to, titles]) => (
            <details key={to === null ? 'removed' : `path:${to}`}>
              <summary>
                {t('→ {destination} · {count} 条书签', { destination: to ?? t('删除重复书签'), count: titles.length })}
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
