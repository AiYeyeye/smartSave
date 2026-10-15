import type { TreeSnapshot } from './node-reference';
import { organizeCompilation, type OrganizeAction, type OrganizeProposal } from './organize-proposal';

/** Prefer the first writable native root in browser order, without matching localized titles. */
export function defaultOrganizeScope(tree: TreeSnapshot): string {
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  const pending = [...tree.roots];
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    if (node?.ref.kind !== 'folder') continue;
    if (node.childrenWritable) return id;
    pending.push(...node.childrenIds);
  }
  return '';
}

export function organizePaths(tree?: TreeSnapshot) {
  const nodes = new Map(tree?.nodes.map(n => [n.ref.nativeId, n]));
  const paths = new Map<string, string>();
  for (const id of nodes.keys()) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined && !paths.has(current) && nodes.has(current) && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      current = nodes.get(current)!.parentId;
    }
    let prefix = current === undefined ? '' : (paths.get(current) ?? '');
    for (const child of chain.reverse()) {
      prefix = [prefix, nodes.get(child)!.title || '根目录'].filter(Boolean).join(' / ');
      paths.set(child, prefix);
    }
  }
  return paths;
}
export function organizeReview(proposal: OrganizeProposal, selected: string[], targets: Record<string, string>) {
  if (!selected.length) return { tree: proposal.tree };
  try {
    return { tree: organizeCompilation(proposal, selected, targets, 'preview-only').plan.simulated };
  } catch {
    return { error: '当前选择或目标存在冲突，请调整建议；不能执行，也不会显示未经校验的整理后分类。' };
  }
}
/** New folder IDs are ephemeral: use their intended path when remembering a refusal. */
export function organizeRejectionKey(
  proposal: OrganizeProposal,
  action: OrganizeAction,
  targets: Record<string, string>,
) {
  const paths = organizePaths(proposal.tree);
  const targetPath = (id: string, seen = new Set<string>()): string => {
    if (seen.has(id)) return '';
    seen.add(id);
    const created = proposal.actions.find(a => a.kind === 'create' && a.sourceId === id);
    return created
      ? `${targetPath(targets[created.id] ?? created.targetId ?? '', seen)} / ${created.title}`
      : (paths.get(id) ?? id);
  };
  return JSON.stringify({
    kind: action.kind,
    source: action.kind === 'create' ? action.title : [action.sourceId, paths.get(action.sourceId)],
    target: targetPath(targets[action.id] ?? action.targetId ?? ''),
    title: action.newTitle ?? '',
  });
}
