import { importSourceItems } from './import-sources';
import { importContextDigest as contextDigest } from './import-evidence';
import type { ModelAuthority } from '../adapters/model-authority';
import type { ModelTransport } from '../adapters/model-transport';
import { ImportCheckpointStore, type ImportCheckpoint } from '../persistence/import-checkpoints';
import type { ImportFormat, ImportResult, SourceCandidate } from '../import/contracts';
import { candidateStructure, resolveSourceCandidates } from '../import/source-candidates';
import { deduplicateImport } from './import-deduplication';
import { importURLDiagnostic } from './import-url';
import { serializeAiPayload, type AiRequest, type AiSample } from './ai-payload';
import type { NodeRef, TreeSnapshot } from './node-reference';

type Context = Awaited<ReturnType<ModelAuthority['read']>>;
type Runtime = NonNullable<ImportCheckpoint['runtime']>;
type MappingGroup = {
  key: string;
  structure: string[];
  fields: Map<string, AiSample[]>;
  elements: Map<string, Map<string, SourceCandidate>>;
  url: boolean;
};
export interface ImportSelection {
  root: NodeRef;
  tree: TreeSnapshot;
}
export type ImportPipelineResult =
  | { status: 'classified'; checkpoint: ImportCheckpoint }
  | { status: 'paused'; reason: string; checkpoint?: ImportCheckpoint };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const parentPath = (candidate: SourceCandidate) => JSON.stringify(candidate.sourcePath.slice(0, -1));
const itemId = (id: string, ordinal: number) => `import-item:${id}:${ordinal}`;
/** One model decision per isomorphic structure, at most five samples per relative field; structures without any URL-shaped string need no decision. Legacy concrete-parent keys stay honored. */
function mappingGroups(runtime: Runtime): MappingGroup[] {
  const mapped = new Set(runtime.mappedGroups);
  const groups = new Map<string, MappingGroup>();
  for (const candidate of runtime.candidates) {
    if (mapped.has(parentPath(candidate))) continue;
    const { structure, field, element } = candidateStructure(candidate.sourcePath);
    const key = JSON.stringify(structure);
    if (mapped.has(key)) continue;
    let group = groups.get(key);
    if (!group) {
      group = { key, structure, fields: new Map(), elements: new Map(), url: false };
      groups.set(key, group);
    }
    const kind = importURLDiagnostic(candidate.value) ? 'text' : 'url';
    group.url ||= kind === 'url';
    const samples = group.fields.get(field) ?? [];
    if (!samples.length) group.fields.set(field, samples);
    if (samples.length < 5) samples.push({ source: 'new-import', kind, value: candidate.value });
    const fields = group.elements.get(element) ?? new Map<string, SourceCandidate>();
    if (!fields.size) group.elements.set(element, fields);
    fields.set(field, candidate);
  }
  return [...groups.values()].filter(group => group.url);
}
function scopedFolders(context: Context, root: NodeRef): string[] {
  const tree = context.tree;
  const nodes = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
  const selected = nodes.get(root.nativeId);
  if (
    root.installationId !== tree.installationId ||
    root.kind !== 'folder' ||
    !selected ||
    !equal(selected.ref, root) ||
    selected.childrenWritable === false
  )
    throw Error('invalid-root');
  const descendants = tree.nodes
    .filter(n => {
      if (n.ref.kind !== 'folder' || n.childrenWritable === false) return false;
      let cursor: typeof n | undefined = n;
      const seen = new Set<string>();
      while (cursor) {
        if (seen.has(cursor.ref.nativeId)) throw Error('invalid-tree');
        seen.add(cursor.ref.nativeId);
        if (cursor.ref.nativeId === root.nativeId) return true;
        cursor = cursor.parentId === undefined ? undefined : nodes.get(cursor.parentId);
      }
      return false;
    })
    .map(n => n.ref.nativeId);
  // Reuse the final privacy/scope owner, including excluded ancestors of the selected root.
  const projected: { folders: { id: string }[] } = JSON.parse(
    serializeAiPayload(tree, context.privacy, {
      task: 'import-classify',
      targetId: root.nativeId,
      items: [],
      folderIds: descendants,
    }),
  );
  return projected.folders.map(f => f.id);
}

/** Classification only. This owner has no bookmark writer, lease, UI or automatic resume path. */
export class ImportPipeline {
  private busy = false;
  private cancelled = false;
  constructor(
    private readonly transport: ModelTransport,
    private readonly authority: ModelAuthority,
    private readonly store = new ImportCheckpointStore(),
    private readonly progress?: (checkpoint: ImportCheckpoint) => void,
  ) {}
  cancel() {
    this.cancelled = true;
    this.transport.cancel();
  }
  dispose() {
    this.cancel();
    this.transport.dispose();
  }
  async start(
    input: ImportSelection & { id: string; source: ImportResult; format: ImportFormat },
  ): Promise<ImportPipelineResult> {
    return this.exclusive(() => this.create(input));
  }
  private async create(
    input: ImportSelection & { id: string; source: ImportResult; format: ImportFormat },
    sourceCheckpoint?: ImportCheckpoint['sourceCheckpoint'],
  ): Promise<ImportPipelineResult> {
    const frozen = structuredClone(input);
    const context = await this.authority.read();
    this.validateSelection(context, frozen);
    const knownParents = new Set(
      frozen.source.items.flatMap(i =>
        i.provenance.sourcePath ? [JSON.stringify(i.provenance.sourcePath.slice(0, -1))] : [],
      ),
    );
    const candidates = frozen.source.candidates.filter(c => !knownParents.has(parentPath(c)));
    // Recognized rows win: mapping runs only when no parser row exists, so unfamiliar strings never displace evidence or drive model calls.
    const mapping = !frozen.source.items.length && candidates.length > 0;
    const runtime: Runtime = {
      version: 2,
      semanticDigest: await contextDigest(context, frozen.root, true),
      contextDigest: await contextDigest(context, frozen.root),
      stage: mapping ? 'mapping' : 'classification',
      format: frozen.format,
      candidates,
      sourceItems: frozen.source.items,
      mappedGroups: [],
      mappedItems: [],
    };
    const dedup = deduplicateImport(mapping ? [] : importSourceItems(runtime), context.tree);
    const checkpoint: ImportCheckpoint = {
      schemaVersion: 1,
      ...(sourceCheckpoint ? { sourceCheckpoint } : {}),
      id: frozen.id,
      revision: 0,
      installationId: context.tree.installationId,
      root: frozen.root,
      items: dedup.pending,
      diagnostics: [
        ...dedup.diagnostics,
        ...(!mapping && candidates.length
          ? [{ reason: 'unmapped-candidates' as const, count: candidates.length }]
          : []),
      ],
      classified: [],
      newFolders: [],
      phase: 'paused',
      runtime,
    };
    await this.store.put(checkpoint, null);
    return this.execute(checkpoint);
  }
  /** Explicit caller action after reload. Legacy checkpoints remain readable but cannot resume without provenance. */
  async resume(id: string, selection: ImportSelection): Promise<ImportPipelineResult> {
    return this.exclusive(async () => {
      const frozen = structuredClone(selection);
      const checkpoint = await this.store.get(id);
      if (!checkpoint) throw Error('import-checkpoint-not-found');
      try {
        const context = await this.authority.read();
        this.validateSelection(context, frozen);
        if (!equal(checkpoint.root, frozen.root)) throw Error('stale-context');
        await this.validateCheckpoint(checkpoint, context);
      } catch (error) {
        return { status: 'paused', reason: this.reason(error), checkpoint };
      }
      return this.execute(checkpoint);
    });
  }
  /** Explicit rescan; semantic evidence never replaces the active epoch-bound stamp. */
  async recover(id: string, selection: ImportSelection): Promise<ImportPipelineResult> {
    return this.exclusive(async () => {
      const frozen = structuredClone(selection);
      const checkpoint = await this.store.get(id);
      if (!checkpoint) throw Error('import-checkpoint-not-found');
      try {
        this.assertClassificationOwned(checkpoint);
        const context = await this.authority.read();
        this.validateSelection(context, frozen);
        if (checkpoint.runtime?.version !== 2) throw Error('import-reclassification-required');
        if (
          !equal(checkpoint.root, frozen.root) ||
          checkpoint.runtime.semanticDigest !== (await contextDigest(context, frozen.root, true))
        )
          throw Error('stale-context');
        const binding = await contextDigest(context, frozen.root);
        return this.execute(checkpoint, binding);
      } catch (error) {
        return { status: 'paused', reason: this.reason(error), checkpoint };
      }
    });
  }
  /** New classification task; the old checkpoint and all journal evidence remain untouched. */
  async reclassify(
    id: string,
    input: ImportSelection & { id: string; source?: ImportResult; format?: ImportFormat },
  ): Promise<ImportPipelineResult> {
    return this.exclusive(async () => {
      const frozen = structuredClone(input);
      const checkpoint = await this.store.get(id);
      if (!checkpoint) throw Error('import-checkpoint-not-found');
      this.assertClassificationOwned(checkpoint);
      const runtime = checkpoint.runtime;
      const source =
        frozen.source ??
        (runtime?.version === 2
          ? { text: '', encoding: 'utf-8' as const, items: runtime.sourceItems, candidates: runtime.candidates }
          : undefined);
      const format = frozen.format ?? runtime?.format;
      if (!source || !format) throw Error('import-source-required');
      return this.create({ ...frozen, source, format }, { id: checkpoint.id, revision: checkpoint.revision });
    });
  }
  private assertClassificationOwned(checkpoint: ImportCheckpoint) {
    if (checkpoint.requestId || checkpoint.phase === 'applying' || checkpoint.phase === 'finished')
      throw Error('import-checkpoint-recovery-required');
  }
  private async exclusive(operation: () => Promise<ImportPipelineResult>): Promise<ImportPipelineResult> {
    if (this.busy) return { status: 'paused', reason: 'import-pipeline-busy' };
    this.busy = true;
    this.cancelled = false;
    try {
      return await operation();
    } catch (error) {
      return { status: 'paused', reason: this.reason(error) };
    } finally {
      this.busy = false;
    }
  }
  private reason(error: unknown) {
    const message = error instanceof Error ? error.message : '';
    const safe = [
      'import-reclassification-required',
      'import-source-required',
      'stale-context',
      'invalid-root',
      'invalid-tree',
      'privacy-excluded',
      'unsupported-import-checkpoint',
      'import-checkpoint-conflict',
      'import-checkpoint-unavailable',
      'import-checkpoint-not-found',
      'import-checkpoint-recovery-required',
      'single-item-payload-too-large',
      'mapping-payload-too-large',
      'invalid-mapping',
      'cancelled',
      'configuration-unavailable',
      'unsafe-text-sample',
    ];
    return safe.includes(message) ? message : 'import-classification-failed';
  }
  private validateSelection(context: Context, selection: ImportSelection) {
    if (!equal(context.tree, selection.tree)) throw Error('stale-context');
    scopedFolders(context, selection.root);
  }
  private async validateCheckpoint(checkpoint: ImportCheckpoint, context: Context, binding?: string) {
    if (!checkpoint.runtime) throw Error('unsupported-import-checkpoint');
    this.assertClassificationOwned(checkpoint);
    scopedFolders(context, checkpoint.root);
    if ((binding ?? checkpoint.runtime.contextDigest) !== (await contextDigest(context, checkpoint.root)))
      throw Error('stale-context');
  }
  private async execute(initial: ImportCheckpoint, binding?: string): Promise<ImportPipelineResult> {
    let checkpoint = initial;
    const save = async (next: ImportCheckpoint) => {
      next.revision = checkpoint.revision + 1;
      await this.store.put(next, checkpoint.revision);
      checkpoint = next;
      this.progress?.(structuredClone(checkpoint));
    };
    try {
      while (true) {
        if (this.cancelled) throw Error('cancelled');
        const context = await this.authority.read();
        await this.validateCheckpoint(checkpoint, context, binding);
        if (this.cancelled) throw Error('cancelled');
        const runtime = checkpoint.runtime!;
        const folderIds = scopedFolders(context, checkpoint.root);
        const group = runtime.stage === 'mapping' ? mappingGroups(runtime)[0] : undefined;
        let request: AiRequest;
        let batch = checkpoint.items.filter(
          i => !checkpoint.classified.some(c => c.sourceOrdinal === i.item.sourceOrdinal),
        );
        if (runtime.stage === 'mapping' && !group) {
          const sources = importSourceItems(runtime);
          const dedup = deduplicateImport(sources, context.tree);
          await save({
            ...checkpoint,
            items: dedup.pending,
            diagnostics: [...dedup.diagnostics, ...checkpoint.diagnostics],
            runtime: { ...runtime, stage: 'classification' },
          });
          continue;
        }
        if (runtime.stage === 'classification' && !batch.length) {
          if (checkpoint.phase !== 'classified') await save({ ...checkpoint, phase: 'classified' });
          return { status: 'classified', checkpoint };
        }
        if (!context.config) throw Error('configuration-unavailable');
        if (runtime.stage === 'mapping') {
          request = {
            task: 'import-map',
            targetId: checkpoint.root.nativeId,
            folderIds,
            fields: [...group!.fields].map(([field, samples]) => ({ path: [...group!.structure, field], samples })),
          };
          if (!this.transport.fits({ ...context, config: context.config, request }))
            throw Error('mapping-payload-too-large');
        } else {
          const makeRequest = (rows: typeof batch): AiRequest => ({
            task: 'import-classify',
            targetId: checkpoint.root.nativeId,
            folderIds,
            proposedFolders: checkpoint.newFolders,
            items: rows.map(({ item }) => ({
              source: 'new-import',
              id: itemId(checkpoint.id, item.sourceOrdinal),
              title: item.title,
              url: item.rawURL,
            })),
          });
          // Binary-search the largest complete prefix against the SAME final adapter body as fetch.
          let low = 0,
            high = batch.length;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (
              this.transport.fits({ ...context, config: context.config, request: makeRequest(batch.slice(0, middle)) })
            )
              low = middle;
            else high = middle - 1;
          }
          if (!low) throw Error('single-item-payload-too-large');
          batch = batch.slice(0, low);
          request = makeRequest(batch);
        }
        if (this.cancelled) throw Error('cancelled');
        const result = await this.transport.run({ ...context, config: context.config, request });
        if (result.status !== 'completed') return { status: 'paused', reason: result.reason, checkpoint };
        if (this.cancelled) throw Error('cancelled');
        await this.validateCheckpoint(checkpoint, await this.authority.read(), binding);
        const output = result.output;
        if (request.task === 'import-map' && 'urlPath' in output) {
          const { key, structure, fields, elements } = group!;
          // Model paths address the structure template; every URL/title value is recovered from the original parse at the concrete element path.
          const relative = (path: string[]) => {
            const name = path.at(-1);
            if (name === undefined || !fields.has(name) || !equal(path.slice(0, -1), structure))
              throw Error('invalid-mapping');
            return name;
          };
          const urlField = output.urlPath === null ? undefined : relative(output.urlPath);
          const titleField = output.titlePath === null ? undefined : relative(output.titlePath);
          const rows =
            urlField === undefined
              ? []
              : [...elements.values()].map(element => ({
                  url: element.get(urlField),
                  title: titleField === undefined ? undefined : element.get(titleField),
                }));
          const skipped = rows.filter(row => !row.url).length;
          const resolved = resolveSourceCandidates(
            { text: '', encoding: 'utf-8', items: [], candidates: runtime.candidates },
            rows.flatMap(row => (row.url ? [row.url.sourcePath, ...(row.title ? [row.title.sourcePath] : [])] : [])),
          );
          let sourceOrdinal =
            [...runtime.sourceItems, ...runtime.mappedItems].reduce(
              (max, item) => Math.max(max, item.sourceOrdinal),
              -1,
            ) + 1;
          let cursor = 0;
          const mapped = rows.flatMap(row => {
            if (!row.url) return [];
            const url = resolved[cursor++]!;
            const title = row.title ? resolved[cursor++]!.value : '';
            return [
              {
                sourceOrdinal: sourceOrdinal++,
                sourceSpan: url.sourceSpan,
                rawURL: url.value,
                title,
                oldPath: [],
                provenance: { format: runtime.format, sourcePath: url.sourcePath, urlSpan: url.sourceSpan },
              },
            ];
          });
          await save({
            ...checkpoint,
            diagnostics: skipped
              ? [...checkpoint.diagnostics, { reason: 'unmapped-elements', count: skipped }]
              : checkpoint.diagnostics,
            runtime: {
              ...runtime,
              mappedGroups: [...runtime.mappedGroups, key],
              mappedItems: [...runtime.mappedItems, ...mapped],
            },
          });
        } else if (request.task === 'import-classify' && 'assignments' in output) {
          const aliases = new Map(
            output.newFolders.map((folder, index) => [
              folder.id,
              `import-folder:${checkpoint.id}:${checkpoint.newFolders.length + index}`,
            ]),
          );
          const target = (id: string) => aliases.get(id) ?? id;
          const newFolders = output.newFolders.map(f => ({ ...f, id: target(f.id), parentId: target(f.parentId) }));
          if (
            newFolders.some(
              f =>
                context.tree.nodes.some(n => n.ref.nativeId === f.id) || checkpoint.newFolders.some(n => n.id === f.id),
            )
          )
            throw Error('invalid-mapping');
          const classified = batch.map(({ item, titleLocked }) => {
            const assignment = output.assignments.find(a => a.itemId === itemId(checkpoint.id, item.sourceOrdinal))!;
            return {
              sourceOrdinal: item.sourceOrdinal,
              title:
                !titleLocked && !item.title && 'title' in assignment && typeof assignment.title === 'string'
                  ? assignment.title
                  : item.title,
              folderId: target(assignment.folderId),
            };
          });
          await save({
            ...checkpoint,
            classified: [...checkpoint.classified, ...classified],
            newFolders: [...checkpoint.newFolders, ...newFolders],
          });
        } else throw Error('invalid-mapping');
      }
    } catch (error) {
      return { status: 'paused', reason: this.reason(error), checkpoint };
    }
  }
}
