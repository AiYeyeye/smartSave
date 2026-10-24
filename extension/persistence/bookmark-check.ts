import { bookmarkCheckStateSchema, emptyBookmarkCheck, type BookmarkCheckState } from '../domain/bookmark-check';

export interface BookmarkCheckPersistence {
  read(): Promise<BookmarkCheckState>;
  write(state: BookmarkCheckState): Promise<void>;
}

/** Local advisory reports have their own database, separate from authoritative mutation journals. */
export class BookmarkCheckStore implements BookmarkCheckPersistence {
  private db?: Promise<IDBDatabase>;
  constructor(
    private readonly factory: IDBFactory = indexedDB,
    private readonly name = 'zhilan-bookmark-check',
  ) {}
  private open() {
    if (!this.db)
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.factory.open(this.name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('state');
        request.onerror = () => reject(Error('storage-unavailable'));
        request.onblocked = () => reject(Error('storage-unavailable'));
        request.onsuccess = () => {
          request.result.onversionchange = () => {
            request.result.close();
            this.db = undefined;
          };
          resolve(request.result);
        };
      }).catch(error => {
        this.db = undefined;
        throw error;
      });
    return this.db;
  }
  async read() {
    const db = await this.open();
    return new Promise<BookmarkCheckState>((resolve, reject) => {
      const tx = db.transaction('state', 'readonly');
      const request = tx.objectStore('state').get('current');
      tx.onerror = tx.onabort = () => reject(Error('storage-unavailable'));
      tx.oncomplete = () => {
        if (request.result === undefined) return resolve(emptyBookmarkCheck());
        const parsed = bookmarkCheckStateSchema.safeParse(request.result);
        if (parsed.success) resolve(parsed.data);
        else reject(Error('storage-unavailable'));
      };
    });
  }
  async write(state: BookmarkCheckState) {
    const value = bookmarkCheckStateSchema.parse(state);
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(Error('storage-unavailable'));
      tx.objectStore('state').put(value, 'current');
    });
  }
}
