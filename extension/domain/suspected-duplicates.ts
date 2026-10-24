import type { TreeSnapshot } from './node-reference';
import { scopeNodes } from './organize-proposal';

export type DuplicateGroup = { url: string; items: TreeSnapshot['nodes']; suspected?: boolean };

/** Comparison only: never replace a bookmark URL with this key or use it to open a page. */
export function suspectedDuplicateKey(raw: string): string | undefined {
  // Reject URL-parser repairs; preserve path/query/fragment bytes other than the stated comparison rules.
  if (/[\s\\\p{Cc}]/u.test(raw)) return;
  const parts = /^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/iu.exec(raw);
  if (!parts) return;
  try {
    const url = new URL(raw);
    if (url.username || url.password || !url.hostname) return;
    const host = url.hostname.replace(/^www\./iu, '');
    if (!host) return;
    // Explicit ports may identify different services; do not merge them with an implicit default.
    const port = /:(\d+)$/u.exec(parts[2]!)?.[1] ?? '';
    const path = parts[3]!.replace(/\/+$/u, '');
    const query = parts[4]
      ?.slice(1)
      .split('&')
      .filter(part => {
        const key = decodeURIComponent(part.split('=')[0]!.replace(/\+/gu, ' '));
        return !/^utm_/iu.test(key);
      });
    return JSON.stringify([host, port, path, query?.length ? `?${query.join('&')}` : '', parts[5] ?? '']);
  } catch {
    return;
  }
}

/** Disjoint review groups: variants and their exact copies share one explicit keep/delete decision. */
export function duplicateGroups(tree: TreeSnapshot, rootId: string): DuplicateGroup[] {
  return groupDuplicateNodes(scopeNodes(tree, rootId));
}

/** Shared local grouping; callers own their read scope, never a synthetic writable root. */
export function groupDuplicateNodes(nodes: TreeSnapshot['nodes']): DuplicateGroup[] {
  const groups = new Map<string, TreeSnapshot['nodes']>();
  for (const node of nodes) {
    if (node.ref.kind !== 'bookmark' || node.url === undefined) continue;
    const key = suspectedDuplicateKey(node.url);
    const identity = key === undefined ? `raw:${node.url}` : `suspected:${key}`;
    const group = groups.get(identity) ?? [];
    group.push(structuredClone(node));
    groups.set(identity, group);
  }
  return [...groups.values()]
    .filter(items => items.length > 1)
    .map(items => ({
      url: items[0]!.url!,
      items,
      ...(new Set(items.map(node => node.url)).size > 1 ? { suspected: true } : {}),
    }))
    .sort((a, b) => Number(!!a.suspected) - Number(!!b.suspected));
}
