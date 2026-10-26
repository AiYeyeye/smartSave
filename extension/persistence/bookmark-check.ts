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
    private readonly timeoutMs = 5000,
  ) {}
  private open() {
    if (!this.db)
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.factory.open(this.name, 1);
        let settled = false;
        const fail = (reason: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(Error(reason));
        };
        const timer = setTimeout(() => fail('storage-timeout'), this.timeoutMs);
        request.onupgradeneeded = () => {
          if (settled) request.transaction?.abort();
          else request.result.createObjectStore('state');
        };
        request.onerror = () => fail('storage-unavailable');
        request.onblocked = () => fail('storage-unavailable');
        request.onsuccess = () => {
          if (settled) {
            request.result.close();
            return;
          }
          settled = true;
          clearTimeout(timer);
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
    return this.transaction(db, 'readonly', tx => {
      const request = tx.objectStore('state').get('current');
      return () => {
        if (request.result === undefined) return emptyBookmarkCheck();
        const parsed = bookmarkCheckStateSchema.safeParse(request.result);
        if (parsed.success) return parsed.data;
        throw Error('storage-invalid');
      };
    });
  }
  async write(state: BookmarkCheckState) {
    const parsed = bookmarkCheckStateSchema.safeParse(state);
    if (!parsed.success) throw Error('check-failed');
    const db = await this.open();
    return this.transaction(db, 'readwrite', tx => {
      tx.objectStore('state').put(parsed.data, 'current');
      return () => {};
    });
  }
  private transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, work: (tx: IDBTransaction) => () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction('state', mode);
      } catch {
        this.db = undefined;
        db.close();
        reject(Error('storage-unavailable'));
        return;
      }
      let settled = false;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(Error(reason));
      };
      const timer = setTimeout(() => {
        fail('storage-timeout');
        // Aborting the actual transaction prevents a late write after the owner retries.
        try {
          tx.abort();
        } catch {
          // A transaction may already have finished before its completion event is delivered.
        }
        db.close();
        this.db = undefined;
      }, this.timeoutMs);
      tx.onerror = tx.onabort = () => fail('storage-unavailable');
      try {
        const value = work(tx);
        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            resolve(value());
          } catch (error) {
            reject(error);
          }
        };
      } catch {
        fail('storage-unavailable');
        try {
          tx.abort();
        } catch {
          // Setup may have failed because the transaction is already inactive.
        }
      }
    });
  }
}
