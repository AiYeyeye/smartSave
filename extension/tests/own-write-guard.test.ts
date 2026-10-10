import { expect, it, vi } from 'vitest';
import type { BookmarkWriter } from '../adapters/bookmarks-write';
import { OwnWriteGuard } from '../background/own-write-guard';

it('marks ids returned from wrapped create and expires them after ttl', async () => {
  vi.useFakeTimers();
  const create = vi.fn(async () => ({ syncing: false, id: 'n1', title: 't' }) as chrome.bookmarks.BookmarkTreeNode);
  const writer: BookmarkWriter = {
    create,
    update: async () => ({ syncing: false, id: 'x' }) as chrome.bookmarks.BookmarkTreeNode,
    move: async () => ({ syncing: false, id: 'x' }) as chrome.bookmarks.BookmarkTreeNode,
    remove: async () => {},
  };
  const guard = new OwnWriteGuard(1000);
  const wrapped = guard.wrap(writer);
  expect(guard.isOwn('n1')).toBe(false);
  await wrapped.create({ parentId: 'p', title: 't', url: 'https://a.test/' });
  expect(guard.isOwn('n1')).toBe(true);
  vi.advanceTimersByTime(1001);
  expect(guard.isOwn('n1')).toBe(false);
  vi.useRealTimers();
});
