import { z } from 'zod';
import { bookmarkKeywordRecordSchema } from '../domain/bookmark-keywords';
import { withTrustedSender } from '../domain/trusted-sender';
import type { BookmarkKeywordsStore } from '../persistence/bookmark-keywords';
import type { TreeProjection } from './tree-projection';

const messageSchema = z.strictObject({
  type: z.literal('rememberBookmarkKeywords'),
  version: z.literal(1),
  record: bookmarkKeywordRecordSchema,
});
export function startBookmarkKeywords(store: BookmarkKeywordsStore, projection: Pick<TreeProjection, 'subscribe'>) {
  // Every completed native tree refresh also covers browser edits, import, deletion and worker restart.
  projection.subscribe(state => {
    if (state.status === 'ready') void store.prune().catch(() => {});
  });
  chrome.runtime.onMessage.addListener((raw: unknown, sender, reply) => {
    if (!raw || typeof raw !== 'object' || !('type' in raw) || raw.type !== 'rememberBookmarkKeywords') return false;
    withTrustedSender(
      sender,
      chrome.runtime.id,
      () => {
        const parsed = messageSchema.safeParse(raw);
        if (!parsed.success) {
          reply({ status: 'invalid' });
          return;
        }
        void store.remember(parsed.data.record).then(
          () => reply({ status: 'ok' }),
          () => reply({ status: 'unavailable' }),
        );
      },
      () => reply({ status: 'untrusted' }),
    );
    return true;
  });
}
