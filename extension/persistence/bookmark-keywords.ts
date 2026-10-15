import {
  BOOKMARK_KEYWORDS_LIMIT,
  bookmarkKeywordListSchema,
  bookmarkKeywordRecordSchema,
  currentBookmarkKeywords,
  type BookmarkKeywordRecord,
} from '../domain/bookmark-keywords';
import type { TreeSnapshot } from '../domain/node-reference';

export const BOOKMARK_KEYWORDS_KEY = 'bookmarkSearchKeywords.v1';
type Area = { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
export async function readBookmarkKeywords(area: Pick<Area, 'get'>): Promise<BookmarkKeywordRecord[]> {
  const stored = await area.get(BOOKMARK_KEYWORDS_KEY);
  const parsed = bookmarkKeywordListSchema.safeParse(stored[BOOKMARK_KEYWORDS_KEY] ?? []);
  return parsed.success ? parsed.data : [];
}

/** One worker writer; advisory local metadata is never mutation authority or model configuration. */
export class BookmarkKeywordsStore {
  private chain: Promise<unknown> = Promise.resolve();
  private records?: BookmarkKeywordRecord[];
  private loading?: Promise<BookmarkKeywordRecord[]>;
  constructor(
    private readonly area: Area,
    private readonly fresh: () => Promise<TreeSnapshot>,
  ) {}
  read(): Promise<BookmarkKeywordRecord[]> {
    if (this.records) return Promise.resolve(this.records);
    return (this.loading ??= readBookmarkKeywords(this.area)
      .then(records => {
        this.records = records;
        return records;
      })
      .finally(() => {
        this.loading = undefined;
      }));
  }
  private enqueue(operation: () => Promise<void>) {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => {});
    return next;
  }
  private async persist(next: BookmarkKeywordRecord[]) {
    // Bound actual UTF-8 storage size as well as item count; retain the most recently enriched entries.
    let bytes = 2;
    const encoder = new TextEncoder();
    let start = next.length;
    while (start > 0) {
      const size = encoder.encode(JSON.stringify(next[start - 1])).byteLength + 1;
      if (bytes + size > 2 * 1024 * 1024) break;
      bytes += size;
      start--;
    }
    next = next.slice(start);
    if (JSON.stringify(next) === JSON.stringify(this.records)) return;
    await this.area.set({ [BOOKMARK_KEYWORDS_KEY]: next });
    this.records = next;
  }
  remember(raw: BookmarkKeywordRecord) {
    return this.enqueue(async () => {
      const record = bookmarkKeywordRecordSchema.parse(raw);
      if (!record.keywords.length) return;
      const stored = await this.read();
      const tree = await this.fresh();
      if (!currentBookmarkKeywords(tree, [record]).length) return;
      const next = currentBookmarkKeywords(tree, stored).filter(item => item.nativeId !== record.nativeId);
      record.keywords = [...new Set(record.keywords)];
      next.push(record);
      await this.persist(next.slice(-BOOKMARK_KEYWORDS_LIMIT));
    });
  }
  prune() {
    return this.enqueue(async () => {
      const stored = await this.read();
      if (!stored.length) return;
      await this.persist(currentBookmarkKeywords(await this.fresh(), stored));
    });
  }
}

/** Shared page reader; a late initial read cannot replace a newer storage event. */
export function watchBookmarkKeywords(receive: (records: BookmarkKeywordRecord[]) => void) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local || !chrome.storage?.onChanged) return () => {};
  let disposed = false;
  let revision = 0;
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (disposed || area !== 'local' || !Object.hasOwn(changes, BOOKMARK_KEYWORDS_KEY)) return;
    revision++;
    const parsed = bookmarkKeywordListSchema.safeParse(changes[BOOKMARK_KEYWORDS_KEY]?.newValue ?? []);
    receive(parsed.success ? parsed.data : []);
  };
  chrome.storage.onChanged.addListener(changed);
  void readBookmarkKeywords(chrome.storage.local)
    .then(records => {
      if (!disposed && revision === 0) receive(records);
    })
    .catch(() => {});
  return () => {
    disposed = true;
    chrome.storage.onChanged.removeListener(changed);
  };
}
