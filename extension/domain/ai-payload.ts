import type { NodeRef, TreeSnapshot } from './node-reference';
export interface AiPrivacy { fullUrl: boolean; bodyEnabled: boolean; excludedFolders: NodeRef[] }
export type AiItem = { source: 'bookmark'; id: string } | { source: 'new-import' | 'current-page'; id: string; title: string; url: string };
export type AiSample = { source: 'bookmark'; contextId: string; field: 'title' | 'url' } | { source: 'new-import'; value: string; kind: 'url' | 'text' };
export type AiRequest =
  | { task: 'search'; query: string; itemIds: string[]; folderIds: string[] }
  | { task: 'organize'; rootId: string; itemIds: string[]; folderIds: string[] }
  | { task: 'save'; targetId: string; item: AiItem; folderIds: string[]; snippet?: string }
  | { task: 'import-map'; targetId: string; fields: { path: string[]; samples: AiSample[] }[]; folderIds: string[] }
  | { task: 'import-classify'; targetId: string; items: AiItem[]; folderIds: string[]; proposedFolders?: { id: string; parentId: string; title: string }[] };
export function serializeAiPayload(tree: TreeSnapshot, privacy: AiPrivacy, request: AiRequest): string {
  const nodes = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
  const excluded = new Set(privacy.excludedFolders.filter(r => r.installationId === tree.installationId).map(r => r.nativeId));
  function ancestors(id: string) {
    const result = []; const seen = new Set<string>(); let node = nodes.get(id);
    if (!node) throw Error('invalid-reference');
    while (node) {
      if (seen.has(node.ref.nativeId)) throw Error('invalid-tree');
      seen.add(node.ref.nativeId); result.push(node);
      if (node.parentId === undefined) break;
      node = nodes.get(node.parentId); if (!node) throw Error('invalid-tree');
    }
    return result;
  }
  const allowed = (id: string) => !ancestors(id).some(n => excluded.has(n.ref.nativeId));
  const urlCopy = (url: string) => privacy.fullUrl ? url : url.split(/[?#]/, 1)[0]!;
  const folders = request.folderIds.filter(allowed).map(id => {
    const chain = ancestors(id); if (chain[0]?.ref.kind !== 'folder') throw Error('invalid-folder');
    return { id, ancestorIds: chain.slice(1).map(n => n.ref.nativeId), path: chain.reverse().map(n => n.title) };
  });
  if (request.task === 'search' || request.task === 'organize') {
    if (request.task === 'organize' && !allowed(request.rootId)) throw Error('privacy-excluded');
    const ids = request.itemIds.filter(allowed);
    const items = ids.slice(0, request.task === 'search' ? 8 : ids.length).map(id => {
      const chain = ancestors(id); const node = chain[0]!;
      if (request.task === 'organize' && !chain.some(n => n.ref.nativeId === request.rootId)) throw Error('outside-scope');
      return { id, title: node.title, ...(node.url === undefined ? {} : { url: urlCopy(node.url) }), path: chain.slice(1).reverse().map(n => n.title) };
    });
    if (request.task === 'organize' && folders.some(f => !ancestors(f.id).some(n => n.ref.nativeId === request.rootId))) throw Error('outside-scope');
    return JSON.stringify({ task: request.task, ...(request.task === 'search' ? { query: request.query } : {}), items, folders });
  }
  if (!allowed(request.targetId)) throw Error('privacy-excluded');
  if (nodes.get(request.targetId)?.ref.kind !== 'folder') throw Error('invalid-folder');
  if (request.task !== 'save' && folders.some(f => !ancestors(f.id).some(n => n.ref.nativeId === request.targetId))) throw Error('outside-scope');
  if (request.task === 'import-map') {
    const fields = request.fields.map(field => ({ path: [...field.path], samples: field.samples.flatMap(sample => {
      if (sample.source === 'bookmark') {
        if (!allowed(sample.contextId)) return [];
        const node = nodes.get(sample.contextId)!;
        if (sample.field === 'url') return node.url === undefined ? [] : [urlCopy(node.url)];
        if (sample.field !== 'title') throw Error('invalid-provenance');
        if (!privacy.fullUrl && /[?#]/.test(node.title)) throw Error('unsafe-text-sample');
        return [node.title];
      }
      if (sample.source !== 'new-import') throw Error('invalid-provenance');
      if (sample.kind === 'url') { new URL(sample.value); return [urlCopy(sample.value)]; }
      if (sample.kind !== 'text') throw Error('invalid-provenance');
      // Unknown free-text URL boundaries cannot be sanitized reliably. Reject rather than leak or truncate.
      if (!privacy.fullUrl && /[?#]/.test(sample.value)) throw Error('unsafe-text-sample');
      return [sample.value];
    }) }));
    return JSON.stringify({ task: request.task, items: [], folders, fields });
  }
  if (request.task === 'import-classify' && request.proposedFolders?.length) {
    const proposals = new Map(request.proposedFolders.map(f => [f.id, f]));
    if (proposals.size !== request.proposedFolders.length) throw Error('invalid-proposed-folder');
    for (const folder of proposals.values()) {
      if (nodes.has(folder.id) || request.items.some(i => i.id === folder.id) || !folder.id || !folder.title.trim()) throw Error('invalid-proposed-folder');
      const chain = [folder]; const seen = new Set([folder.id]); let parent = folder.parentId;
      while (proposals.has(parent)) {
        if (seen.has(parent)) throw Error('invalid-proposed-folder');
        seen.add(parent); const next = proposals.get(parent)!; chain.push(next); parent = next.parentId;
      }
      const base = folders.find(f => f.id === parent);
      if (!base) throw Error('outside-scope');
      folders.push({ id: folder.id, ancestorIds: [...chain.slice(1).map(f => f.id), base.id, ...base.ancestorIds], path: [...base.path, ...chain.reverse().map(f => f.title)] });
    }
  }
  const project = (item: AiItem) => {
    if (item.source === 'bookmark') {
      if (!allowed(item.id)) return [];
      const node = nodes.get(item.id)!; if (node.url === undefined) throw Error('invalid-reference');
      return [{ id: item.id, title: node.title, url: urlCopy(node.url) }];
    }
    if (item.source !== 'new-import' && item.source !== 'current-page') throw Error('invalid-provenance');
    if (nodes.has(item.id)) throw Error('ambiguous-provenance');
    return [{ id: item.id, title: item.title, url: urlCopy(item.url) }];
  };
  return JSON.stringify({ task: request.task, items: request.task === 'save' ? project(request.item) : request.items.flatMap(project), folders,
    ...(request.task === 'save' && request.item.source === 'current-page' && privacy.bodyEnabled && request.snippet ? { snippet: Array.from(request.snippet).slice(0, 1500).join('') } : {}) });
}
