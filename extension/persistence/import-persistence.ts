import { OperationsStore, operationSchema, type OperationRecord } from './operations';
import { ImportCheckpointStore, importCheckpointSchema, type ImportCheckpoint } from './import-checkpoints';
import { openOperationsDatabase } from './operations-database';
import { OrganizeCheckpointStore } from './organize-checkpoints';
import { organizeCheckpointSchema, type OrganizeCheckpoint } from '../domain/organize-checkpoint';

/** One journal owner for import CAS, initial intent, receipts and checkpoint completion. */
export class ImportPersistenceStore extends OperationsStore {
  readonly importCheckpoints: ImportCheckpointStore;
  readonly organizeCheckpoints: OrganizeCheckpointStore;
  constructor(
    private importFactory: IDBFactory = globalThis.indexedDB,
    private importName = 'zhilan-operations',
  ) {
    super(importFactory, importName);
    this.importCheckpoints = new ImportCheckpointStore(importFactory, importName);
    this.organizeCheckpoints = new OrganizeCheckpointStore(importFactory, importName);
  }
  /** Task CAS and initial backup commit together, before the coordinator may issue any native call. */
  async handoffOrganize(
    checkpoint: OrganizeCheckpoint,
    initial: OperationRecord,
    expectedRevision: number,
  ): Promise<void> {
    const value = organizeCheckpointSchema.parse(checkpoint);
    const record = operationSchema.parse(initial);
    const submission = value.submission;
    if (
      !submission ||
      value.revision !== expectedRevision + 1 ||
      submission.binding.checkpointRevision !== expectedRevision ||
      record.requestId !== submission.requestId ||
      !record.backup ||
      !record.steps.length ||
      record.steps.some(step => step.state !== 'planned') ||
      record.result ||
      record.request.installationId !== value.installationId ||
      record.request.importBinding ||
      record.request.recovery ||
      JSON.stringify(record.request.command) !== JSON.stringify(submission.command) ||
      JSON.stringify(record.request.organizerBinding) !== JSON.stringify(submission.binding) ||
      JSON.stringify(record.request.scope) !== JSON.stringify(value.root)
    )
      throw Error('invalid-organize-handoff');
    const db = await openOperationsDatabase(this.importFactory, this.importName);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['organizeCheckpoints', 'operations'], 'readwrite', { durability: 'strict' });
      const checkpoints = tx.objectStore('organizeCheckpoints');
      const operations = tx.objectStore('operations');
      const previous = checkpoints.get(value.id);
      const existing = operations.get(record.requestId);
      let reason = 'organize-checkpoint-unavailable';
      existing.onsuccess = () => {
        try {
          const original = organizeCheckpointSchema.parse(previous.result);
          if (
            existing.result !== undefined ||
            original.submission ||
            original.stage !== 'complete' ||
            original.status !== 'review' ||
            original.revision !== expectedRevision ||
            JSON.stringify({ ...original, revision: original.revision + 1, submission }) !== JSON.stringify(value)
          ) {
            reason = 'organize-checkpoint-conflict';
            tx.abort();
            return;
          }
          operations.put(record);
          checkpoints.put(value);
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
        reject(Error(reason));
      };
    });
  }
  /** Atomic import CAS + initial journal backup. No applying checkpoint without its 05 owner row. */
  async handoffImport(checkpoint: ImportCheckpoint, initial: OperationRecord, expectedRevision: number): Promise<void> {
    const value = importCheckpointSchema.parse(checkpoint);
    const record = operationSchema.parse(initial);
    if (
      value.phase !== 'applying' ||
      value.revision !== expectedRevision + 1 ||
      !value.writePlan ||
      record.requestId !== value.requestId ||
      !record.backup ||
      record.steps.some(step => step.state !== 'planned') ||
      record.result ||
      JSON.stringify(record.request.command) !== JSON.stringify(value.writePlan.command) ||
      JSON.stringify(record.request.importBinding) !== JSON.stringify(value.writePlan.binding) ||
      JSON.stringify(record.request.scope) !== JSON.stringify(value.root)
    )
      throw Error('invalid-import-handoff');
    const db = await openOperationsDatabase(this.importFactory, this.importName);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['importCheckpoints', 'operations'], 'readwrite', { durability: 'strict' });
      const checkpoints = tx.objectStore('importCheckpoints');
      const operations = tx.objectStore('operations');
      const previous = checkpoints.get(value.id);
      const existing = operations.get(record.requestId);
      let reason = 'import-checkpoint-unavailable';
      existing.onsuccess = () => {
        try {
          const original = importCheckpointSchema.parse(previous.result);
          const expected = {
            ...original,
            phase: 'applying',
            revision: original.revision + 1,
            requestId: value.requestId,
            writePlan: value.writePlan,
          };
          if (
            existing.result !== undefined ||
            original.requestId ||
            original.phase !== 'classified' ||
            original.revision !== expectedRevision ||
            value.writePlan!.binding.checkpointRevision !== original.revision ||
            JSON.stringify(expected) !== JSON.stringify(value)
          ) {
            reason = 'import-checkpoint-conflict';
            tx.abort();
            return;
          }
          operations.put(record);
          checkpoints.put(value);
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
        reject(Error(reason));
      };
    });
  }
}
