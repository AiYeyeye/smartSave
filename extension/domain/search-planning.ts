import type { TreeSnapshot } from './node-reference';
import type { SearchHit } from './search-index';
import { SEARCH_FOLDER_CHUNK, SEARCH_LOCAL_PRIORITY } from './search-limits';

/** Direct parents partition the catalog once, including bookmarks in browser root folders. */
export function searchFolderIds(tree: TreeSnapshot, candidates: readonly SearchHit[]): string[] {
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  return [
    ...new Set(
      candidates.flatMap(hit => {
        const parent = nodes.get(hit.id)?.parentId;
        return parent !== undefined && nodes.get(parent)?.ref.kind === 'folder' ? [parent] : [];
      }),
    ),
  ];
}

/** Priority affects order only. Every permitted candidate survives, exactly once. */
export function prioritizeSearchCandidates(
  tree: TreeSnapshot,
  candidates: readonly SearchHit[],
  folderIds: readonly string[],
  localIds: readonly string[],
): string[] {
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  const allowed = new Set(candidates.map(hit => hit.id));
  const result = [...new Set(localIds)].filter(id => allowed.has(id)).slice(0, SEARCH_LOCAL_PRIORITY);
  const seen = new Set(result);
  const groups = new Map<string, string[]>(folderIds.map(id => [id, []]));
  for (const hit of candidates) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    const parent = nodes.get(hit.id)?.parentId ?? '';
    const group = groups.get(parent) ?? [];
    group.push(hit.id);
    groups.set(parent, group);
  }
  // Take a bounded piece of each folder in priority order, so one huge folder cannot monopolize the search.
  let pending = [...groups.values()].filter(group => group.length);
  for (let offset = 0; pending.length; offset += SEARCH_FOLDER_CHUNK) {
    for (const group of pending) result.push(...group.slice(offset, offset + SEARCH_FOLDER_CHUNK));
    pending = pending.filter(group => group.length > offset + SEARCH_FOLDER_CHUNK);
  }
  return result;
}

/** Asking for complete coverage opts out of the first-results pause; it never narrows the query. */
export function requestsAllSearchMatches(query: string): boolean {
  return /所有|全部|每一|\b(?:all|every)\b/i.test(query);
}
