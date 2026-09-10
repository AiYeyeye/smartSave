import type { TreeSnapshot } from './node-reference';
import { scopeNodes, type OrganizeProposal } from './organize-proposal';
export type DuplicateChoice = 'keep' | 'delete' | 'unselected';
export function exactDuplicates(tree: TreeSnapshot, rootId: string) {
  const groups = new Map<string, TreeSnapshot['nodes']>();
  for (const node of scopeNodes(tree, rootId)) if (node.ref.kind === 'bookmark' && node.url !== undefined) {
    const group = groups.get(node.url) ?? []; group.push(structuredClone(node)); groups.set(node.url, group);
  }
  return [...groups].filter(([, items]) => items.length > 1).map(([url, items]) => ({ url, items }));
}
export function duplicateProposal(tree: TreeSnapshot, rootId: string, choices: Record<string, DuplicateChoice>): OrganizeProposal {
  const nodes = scopeNodes(tree, rootId); const groups = exactDuplicates(tree, rootId);
  if (Object.keys(choices).some(id => !groups.some(g => g.items.some(n => n.ref.nativeId === id)))) throw Error('unknown-duplicate');
  const actions: OrganizeProposal['actions'] = [];
  for (const group of groups) {
    const deleted = group.items.filter(n => choices[n.ref.nativeId] === 'delete');
    if (deleted.length && !group.items.some(n => choices[n.ref.nativeId] === 'keep')) throw Error('explicit-keep-required');
    for (const node of deleted) { if (node.readOnly) throw Error('protected-source'); actions.push({ id: `delete:${node.ref.nativeId}`, kind: 'delete', sourceId: node.ref.nativeId, title: node.title, children: [] }); }
  }
  return { tree: structuredClone(tree), scope: structuredClone(nodes.find(n => n.ref.nativeId === rootId)!.ref), actions, targetIds: [] };
}
