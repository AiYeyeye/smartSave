import type { ImportCheckpointStore, ImportCheckpoint } from './import-checkpoints';
import { openOperationsDatabase } from './operations-database';
import { z } from 'zod';
import { durableMutationRequestSchema, type MutationResult } from '../schemas/messages';
import { operationSchema, type OperationRecord, type OperationRecordV2 } from './operation-schema';
import type { SnapshotNode, Step } from '../domain/preflight';
export { operationSchema, type OperationRecord, type OperationRecordV2 };
export interface OperationJournal {
  readonly importCheckpoints?: ImportCheckpointStore;
  handoffImport?(checkpoint: ImportCheckpoint, initial: OperationRecord, expectedRevision: number): Promise<void>;
  all(): Promise<OperationRecord[]>;
  get?(requestId: string): Promise<OperationRecord | undefined>;
  put(record: OperationRecord): Promise<void>;
  cleanup?(requestId: string): Promise<void>;
}
export function operationRecord(
  request: OperationRecord['request'],
  steps: Step[],
  affected: SnapshotNode[],
): OperationRecordV2 {
  return {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    backup: { installationId: request.installationId, nodes: structuredClone(request.before) },
    requestId: request.requestId,
    request: durableMutationRequestSchema.parse(request),
    affected,
    steps: steps.map(step => ({ step, state: 'planned' })),
    mapping: {},
  };
}
export function operationResult(
  record: OperationRecord,
  status: MutationResult['status'],
  reason?: string,
): MutationResult {
  const completedSteps = record.steps.filter(s => s.state === 'receipt').length;
  return {
    requestId: record.requestId,
    status,
    needsReconcile: status === 'unknown',
    completedSteps,
    remainingSteps: record.steps.length - completedSteps,
    reason,
  };
}
export class OperationsStore implements OperationJournal {
  constructor(
    private factory: IDBFactory = indexedDB,
    private name = 'zhilan-operations',
  ) {}
  private open(): Promise<IDBDatabase> {
    return openOperationsDatabase(this.factory, this.name);
  }
  async all(): Promise<OperationRecord[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('operations', 'readonly');
      const request = tx.objectStore('operations').getAll();
      tx.oncomplete = () => {
        db.close();
        try {
          resolve(z.array(operationSchema).parse(request.result));
        } catch {
          reject(Error('unsupported-journal'));
        }
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(Error('journal-unavailable'));
      };
    });
  }
  /** Primary-key read; the coordinator indexes the journal once per worker and then resolves each request here. */
  async get(requestId: string): Promise<OperationRecord | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('operations', 'readonly');
      const request = tx.objectStore('operations').get(requestId);
      tx.oncomplete = () => {
        db.close();
        try {
          resolve(request.result === undefined ? undefined : operationSchema.parse(request.result));
        } catch {
          reject(Error('unsupported-journal'));
        }
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(Error('journal-unavailable'));
      };
    });
  }
  async cleanup(requestId: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('operations', 'readwrite', { durability: 'strict' });
      const store = tx.objectStore('operations');
      const read = store.getAll();
      read.onsuccess = () => {
        try {
          const records = z.array(operationSchema).parse(read.result);
          const target = records.find(r => r.requestId === requestId);
          if (
            !target?.result ||
            target.result.needsReconcile ||
            target.quarantine ||
            target.request.recovery ||
            records.some(r => r.request.recovery?.sourceRequestId === requestId)
          )
            throw Error('protected-recovery-record');
          // Keep a dedupe tombstone; cleanup must never make an old request executable again. v1 drops its per-step trees, v2 its touched deltas and final snapshot; digests stay.
          const evidence =
            target.schemaVersion === 1
              ? {
                  steps: target.steps.map(s => ({
                    ...s,
                    before: undefined,
                    expectedAfter: undefined,
                    after: undefined,
                  })),
                }
              : { final: undefined, steps: target.steps.map(s => ({ ...s, touched: undefined })) };
          store.put({
            ...target,
            ...evidence,
            affected: [],
            backup: undefined,
            request: { ...target.request, before: [] },
          });
        } catch {
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(Error('cleanup-refused'));
      };
    });
  }
  async put(record: OperationRecord): Promise<void> {
    const value = operationSchema.parse(record);
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('operations', 'readwrite', { durability: 'strict' });
      tx.objectStore('operations').put(value);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(Error('journal-unavailable'));
      };
    });
  }
}
