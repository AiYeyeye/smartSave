import type { SearchIndex } from './search-index';
import { AI_SEARCH_CANDIDATES } from './search-limits';

/** OR across bounded semantic expansions, AND inside each phrase. Private IDs never become candidates. */
export function fastSearchCandidates(index: SearchIndex, allowedIds: string[], query: string, terms: string[]) {
  if (allowedIds.length <= AI_SEARCH_CANDIDATES) return [...allowedIds];
  const allowed = new Set(allowedIds);
  const scores = new Map<string, number>();
  const order = new Map(allowedIds.map((id, i) => [id, i]));
  const phrases = [...new Set([query, ...terms].map(term => term.trim()).filter(Boolean))];
  for (const [i, phrase] of phrases.entries()) {
    index
      .query(phrase)
      .filter(hit => allowed.has(hit.id))
      .forEach((hit, rank) => {
        scores.set(hit.id, (scores.get(hit.id) ?? 0) + (i === 0 ? 2 : 1) / (rank + 1));
      });
  }
  return [...scores]
    .sort((a, b) => b[1] - a[1] || order.get(a[0])! - order.get(b[0])!)
    .slice(0, AI_SEARCH_CANDIDATES)
    .map(([id]) => id);
}
