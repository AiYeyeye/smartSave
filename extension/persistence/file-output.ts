import { z } from 'zod';
import { nodeRefSchema } from '../domain/node-reference';
import type { ExportScope } from '../domain/export-projection';
import { openOperationsDatabase } from './operations-database';

export interface OutputFileHandle {
  readonly kind: 'file';
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}
const scopeSchema = z
  .object({
    roots: z.array(nodeRefSchema.strict()).min(1),
    excludedFolders: z.array(nodeRefSchema.strict()),
    excludedBookmarks: z.array(nodeRefSchema.strict()).optional(),
  })
  .strict();
const metadataSchema = z
  .object({
    version: z.literal(1),
    generation: z.string().min(1),
    controlRevision: z.number().int().nonnegative().default(0),
    enabled: z.boolean(),
    scope: scopeSchema,
    ancestry: z.array(z.array(z.string())),
    status: z.enum(['pending', 'success', 'paused', 'needs-permission', 'scope-invalid', 'stopped']),
    lastSuccess: z.string().optional(),
  })
  .strict();
export type FileOutputMetadata = z.infer<typeof metadataSchema>;
export type FileOutputRecord = FileOutputMetadata & { handle: OutputFileHandle };
function parse(value: unknown): FileOutputRecord {
  if (!value || typeof value !== 'object' || !('handle' in value)) throw Error('file-output-storage');
  const { handle, ...metadata } = value;
  if (
    !handle ||
    typeof handle !== 'object' ||
    !('kind' in handle) ||
    handle.kind !== 'file' ||
    !('queryPermission' in handle) ||
    typeof handle.queryPermission !== 'function' ||
    !('createWritable' in handle) ||
    typeof handle.createWritable !== 'function'
  )
    throw Error('file-output-storage');
  return { ...metadataSchema.parse(metadata), handle: handle as OutputFileHandle };
}
const controlSchema = z
  .object({ version: z.literal(1), revision: z.number().int().nonnegative(), leases: z.array(z.string().min(1)) })
  .strict();
export interface ConfigurationLease {
  revision: number;
  token: string;
}
const parseControl = (value: unknown) =>
  value === undefined ? { version: 1 as const, revision: 0, leases: [] as string[] } : controlSchema.parse(value);
/** Same-origin structured clone only. Never send this record through Chrome JSON messaging. */
export class FileOutputStore {
  constructor(
    private factory: IDBFactory = globalThis.indexedDB,
    private name = 'zhilan-operations',
  ) {}
  private async transaction<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore, result: (value: T) => void) => void,
  ): Promise<T> {
    const db = await openOperationsDatabase(this.factory, this.name);
    return new Promise((resolve, reject) => {
      let value: T;
      const tx = db.transaction('fileOutput', mode, { durability: 'strict' });
      tx.oncomplete = () => {
        db.close();
        resolve(value);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(Error('file-output-storage'));
      };
      try {
        action(tx.objectStore('fileOutput'), result => {
          value = result;
        });
      } catch {
        tx.abort();
      }
    });
  }
  read(): Promise<FileOutputRecord | undefined> {
    return this.transaction('readonly', (store, result) => {
      const read = store.get('target');
      const authority = store.get('control');
      authority.onsuccess = () => {
        try {
          const control = parseControl(authority.result);
          const target = read.result === undefined ? undefined : parse(read.result);
          if (target?.enabled && target.controlRevision !== control.revision) throw Error('file-output-storage');
          result(target);
        } catch {
          store.transaction.abort();
        }
      };
    });
  }
  /** Authority exists even before the first target. Status checkpoints never advance it. */
  issueLease(): Promise<ConfigurationLease> {
    const token = crypto.randomUUID();
    return this.transaction('readwrite', (store, result) => {
      const request = store.get('control');
      request.onsuccess = () => {
        try {
          const control = parseControl(request.result);
          control.leases.push(token);
          store.put(control, 'control');
          result({ revision: control.revision, token });
        } catch {
          store.transaction.abort();
        }
      };
    });
  }
  validateLease(lease: ConfigurationLease): Promise<boolean> {
    return this.transaction('readonly', (store, result) => {
      const request = store.get('control');
      request.onsuccess = () => {
        try {
          const control = parseControl(request.result);
          result(control.revision === lease.revision && control.leases.includes(lease.token));
        } catch {
          store.transaction.abort();
        }
      };
    });
  }
  /** Stop invalidation + disable, or lease check + disable, share one commit. */
  stop(lease?: ConfigurationLease): Promise<number | undefined> {
    return this.transaction('readwrite', (store, result) => {
      const request = store.get('control');
      request.onsuccess = () => {
        try {
          const control = parseControl(request.result);
          if (lease && (control.revision !== lease.revision || !control.leases.includes(lease.token))) {
            result(undefined);
            return;
          }
          if (!lease) {
            control.revision++;
            control.leases = [];
          }
          store.put(control, 'control');
          const target = store.get('target');
          target.onsuccess = () => {
            try {
              if (target.result !== undefined)
                store.put(parse({ ...parse(target.result), enabled: false, status: 'stopped' }), 'target');
              result(control.revision);
            } catch {
              store.transaction.abort();
            }
          };
        } catch {
          store.transaction.abort();
        }
      };
    });
  }
  async configure(
    handle: OutputFileHandle,
    scope: ExportScope,
    ancestry: string[][],
    lease: ConfigurationLease,
  ): Promise<string> {
    const record = parse({
      version: 1,
      generation: crypto.randomUUID(),
      controlRevision: lease.revision + 1,
      enabled: true,
      scope,
      ancestry,
      status: 'pending',
      handle,
    });
    const generation = await this.transaction<string | undefined>('readwrite', (store, result) => {
      const request = store.get('control');
      request.onsuccess = () => {
        try {
          const control = parseControl(request.result);
          if (control.revision !== lease.revision || !control.leases.includes(lease.token)) {
            result(undefined);
            return;
          }
          // The handle clone, revision CAS, and single-use lease consumption are atomic.
          store.put(record, 'target');
          store.put({ version: 1, revision: record.controlRevision, leases: [] }, 'control');
          result(record.generation);
        } catch {
          store.transaction.abort();
        }
      };
    });
    if (generation === undefined) throw Error('file-output-conflict');
    return generation;
  }
  update(
    generation: string,
    changes: Pick<FileOutputMetadata, 'status'> & Partial<Pick<FileOutputMetadata, 'enabled' | 'lastSuccess'>>,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    return this.transaction('readwrite', (store, result) => {
      const read = store.get('target');
      read.onsuccess = () => {
        try {
          const current = parse(read.result);
          if (!isCurrent() || !current.enabled || current.generation !== generation) {
            result(false);
            return;
          }
          store.put(parse({ ...current, ...changes }), 'target');
          result(true);
        } catch {
          store.transaction.abort();
        }
      };
    });
  }
}
