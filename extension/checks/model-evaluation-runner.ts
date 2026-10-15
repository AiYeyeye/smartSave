import { z } from 'zod';
import { treeStateSchema, nodeRefSchema, type TreeSnapshot } from '../domain/node-reference';
import { EXPORT_RESOURCE_LIMITS, type ExportDocument, type ExportNode } from '../domain/export-projection';
import { modelConfigSchema, parseModelEndpoint, type ModelConfig } from '../domain/model-route';
import { localClassification } from '../domain/local-classification';
import { serializeAiPayload } from '../domain/ai-payload';
import { latencyDistribution, type ModelTiming } from '../domain/save-performance';
import { ModelTransport } from '../adapters/model-transport';

export const evaluationDatasetSchema = z
  .strictObject({
    version: z.literal(1),
    name: z.string().min(1),
    tree: z
      .preprocess(snapshot => ({ status: 'ready', snapshot }), treeStateSchema)
      .transform(state => {
        if (state.status !== 'ready') throw Error('invalid-evaluation-tree');
        return state.snapshot;
      }),
    privacy: z.strictObject({
      fullUrl: z.boolean(),
      bodyEnabled: z.literal(false),
      excludedFolders: z.array(nodeRefSchema),
    }),
    cases: z
      .array(z.strictObject({ bookmarkId: z.string(), expectedFolderId: z.string() }))
      .min(1)
      .max(200),
  })
  .superRefine((dataset, ctx) => {
    const nodes = new Map(dataset.tree.nodes.map(node => [node.ref.nativeId, node]));
    if (
      nodes.size !== dataset.tree.nodes.length ||
      dataset.tree.nodes.some(n => n.ref.installationId !== dataset.tree.installationId)
    )
      ctx.addIssue({ code: 'custom', message: 'duplicate-or-foreign-node' });
    const seen = new Set<string>();
    dataset.cases.forEach((sample, index) => {
      const node = nodes.get(sample.bookmarkId);
      const target = nodes.get(sample.expectedFolderId);
      if (
        seen.has(sample.bookmarkId) ||
        node?.ref.kind !== 'bookmark' ||
        !node.url ||
        target?.ref.kind !== 'folder' ||
        !target.childrenWritable
      )
        ctx.addIssue({ code: 'custom', path: ['cases', index], message: 'invalid-or-duplicate-labeled-case' });
      seen.add(sample.bookmarkId);
    });
  });
export type EvaluationDataset = z.infer<typeof evaluationDatasetSchema>;
export const evaluationRouteSchema = z
  .strictObject({
    config: modelConfigSchema,
    keyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
  })
  .superRefine((route, ctx) => {
    try {
      parseModelEndpoint(route.config);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid-evaluation-endpoint' });
    }
  });

/** Public export IDs are document-local. This offline copy never becomes native write authority. */
export function evaluationTemplate(document: ExportDocument) {
  const tree: TreeSnapshot = {
    installationId: 'offline-evaluation',
    epoch: 'offline',
    observedRevision: 1,
    roots: [],
    nodes: [],
  };
  const ids = new Set<string>();
  function visit(node: ExportNode, parentId: string | undefined, depth: number) {
    if (depth > EXPORT_RESOURCE_LIMITS.depth || tree.nodes.length >= EXPORT_RESOURCE_LIMITS.nodes || ids.has(node.id))
      throw Error('invalid-or-oversized-export');
    ids.add(node.id);
    const folder = node.type === 'folder';
    tree.nodes.push({
      ref: { installationId: tree.installationId, nativeId: node.id, kind: folder ? 'folder' : 'bookmark' },
      parentId,
      index: 0,
      title: node.title,
      ...(folder ? {} : { url: node.url }),
      childrenIds: folder ? node.children.map(child => child.id) : [],
      readOnly: false,
      childrenWritable: folder,
      observedRevision: 1,
    });
    if (folder) node.children.forEach(child => visit(child, node.id, depth + 1));
  }
  document.roots.forEach(node => visit(node, undefined, 1));
  let rootId = '__evaluation_root__';
  while (ids.has(rootId)) rootId += '_';
  for (const node of tree.nodes) if (node.parentId === undefined) node.parentId = rootId;
  tree.nodes.unshift({
    ref: { installationId: tree.installationId, nativeId: rootId, kind: 'folder' },
    title: 'Evaluation',
    index: 0,
    childrenIds: document.roots.map(node => node.id),
    readOnly: true,
    childrenWritable: false,
    observedRevision: 1,
  });
  tree.roots = [rootId];
  return {
    version: 1 as const,
    name: 'Manually labeled bookmark evaluation',
    tree,
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
    cases: tree.nodes
      .filter(node => node.url && /^https?:/i.test(node.url))
      .slice(0, 200)
      .map(node => ({ bookmarkId: node.ref.nativeId, expectedFolderId: '' })),
  };
}

/** Validate every projected case before allowing any request, including exclusions/ancestry. */
export function prepareEvaluation(dataset: EvaluationDataset) {
  const root = dataset.tree.nodes.find(n => n.parentId === undefined && n.ref.kind === 'folder');
  if (!root) throw Error('missing-evaluation-root');
  return dataset.cases.map(sample => {
    const local = localClassification(dataset.tree, sample.bookmarkId, dataset.privacy, []);
    if (!local.sourceAllowed) throw Error('excluded-evaluation-case');
    const request = {
      task: 'save' as const,
      targetId: root.ref.nativeId,
      item: { source: 'bookmark' as const, id: sample.bookmarkId },
      folderIds: local.folderIds,
    };
    const payload: { items: { id: string }[] } = JSON.parse(serializeAiPayload(dataset.tree, dataset.privacy, request));
    if (payload.items.length !== 1) throw Error('excluded-evaluation-case');
    return { ...sample, request, expectedInCandidates: local.folderIds.includes(sample.expectedFolderId) };
  });
}

/** Read-only model evaluation. No bookmark API, settings write or native apply exists in this runner. */
export async function evaluateModel(
  dataset: EvaluationDataset,
  config: ModelConfig,
  key: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
) {
  const cases = prepareEvaluation(dataset);
  const endpoint = parseModelEndpoint(config);
  const context = {
    version: 1 as const,
    revision: 'offline-evaluation',
    sessionRevision: 0,
    tree: dataset.tree,
    privacy: dataset.privacy,
    config,
    key,
  };
  const transport = new ModelTransport(
    { fetch: options.fetch ?? globalThis.fetch.bind(globalThis), contains: async () => true },
    { read: async () => structuredClone(context), subscribe: () => () => {} },
  );
  const rows: {
    bookmarkId: string;
    expectedFolderId: string;
    expectedInCandidates: boolean;
    predictedFolderId?: string;
    status: string;
    reason?: string;
    correct: boolean;
    ms: number;
    timing?: ModelTiming;
  }[] = [];
  try {
    for (const sample of cases) {
      if (options.signal?.aborted) break;
      let timing: ModelTiming | undefined;
      const started = performance.now();
      const result = await transport.run({
        ...context,
        request: sample.request,
        signal: options.signal,
        onTiming: value => {
          timing = value;
        },
      });
      const assignment =
        result.status === 'completed' && 'assignments' in result.output
          ? result.output.assignments.find(item => item.itemId === sample.bookmarkId)
          : undefined;
      rows.push({
        bookmarkId: sample.bookmarkId,
        expectedFolderId: sample.expectedFolderId,
        expectedInCandidates: sample.expectedInCandidates,
        predictedFolderId: assignment?.folderId,
        status: result.status,
        reason: result.status === 'completed' ? undefined : result.reason,
        correct: assignment?.folderId === sample.expectedFolderId,
        ms: performance.now() - started,
        timing,
      });
      if (result.status === 'cancelled') break;
    }
  } finally {
    transport.dispose();
  }
  const completed = rows.filter(row => row.status === 'completed');
  const correct = rows.filter(row => row.correct).length;
  return {
    dataset: dataset.name,
    model: config.model,
    adapter: config.adapter,
    host: endpoint.origin,
    requested: cases.length,
    processed: rows.length,
    cancelled: options.signal?.aborted ?? false,
    accuracy: rows.length ? correct / rows.length : undefined,
    completedAccuracy: completed.length ? correct / completed.length : undefined,
    failureRate: rows.length ? (rows.length - completed.length) / rows.length : undefined,
    latency: latencyDistribution(completed.map(row => row.ms)),
    firstToken: latencyDistribution(completed.map(row => row.timing?.firstTokenMs)),
    rows,
  };
}
