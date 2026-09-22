export interface BookmarkWriter {
  create(details: { parentId: string; title: string; url?: string }): Promise<chrome.bookmarks.BookmarkTreeNode>;
  update(id: string, changes: { title?: string; url?: string }): Promise<chrome.bookmarks.BookmarkTreeNode>;
  move(id: string, destination: { parentId: string; index: number }): Promise<chrome.bookmarks.BookmarkTreeNode>;
  remove(id: string): Promise<void>;
}
// Only the background mutation owner receives this adapter. Never expose removeTree.
export function bookmarksWrite(api: typeof chrome.bookmarks): BookmarkWriter {
  return {
    create: details => api.create(details),
    update: (id, changes) => api.update(id, changes),
    move: (id, destination) => api.move(id, destination),
    remove: id => api.remove(id),
  };
}
