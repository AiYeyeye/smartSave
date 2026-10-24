import type { TreeSnapshot } from './node-reference';
import type { AiPrivacy } from './ai-payload';
import type { HistoryRecord } from './history-search';
import { searchCandidates } from './search-rerank';

/** An excluded bookmark URL must not re-enter model input via its history record. */
export function allowedHistory(records: HistoryRecord[], tree: TreeSnapshot, privacy: AiPrivacy): HistoryRecord[] {
  const allowed = new Set(searchCandidates(tree, privacy));
  const excluded = new Set(
    tree.nodes.filter(node => node.url && !allowed.has(node.ref.nativeId)).map(node => node.url),
  );
  return records.filter(record => !excluded.has(record.url));
}
