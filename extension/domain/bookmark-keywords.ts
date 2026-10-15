import { z } from 'zod';
import type { TreeSnapshot } from './node-reference';

export const BOOKMARK_KEYWORDS_LIMIT = 2000;
export const bookmarkKeywordsSchema = z.array(z.string().trim().min(1).max(32)).max(5);
export const bookmarkKeywordRecordSchema = z.strictObject({
  installationId: z.string().min(1).max(200),
  nativeId: z.string().min(1).max(200),
  title: z.string().max(1000),
  url: z.string().min(1).max(8192),
  keywords: bookmarkKeywordsSchema,
});
export type BookmarkKeywordRecord = z.infer<typeof bookmarkKeywordRecordSchema>;
export const bookmarkKeywordListSchema = z.array(bookmarkKeywordRecordSchema).max(BOOKMARK_KEYWORDS_LIMIT);

/** Sidecar metadata can only enrich a currently matching native bookmark, never create a search hit. */
export function currentBookmarkKeywords(tree: TreeSnapshot, records: readonly BookmarkKeywordRecord[]) {
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  return records.filter(record => {
    const node = nodes.get(record.nativeId);
    return (
      record.installationId === tree.installationId &&
      node?.ref.kind === 'bookmark' &&
      node.title === record.title &&
      node.url === record.url
    );
  });
}
