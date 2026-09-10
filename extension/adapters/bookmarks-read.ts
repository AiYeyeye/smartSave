export interface BookmarkSource {
  read(): Promise<chrome.bookmarks.BookmarkTreeNode[]>;
  listen(listener: (event?: 'import-begin' | 'import-end') => void): () => void;
}
export function bookmarksRead(api: typeof chrome.bookmarks): BookmarkSource {
  return {
    read: () => api.getTree(),
    listen(listener) {
      const changed = () => listener();
      const begin = () => listener('import-begin');
      const end = () => listener('import-end');
      const events = [api.onCreated, api.onChanged, api.onMoved, api.onRemoved, api.onChildrenReordered];
      events.forEach(event => event.addListener(changed));
      api.onImportBegan.addListener(begin); api.onImportEnded.addListener(end);
      return () => { events.forEach(event => event.removeListener(changed)); api.onImportBegan.removeListener(begin); api.onImportEnded.removeListener(end); };
    },
  };
}
