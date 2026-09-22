import { z } from 'zod';
import { nodeRefSchema } from '../domain/node-reference';
import { openOperationsDatabase } from './operations-database';
import { batchCommandSchema, importBindingSchema } from '../schemas/messages';
import { operationSchema } from './operation-schema';
import { candidateStructure } from '../import/source-candidates';

const spanSchema = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .strict()
  .refine(s => s.end >= s.start);
const itemSchema = z
  .object({
    sourceOrdinal: z.number().int().nonnegative(),
    sourceSpan: spanSchema,
    rawURL: z.string(),
    title: z.string(),
    oldPath: z.array(z.string()),
    provenance: z
      .object({
        format: z.enum(['html', 'json', 'csv', 'txt', 'markdown']),
        sourcePath: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional(),
        urlSpan: spanSchema,
      })
      .strict(),
    diagnostic: z.enum(['invalid-url', 'unsupported-protocol']).optional(),
  })
  .strict();
const diagnosticSchema = z.discriminatedUnion('reason', [
  z
    .object({
      sourceOrdinal: z.number().int().nonnegative(),
      reason: z.enum(['invalid-url', 'unsupported-protocol', 'existing-url']),
    })
    .strict(),
  z
    .object({
      sourceOrdinal: z.number().int().nonnegative(),
      reason: z.literal('file-duplicate'),
      retainedSourceOrdinal: z.number().int().nonnegative(),
    })
    .strict(),
  // Count-only summaries: candidate fields ignored because rows were recognized, or structure elements lacking the mapped URL field.
  z
    .object({ reason: z.enum(['unmapped-candidates', 'unmapped-elements']), count: z.number().int().positive() })
    .strict(),
]);
const candidateSchema = z
  .object({
    sourcePath: z.array(z.union([z.string(), z.number().int().nonnegative()])),
    value: z.string(),
    sourceSpan: spanSchema,
  })
  .strict();
const runtimeSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    semanticDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
    stage: z.enum(['mapping', 'classification']),
    format: z.enum(['html', 'json', 'csv', 'txt', 'markdown']),
    candidates: z.array(candidateSchema),
    sourceItems: z.array(itemSchema),
    mappedGroups: z.array(z.string()),
    mappedItems: z.array(itemSchema),
  })
  .strict();
/** Durable data only: no model settings, credentials, bodies, leases or executable envelopes. */
export const importCheckpointSchema = z
  .object({
    runtime: runtimeSchema.optional(),
    sourceCheckpoint: z
      .object({ id: z.string().min(1), revision: z.number().int().nonnegative() })
      .strict()
      .optional(),
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    installationId: z.string().min(1),
    root: nodeRefSchema.strict(),
    items: z.array(z.object({ item: itemSchema, titleLocked: z.boolean() }).strict()),
    diagnostics: z.array(diagnosticSchema),
    classified: z.array(
      z
        .object({ sourceOrdinal: z.number().int().nonnegative(), folderId: z.string().min(1), title: z.string() })
        .strict(),
    ),
    newFolders: z.array(
      z.object({ id: z.string().min(1), parentId: z.string().min(1), title: z.string().min(1) }).strict(),
    ),
    phase: z.enum(['paused', 'classified', 'applying', 'finished']),
    requestId: z.string().min(1).optional(),
    writePlan: z.object({ command: batchCommandSchema, binding: importBindingSchema }).strict().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const error = () => context.addIssue({ code: 'custom', message: 'invalid-import-checkpoint' });
    if (
      value.writePlan &&
      (!value.requestId ||
        value.writePlan.binding.checkpointId !== value.id ||
        value.writePlan.binding.checkpointRevision >= value.revision)
    )
      error();
    if (value.runtime?.version === 2 && !value.runtime.semanticDigest) error();
    if (
      value.runtime?.stage === 'mapping' &&
      (value.phase !== 'paused' || value.classified.length || value.newFolders.length || value.items.length)
    )
      error();
    if (value.runtime) {
      // A structure may map many rows or none (explicit refusal); every mapped row must still belong to a completed structure or legacy concrete-parent group.
      const groups = new Set(value.runtime.mappedGroups);
      if (
        groups.size !== value.runtime.mappedGroups.length ||
        new Set(value.runtime.mappedItems.map(i => i.sourceOrdinal)).size !== value.runtime.mappedItems.length
      )
        error();
      if (
        value.runtime.mappedItems.some(
          i =>
            !i.provenance.sourcePath ||
            (!groups.has(JSON.stringify(candidateStructure(i.provenance.sourcePath).structure)) &&
              !groups.has(JSON.stringify(i.provenance.sourcePath.slice(0, -1)))),
        )
      )
        error();
    }
    if (value.root.kind !== 'folder' || value.root.installationId !== value.installationId) error();
    const items = new Map(value.items.map(i => [i.item.sourceOrdinal, i]));
    if (
      items.size !== value.items.length ||
      new Set(value.classified.map(i => i.sourceOrdinal)).size !== value.classified.length
    )
      error();
    for (const row of value.classified) {
      const source = items.get(row.sourceOrdinal);
      if (!source || (source.titleLocked && source.item.title !== row.title)) error();
    }
    if (value.phase !== 'paused' && value.classified.length !== value.items.length) error();
    if ((value.phase === 'applying' || value.phase === 'finished') && !value.requestId) error();
    if ((value.phase === 'paused' || value.phase === 'classified') && value.requestId) error();
    if (new Set(value.newFolders.map(f => f.id)).size !== value.newFolders.length) error();
  });
export type ImportCheckpoint = z.infer<typeof importCheckpointSchema>;

export class ImportCheckpointStore {
  constructor(
    private factory: IDBFactory = globalThis.indexedDB,
    private name = 'zhilan-operations',
  ) {}
  async get(id: string): Promise<ImportCheckpoint | undefined> {
    const db = await openOperationsDatabase(this.factory, this.name);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('importCheckpoints', 'readonly');
      const request = tx.objectStore('importCheckpoints').get(id);
      tx.oncomplete = () => {
        db.close();
        try {
          resolve(request.result === undefined ? undefined : importCheckpointSchema.parse(request.result));
        } catch {
          reject(Error('unsupported-import-checkpoint'));
        }
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(Error('import-checkpoint-unavailable'));
      };
    });
  }
  /** Cursor projection only: never retain or parse historical source arrays for the picker. */
  async list(): Promise<{ id: string; phase: string; status: 'readable' | 'unknown' }[]> {
    const db = await openOperationsDatabase(this.factory, this.name);
    return new Promise((resolve, reject) => {
      const rows: { id: string; phase: string; status: 'readable' | 'unknown' }[] = [];
      const tx = db.transaction('importCheckpoints', 'readonly');
      const request = tx.objectStore('importCheckpoints').openCursor();
      const metadata = z.object({
        schemaVersion: z.literal(1),
        id: z.string(),
        phase: z.enum(['paused', 'classified', 'applying', 'finished']),
      });
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const parsed = metadata.safeParse(cursor.value);
        rows.push(
          parsed.success && parsed.data.id === cursor.key
            ? { id: parsed.data.id, phase: parsed.data.phase, status: 'readable' }
            : { id: String(cursor.key), phase: 'unknown', status: 'unknown' },
        );
        cursor.continue();
      };
      tx.oncomplete = () => {
        db.close();
        resolve(rows);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(Error('import-checkpoint-unavailable'));
      };
    });
  }
  async all(): Promise<ImportCheckpoint[]> {
    const db = await openOperationsDatabase(this.factory, this.name);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('importCheckpoints', 'readonly');
      const request = tx.objectStore('importCheckpoints').getAll();
      tx.oncomplete = () => {
        db.close();
        try {
          resolve(z.array(importCheckpointSchema).parse(request.result));
        } catch {
          reject(Error('unsupported-import-checkpoint'));
        }
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(Error('import-checkpoint-unavailable'));
      };
    });
  }
  /** Compare-and-swap prevents another visible page from overwriting completed progress. */
  async put(checkpoint: ImportCheckpoint, expectedRevision: number | null): Promise<void> {
    const value = importCheckpointSchema.parse(checkpoint);
    if (value.revision !== (expectedRevision === null ? 0 : expectedRevision + 1))
      throw Error('import-checkpoint-conflict');
    const db = await openOperationsDatabase(this.factory, this.name);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['importCheckpoints', 'operations'], 'readwrite', { durability: 'strict' });
      const store = tx.objectStore('importCheckpoints');
      const request = store.get(value.id);
      let reason = 'import-checkpoint-unavailable';
      request.onsuccess = () => {
        try {
          const previous = request.result === undefined ? undefined : importCheckpointSchema.parse(request.result);
          if (expectedRevision === null ? previous !== undefined : previous?.revision !== expectedRevision) {
            reason = 'import-checkpoint-conflict';
            tx.abort();
            return;
          }
          // Once handed off, only the journal can establish completion; the proposal is immutable.
          if (previous?.requestId) {
            const frozen = (record: ImportCheckpoint) => ({ ...record, revision: 0, phase: 'applying' });
            if (value.phase !== 'finished' || JSON.stringify(frozen(previous)) !== JSON.stringify(frozen(value))) {
              reason = 'import-checkpoint-recovery-required';
              tx.abort();
              return;
            }
            const operation = tx.objectStore('operations').get(previous.requestId);
            operation.onsuccess = () => {
              const parsed = operationSchema.safeParse(operation.result);
              if (
                !parsed.success ||
                parsed.data.request.installationId !== value.installationId ||
                JSON.stringify(parsed.data.request.scope) !== JSON.stringify(value.root) ||
                (previous.writePlan &&
                  (JSON.stringify(parsed.data.request.command) !== JSON.stringify(previous.writePlan.command) ||
                    JSON.stringify(parsed.data.request.importBinding) !==
                      JSON.stringify(previous.writePlan.binding))) ||
                parsed.data.result?.status !== 'completed' ||
                parsed.data.result.needsReconcile
              ) {
                reason = 'import-checkpoint-recovery-required';
                tx.abort();
                return;
              }
              store.put(value);
            };
            return;
          }
          if (value.phase === 'applying') {
            reason = 'import-checkpoint-recovery-required';
            tx.abort();
            return;
          }
          if (value.phase === 'finished') {
            reason = 'import-checkpoint-recovery-required';
            tx.abort();
            return;
          }
          // Revision CAS already proves lineage; invariants stay O(N) set/length checks, never whole-array serialization per save.
          const prior = previous?.runtime;
          const next = value.runtime;
          const transition = prior?.stage === 'mapping' && next?.stage === 'classification';
          if (prior) {
            const groups = new Set(next?.mappedGroups);
            const mapped = new Set(next?.mappedItems.map(i => i.sourceOrdinal));
            if (
              !next ||
              next.version !== prior.version ||
              next.semanticDigest !== prior.semanticDigest ||
              next.contextDigest !== prior.contextDigest ||
              next.format !== prior.format ||
              next.sourceItems.length !== prior.sourceItems.length ||
              next.candidates.length !== prior.candidates.length ||
              prior.mappedGroups.some(g => !groups.has(g)) ||
              prior.mappedItems.some(i => !mapped.has(i.sourceOrdinal)) ||
              (prior.stage === 'classification' &&
                (next.stage !== 'classification' ||
                  next.mappedGroups.length !== prior.mappedGroups.length ||
                  next.mappedItems.length !== prior.mappedItems.length))
            ) {
              reason = 'import-checkpoint-conflict';
              tx.abort();
              return;
            }
          } else if (previous && next) {
            reason = 'import-checkpoint-conflict';
            tx.abort();
            return;
          }
          // Context changes create a new task; source rows appear once (creation or mapping transition), diagnostics only grow while mapping, progress only grows.
          if (previous) {
            const classified = new Set(value.classified.map(r => r.sourceOrdinal));
            const folders = new Set(value.newFolders.map(f => f.id));
            if (
              value.installationId !== previous.installationId ||
              JSON.stringify(value.root) !== JSON.stringify(previous.root) ||
              (transition ? value.classified.length > 0 : value.items.length !== previous.items.length) ||
              (prior?.stage === 'mapping'
                ? value.diagnostics.length < previous.diagnostics.length
                : value.diagnostics.length !== previous.diagnostics.length) ||
              previous.classified.some(row => !classified.has(row.sourceOrdinal)) ||
              previous.newFolders.some(folder => !folders.has(folder.id))
            ) {
              reason = 'import-checkpoint-conflict';
              tx.abort();
              return;
            }
          }
          if (previous && JSON.stringify(previous.sourceCheckpoint) !== JSON.stringify(value.sourceCheckpoint)) {
            reason = 'import-checkpoint-conflict';
            tx.abort();
            return;
          }
          if (!previous && value.sourceCheckpoint) {
            const source = store.get(value.sourceCheckpoint.id);
            source.onsuccess = () => {
              const parsed = importCheckpointSchema.safeParse(source.result);
              if (!parsed.success) {
                reason = source.result === undefined ? 'import-checkpoint-not-found' : 'unsupported-import-checkpoint';
                tx.abort();
                return;
              }
              if (parsed.data.requestId || parsed.data.phase === 'applying' || parsed.data.phase === 'finished') {
                reason = 'import-checkpoint-recovery-required';
                tx.abort();
                return;
              }
              if (parsed.data.revision !== value.sourceCheckpoint!.revision) {
                reason = 'import-checkpoint-conflict';
                tx.abort();
                return;
              }
              store.put(value);
            };
          } else store.put(value);
        } catch (error) {
          reason =
            error instanceof DOMException && error.name === 'QuotaExceededError'
              ? 'import-checkpoint-unavailable'
              : 'unsupported-import-checkpoint';
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
