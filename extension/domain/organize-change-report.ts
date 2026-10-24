import type { TreeSnapshot } from './node-reference';

type Node = TreeSnapshot['nodes'][number];
const SHOWN = 3;
const short = (title: string) => (title.length > 18 ? `${title.slice(0, 18)}…` : title || '未命名');

function inScope(nodes: Map<string, Node>, node: Node, rootId: string) {
  const seen = new Set<string>();
  let cursor: Node | undefined = node;
  while (cursor && !seen.has(cursor.ref.nativeId)) {
    if (cursor.ref.nativeId === rootId) return true;
    seen.add(cursor.ref.nativeId);
    cursor = cursor.parentId === undefined ? undefined : nodes.get(cursor.parentId);
  }
  return false;
}

/**
 * What changed in the organize scope between the tree a run was built on and the tree now, in the user's terms.
 * Folders always count; bookmarks only when they belong to the run (`bookmarkIds`), or all of them when it is absent.
 */
export function organizeChanges(
  before: TreeSnapshot,
  after: TreeSnapshot,
  rootId: string,
  bookmarkIds?: readonly string[],
): string[] {
  const old = new Map(before.nodes.map(node => [node.ref.nativeId, node]));
  const now = new Map(after.nodes.map(node => [node.ref.nativeId, node]));
  const planned = bookmarkIds ? new Set(bookmarkIds) : undefined;
  const watched = (node: Node) => node.ref.kind === 'folder' || !planned || planned.has(node.ref.nativeId);
  const label = (node: Node) => `${node.ref.kind === 'folder' ? '目录' : '书签'}「${short(node.title)}」`;
  const changes: string[] = [];
  for (const node of before.nodes) {
    if (node.ref.nativeId === rootId || !watched(node) || !inScope(old, node, rootId)) continue;
    const current = now.get(node.ref.nativeId);
    if (!current) {
      changes.push(`${label(node)}被删除`);
      continue;
    }
    if (current.parentId !== node.parentId) {
      const parent = current.parentId === undefined ? undefined : now.get(current.parentId);
      changes.push(
        !inScope(now, current, rootId)
          ? `${label(node)}被移出了整理范围`
          : `${label(node)}被移到了「${short(parent?.title ?? '')}」`,
      );
    } else if (current.title !== node.title) changes.push(`${label(node)}被改名为「${short(current.title)}」`);
    else if (current.url !== node.url) changes.push(`${label(node)}的网址被修改`);
  }
  for (const node of after.nodes)
    if (!old.has(node.ref.nativeId) && watched(node) && node.ref.nativeId !== rootId && inScope(now, node, rootId))
      changes.push(`新增了${label(node)}`);
  return changes;
}

/** One line for the user: the first few changes, then how many more. */
export function organizeChangeSummary(changes: string[]): string {
  const shown = changes.slice(0, SHOWN).join('；');
  return changes.length > SHOWN ? `${shown}；等 ${changes.length} 处改动` : shown;
}
