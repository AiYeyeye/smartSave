import type { AiPrivacy } from './ai-payload';
import { serializeAiPayload } from './ai-payload';
import type { TreeSnapshot } from './node-reference';
import type { SearchHit } from './search-index';
import { parseModelOutput } from '../schemas/model-output';
export function searchCandidates(tree: TreeSnapshot, privacy: AiPrivacy, hits: SearchHit[]): string[] {
  // The task06 serializer is the only exclusion/provenance owner, including recursive ancestry.
  const payload: { items: { id: string }[] } = JSON.parse(serializeAiPayload(tree, privacy, { task: 'search', query: '', itemIds: hits.map(hit => hit.id), folderIds: [] }));
  return payload.items.map(item => item.id);
}
export function applySearchOrder(local: SearchHit[], candidates: string[], rankedIds: string[]): SearchHit[] {
  parseModelOutput({ rankedIds }, { task: 'search', items: candidates.map(id => ({ id, title: '' })), folders: [] });
  const byId = new Map(local.map(hit => [hit.id, hit]));
  if (rankedIds.some(id => !byId.has(id))) throw Error('stale-result');
  const ranked = new Set(rankedIds);
  return [...rankedIds.map(id => byId.get(id)!), ...local.filter(hit => !ranked.has(hit.id))];
}
