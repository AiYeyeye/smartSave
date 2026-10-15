import { serializeAiPayload, serializedItemRequestSize, type AiRequest } from '../domain/ai-payload';
import { modelRequestBody } from '../adapters/model-transport';
import { MODEL_BYTE_LIMITS } from '../adapters/model-byte-limits';
import { partitionOrganizeItems } from '../domain/organize-batches';
import { SearchIndex } from '../domain/search-index';
import type { TreeSnapshot } from '../domain/node-reference';
import { localClassification } from '../domain/local-classification';
import { fastSearchCandidates } from '../domain/search-retrieval';

// Deterministic synthetic data only. This is not the author's missing fixture or a model-quality benchmark.
const tree: TreeSnapshot = {
  installationId: 'synthetic',
  epoch: 'benchmark',
  observedRevision: 1,
  roots: ['0'],
  nodes: [],
};
function folder(id: string, parentId: string | undefined, title: string) {
  tree.nodes.push({
    ref: { installationId: tree.installationId, nativeId: id, kind: 'folder' },
    parentId,
    title,
    index: 0,
    childrenIds: [],
    childrenWritable: true,
    readOnly: false,
    observedRevision: 1,
  });
}
folder('0', undefined, '书签');
const bookmarkIds: string[] = [];
for (let top = 0; top < 12; top++) {
  folder(`t${top}`, '0', `知识分类 ${top}`);
  for (let mid = 0; mid < 6; mid++) {
    folder(`m${top}-${mid}`, `t${top}`, `学习资源 ${mid}`);
    for (let leaf = 0; leaf < 2; leaf++) {
      const parentId = `f${top}-${mid}-${leaf}`;
      folder(parentId, `m${top}-${mid}`, leaf ? '数据库与开发工具' : '前端与实用工具');
      for (let n = 0; n < 20; n++) {
        const id = `b${bookmarkIds.length}`;
        bookmarkIds.push(id);
        tree.nodes.push({
          ref: { installationId: tree.installationId, nativeId: id, kind: 'bookmark' },
          parentId,
          title: `${leaf ? '数据库' : '前端'}学习笔记与工具 ${n}`,
          url: `https://site${n}.example.test/articles/${id}?utm_source=synthetic#section`,
          index: n,
          childrenIds: [],
          readOnly: false,
          observedRevision: 1,
        });
      }
    }
  }
}
const byId = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
for (const node of tree.nodes) if (node.parentId) byId.get(node.parentId)!.childrenIds.push(node.ref.nativeId);
const folderIds = tree.nodes.filter(n => n.ref.kind === 'folder').map(n => n.ref.nativeId);
const privacy = { fullUrl: false, bodyEnabled: false, excludedFolders: [] };
const config = {
  adapter: 'openai-responses' as const,
  baseUrl: 'https://model.example.test/v1',
  model: 'synthetic-model',
  timeoutMs: 60000,
};
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const envelope = (request: AiRequest) =>
  modelRequestBody(config, request.task, serializeAiPayload(tree, privacy, request));
const search: AiRequest = { task: 'search', query: '前端工具', itemIds: bookmarkIds, folderIds: [] };
const save: AiRequest = { task: 'save', targetId: '0', item: { source: 'bookmark', id: bookmarkIds[0]! }, folderIds };
const saveCandidates = localClassification(tree, bookmarkIds[0]!, privacy, []).folderIds;
const base = {
  task: 'organize' as const,
  stage: 'bookmarks' as const,
  rootId: '0',
  folderIds,
  destinations: tree.nodes
    .filter(n => n.ref.kind === 'folder')
    .map(n => ({ id: n.ref.nativeId, parentId: n.parentId, title: n.title })),
  placements: Object.fromEntries(bookmarkIds.map(id => [id, byId.get(id)!.parentId!])),
};
const measurements = 2;
const start = performance.now();
const size = serializedItemRequestSize(
  serializeAiPayload(tree, privacy, { ...base, itemIds: bookmarkIds }),
  bytes(envelope({ ...base, itemIds: [] })),
);
const batches = partitionOrganizeItems(bookmarkIds, size, 100, MODEL_BYTE_LIMITS.requestBytes);
const partitionMs = performance.now() - start;
const indexStart = performance.now();
const index = new SearchIndex(tree);
const indexMs = performance.now() - indexStart;
const queryStart = performance.now();
const hits = index.query('前端工具');
const queryMs = performance.now() - queryStart;
const candidateStart = performance.now();
const fastCandidates = fastSearchCandidates(index, bookmarkIds, '前端工具', ['前端', '工具']);
const candidateSelectionMs = performance.now() - candidateStart;
console.log(
  JSON.stringify(
    {
      synthetic: true,
      folders: folderIds.length,
      bookmarks: bookmarkIds.length,
      saveRequestBytes: bytes(envelope({ ...save, folderIds: saveCandidates })),
      saveAllFoldersRequestBytes: bytes(envelope(save)),
      saveCandidateFolders: saveCandidates.length,
      legacyWholeSearchRequestBytes: bytes(envelope(search)),
      fastSearchCandidateRequestBytes: bytes(envelope({ ...search, itemIds: fastCandidates })),
      fastSearchExpandRequestBytes: bytes(
        envelope({ task: 'search-expand', query: search.query, itemIds: [], folderIds: [] }),
      ),
      fastSearchCandidates: fastCandidates.length,
      organize100RequestBytes: bytes(envelope({ ...base, itemIds: bookmarkIds.slice(0, 100) })),
      partition: {
        batches: batches.length,
        meanItems: bookmarkIds.length / batches.length,
        sizeCalls: measurements,
        ms: partitionMs,
      },
      localSearch: { indexMs, queryMs, hits: hits.length },
      candidateSelectionMs,
      providerRequests: 0,
    },
    null,
    2,
  ),
);
