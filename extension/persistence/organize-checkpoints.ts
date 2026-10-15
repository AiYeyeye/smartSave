import { z } from 'zod';
import { organizeCheckpointSchema, type OrganizeCheckpoint } from '../domain/organize-checkpoint';
import { openOperationsDatabase } from './operations-database';

const metadataSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
  stage: z.enum(['folders', 'bookmarks', 'complete']),
  status: z.enum(['running', 'review', 'paused', 'failed', 'invalid']),
});
export type OrganizeCheckpointMetadata = {
  id: string;
  updatedAt: number;
  stage: string;
  status: string;
  readable: boolean;
};

/** Sole durable generation-data facet. Writing a checkpoint never grants mutation authority. */
export class OrganizeCheckpointStore {
  constructor(
    private factory: IDBFactory = globalThis.indexedDB,
    private name = 'zhilan-operations',
  ) {}
  async get(id: string): Promise<OrganizeCheckpoint | undefined> {
    const db = await openOperationsDatabase(this.factory, this.name);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('organizeCheckpoints', 'readonly');
      const request = tx.objectStore('organizeCheckpoints').get(id);
      tx.oncomplete = () => {
        db.close();
        try {
          resolve(request.result === undefined ? undefined : organizeCheckpointSchema.parse(request.result));
        } catch {
          reject(Error('unsupported-organize-checkpoint'));
        }
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(Error('organize-checkpoint-unavailable'));
      };
    });
  }
  async list(): Promise<OrganizeCheckpointMetadata[]> {
    const db = await openOperationsDatabase(this.factory, this.name);
    return new Promise((resolve, reject) => {
      const rows: OrganizeCheckpointMetadata[] = [];
      const tx = db.transaction('organizeCheckpoints', 'readonly');
      const request = tx.objectStore('organizeCheckpoints').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const parsed = metadataSchema.safeParse(cursor.value);
        rows.push(
          parsed.success && parsed.data.id === cursor.key
            ? { ...parsed.data, readable: true }
            : { id: String(cursor.key), updatedAt: 0, stage: 'unknown', status: 'unknown', readable: false },
        );
        cursor.continue();
      };
      tx.oncomplete = () => {
        db.close();
        resolve(rows.sort((a, b) => b.updatedAt - a.updatedAt));
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(Error('organize-checkpoint-unavailable'));
      };
    });
  }
  async put(checkpoint: OrganizeCheckpoint, expectedRevision: number | null): Promise<void> {
    const value = organizeCheckpointSchema.parse(checkpoint);
    if (value.revision !== (expectedRevision === null ? 0 : expectedRevision + 1))
      throw Error('organize-checkpoint-conflict');
    const db = await openOperationsDatabase(this.factory, this.name);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('organizeCheckpoints', 'readwrite', { durability: 'strict' });
      const store = tx.objectStore('organizeCheckpoints');
      const request = store.get(value.id);
      let reason = 'organize-checkpoint-unavailable';
      request.onsuccess = () => {
        try {
          const previous = request.result === undefined ? undefined : organizeCheckpointSchema.parse(request.result);
          if (expectedRevision === null ? previous !== undefined : previous?.revision !== expectedRevision) {
            reason = 'organize-checkpoint-conflict';
            tx.abort();
            return;
          }
          if (previous) {
            const identity = (record: OrganizeCheckpoint) =>
              JSON.stringify({
                installationId: record.installationId,
                root: record.root,
                baseline: record.baseline,
                scopeDigest: record.scopeDigest,
                settingsDigest: record.settingsDigest,
                settingsRevision: record.settingsRevision,
                requiresCredential: record.requiresCredential,
                preference: record.preference,
                options: record.options,
                bookmarkIds: record.bookmarkIds,
              });
            if (identity(previous) !== identity(value)) {
              reason = 'organize-checkpoint-context-changed';
              tx.abort();
              return;
            }
          }
          store.put(value);
        } catch {
          reason = 'unsupported-organize-checkpoint';
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(Error(reason));
      };
    });
  }
  async remove(id: string, expectedRevision: number): Promise<void> {
    const db = await openOperationsDatabase(this.factory, this.name);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('organizeCheckpoints', 'readwrite', { durability: 'strict' });
      const store = tx.objectStore('organizeCheckpoints');
      const request = store.get(id);
      let reason = 'organize-checkpoint-unavailable';
      request.onsuccess = () => {
        const previous = organizeCheckpointSchema.safeParse(request.result);
        if (!previous.success || previous.data.revision !== expectedRevision) {
          reason = 'organize-checkpoint-conflict';
          tx.abort();
          return;
        }
        store.delete(id);
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(Error(reason));
      };
    });
  }
}
