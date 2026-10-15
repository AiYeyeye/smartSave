import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import type { organizeCandidates } from './organize-proposal';

/** Bounded, provisional display only. This never constructs a writable proposal. */
export function organizeProgressPreview(text: string, candidates: ReturnType<typeof organizeCandidates>): string[] {
  const source = text
    .slice(0, 32768)
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '');
  if (!source.startsWith('{')) return [];
  const tree = parseTree(source);
  if (!tree) return [];
  const items = new Map(candidates.items.map(i => [i.id, i.title]));
  const folders = new Map(candidates.folders.map(f => [f.id, f.path?.join(' / ') || f.id]));
  const rows: string[] = [];
  const records = (key: string): Record<string, unknown>[] =>
    (findNodeAtLocation(tree, [key])?.children ?? []).flatMap(node => {
      const fragment = source.slice(node.offset, node.offset + node.length);
      if (node.type !== 'object' || !fragment.endsWith('}')) return [];
      try {
        return [JSON.parse(fragment) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  for (const f of records('newFolders')) {
    if (
      typeof f.id !== 'string' ||
      typeof f.parentId !== 'string' ||
      typeof f.title !== 'string' ||
      !f.title.trim() ||
      folders.has(f.id) ||
      items.has(f.id)
    )
      continue;
    const parent = folders.get(f.parentId);
    if (!parent) continue;
    const title = f.title.slice(0, 160);
    folders.set(f.id, title);
    rows.push(`新建目录：${parent} / ${title}`);
  }
  for (const move of records('moves')) {
    const title = typeof move.itemId === 'string' ? items.get(move.itemId) : undefined;
    const target = typeof move.folderId === 'string' ? folders.get(move.folderId) : undefined;
    if (title !== undefined && target) rows.push(`移动：${title} → ${target}`);
  }
  for (const merge of records('merges')) {
    const from = typeof merge.sourceId === 'string' ? folders.get(merge.sourceId) : undefined;
    const to = typeof merge.targetId === 'string' ? folders.get(merge.targetId) : undefined;
    if (from && to) rows.push(`合并目录：${from} → ${to}`);
  }
  return rows.slice(0, 6);
}
