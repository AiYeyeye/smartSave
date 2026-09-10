import type { ImportCheckpointStore, ImportCheckpoint } from './import-checkpoints';
import { openOperationsDatabase } from './operations-database';
import { z } from 'zod';
import { durableMutationRequestSchema, type MutationResult } from '../schemas/messages';
import { nodeSchema } from '../domain/node-reference';
import type { SnapshotNode, Step } from '../domain/preflight';
const stepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update'), id: z.string(), changes: z.object({ title: z.string().optional(), url: z.string().optional() }).strict() }).strict(),
  z.object({ type: z.literal('move'), id: z.string(), parentId: z.string(), index: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('remove'), id: z.string() }).strict(),
  z.object({ type: z.literal('create'), parentId: z.string(), title: z.string(), url: z.string().optional(), temporaryId: z.string() }).strict(),
]);
const resultSchema = z.object({ requestId: z.string(), status: z.enum(['rejected', 'failed', 'partial', 'unknown', 'completed']), needsReconcile: z.boolean(), completedSteps: z.number().int().nonnegative(), remainingSteps: z.number().int().nonnegative(), reason: z.string().optional(), evidence: z.array(z.object({ stepIndex: z.number().int().nonnegative(), state: z.enum(['checkpointed', 'not-issued', 'unknown']), nativeId: z.string().optional(), currentMatchesReceipt: z.boolean() }).strict()).optional() }).strict();
export const operationSchema = z.object({ schemaVersion: z.literal(1), requestId: z.string(), request: durableMutationRequestSchema, affected: z.array(nodeSchema), steps: z.array(z.object({ step: stepSchema, state: z.enum(['planned', 'intent', 'receipt']), before: z.array(nodeSchema).optional(), expectedAfter: z.array(nodeSchema).optional(), after: z.array(nodeSchema).optional(), returnedNativeId: z.string().optional() }).strict()), createdAt: z.string().optional(), backup: z.object({ installationId: z.string(), nodes: z.array(nodeSchema) }).strict().optional(), quarantine: z.object({ acknowledgedAt: z.string(), epoch: z.string(), observedRevision: z.number() }).strict().optional(), mapping: z.record(z.string(), z.string()), result: resultSchema.optional() }).strict();
export type OperationRecord = z.infer<typeof operationSchema>;
export interface OperationJournal { readonly importCheckpoints?: ImportCheckpointStore; handoffImport?(checkpoint: ImportCheckpoint, initial: OperationRecord, expectedRevision: number): Promise<void>; all(): Promise<OperationRecord[]>; put(record: OperationRecord): Promise<void>; cleanup?(requestId: string): Promise<void> }
export function operationRecord(request: OperationRecord['request'], steps: Step[], affected: SnapshotNode[]): OperationRecord {
  return { schemaVersion: 1, createdAt: new Date().toISOString(), backup: { installationId: request.installationId, nodes: structuredClone(request.before) }, requestId: request.requestId, request: durableMutationRequestSchema.parse(request), affected, steps: steps.map(step => ({ step, state: 'planned' })), mapping: {} };
}
export function operationResult(record: OperationRecord, status: MutationResult['status'], reason?: string): MutationResult {
  const completedSteps = record.steps.filter(s => s.state === 'receipt').length;
  return { requestId: record.requestId, status, needsReconcile: status === 'unknown', completedSteps, remainingSteps: record.steps.length - completedSteps, reason };
}
export class OperationsStore implements OperationJournal {
  constructor(private factory: IDBFactory = indexedDB, private name = 'zhilan-operations') {}
  private open(): Promise<IDBDatabase> { return openOperationsDatabase(this.factory, this.name); }
  async all(): Promise<OperationRecord[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('operations', 'readonly');
      const request = tx.objectStore('operations').getAll();
      tx.oncomplete = () => { db.close(); try { resolve(z.array(operationSchema).parse(request.result)); } catch { reject(Error('unsupported-journal')); } };
      tx.onabort = tx.onerror = () => { db.close(); reject(Error('journal-unavailable')); };
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
          if (!target?.result || target.result.needsReconcile || target.quarantine || target.request.recovery || records.some(r => r.request.recovery?.sourceRequestId === requestId)) throw Error('protected-recovery-record');
          // Keep a dedupe tombstone; cleanup must never make an old request executable again.
          store.put({ ...target, affected: [], backup: undefined, request: { ...target.request, before: [] }, steps: target.steps.map(s => ({ ...s, before: undefined, expectedAfter: undefined, after: undefined })) });
        } catch { tx.abort(); }
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = tx.onerror = () => { db.close(); reject(Error('cleanup-refused')); };
    });
  }
  async put(record: OperationRecord): Promise<void> {
    const value = operationSchema.parse(record);
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('operations', 'readwrite', { durability: 'strict' });
      tx.objectStore('operations').put(value);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = tx.onerror = () => { db.close(); reject(Error('journal-unavailable')); };
    });
  }
}
