import type { TreeSnapshot } from './node-reference';
import { scopeNodes, type OrganizeProposal } from './organize-proposal';
import { duplicateGroups } from './suspected-duplicates';
export type DuplicateChoice = 'keep' | 'delete' | 'unselected';
export function exactDuplicates(tree: TreeSnapshot, rootId: string) {
  const groups = new Map<string, TreeSnapshot['nodes']>();
  for (const node of scopeNodes(tree, rootId))
    if (node.ref.kind === 'bookmark' && node.url !== undefined) {
      const group = groups.get(node.url) ?? [];
      group.push(structuredClone(node));
      groups.set(node.url, group);
    }
  return [...groups].filter(([, items]) => items.length > 1).map(([url, items]) => ({ url, items }));
}
export function duplicateProposal(
  tree: TreeSnapshot,
  rootId: string,
  choices: Record<string, DuplicateChoice>,
  includeSuspected = false,
): OrganizeProposal {
  const nodes = scopeNodes(tree, rootId);
  const groups = includeSuspected ? duplicateGroups(tree, rootId) : exactDuplicates(tree, rootId);
  const members = new Set(groups.flatMap(group => group.items.map(node => node.ref.nativeId)));
  if (Object.keys(choices).some(id => !members.has(id))) throw Error('unknown-duplicate');
  const actions: OrganizeProposal['actions'] = [];
  for (const group of groups) {
    const deleted = group.items.filter(n => choices[n.ref.nativeId] === 'delete');
    if (deleted.length && !group.items.some(n => choices[n.ref.nativeId] === 'keep'))
      throw Error('explicit-keep-required');
    for (const node of deleted) {
      if (node.readOnly) throw Error('protected-source');
      actions.push({
        id: `delete:${node.ref.nativeId}`,
        kind: 'delete',
        sourceId: node.ref.nativeId,
        title: node.title,
        children: [],
        reason:
          'suspected' in group && group.suspected
            ? '经逐条确认清理疑似重复链接，保留明确指定的副本。'
            : '清理链接完全相同的重复书签，保留明确指定的副本。',
      });
    }
  }
  return {
    tree: structuredClone(tree),
    scope: structuredClone(nodes.find(n => n.ref.nativeId === rootId)!.ref),
    actions,
    targetIds: [],
  };
}
