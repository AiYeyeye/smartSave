import type { NodeRef, TreeSnapshot } from './node-reference';
import { organizePreference, type OrganizePreference } from './organize-preferences';
export interface AiPrivacy {
  fullUrl: boolean;
  bodyEnabled: boolean;
  excludedFolders: NodeRef[];
}
export type AiItem =
  | { source: 'bookmark'; id: string }
  | { source: 'new-import' | 'current-page'; id: string; title: string; url: string };
export type AiSample =
  | { source: 'bookmark'; contextId: string; field: 'title' | 'url' }
  | { source: 'new-import'; value: string; kind: 'url' | 'text' };
export type OrganizeDestination = { id: string; parentId?: string; title: string };

/** Compact wire copy only. The canonical payload remains available for validation/freshness. */
export function compactAiPayload(payload: string): string {
  let value: {
    folders?: { id: string; ancestorIds: string[]; path: string[] }[];
    items?: unknown[];
    query?: string;
    fields?: unknown[];
    snippet?: string;
    [key: string]: unknown;
  };
  try {
    value = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (
    !value ||
    !Array.isArray(value.folders) ||
    value.folders.some(f => !f || typeof f.id !== 'string' || !Array.isArray(f.ancestorIds) || !Array.isArray(f.path))
  )
    return payload;
  const { folders, items, query, fields, snippet, ...shared } = value;
  const ids = new Set(folders.map(f => f.id));
  const children = new Map<string | undefined, typeof folders>();
  for (const folder of folders) {
    const parent = folder.ancestorIds.find(id => ids.has(id));
    const list = children.get(parent) ?? [];
    list.push(folder);
    children.set(parent, list);
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  function visit(parent: string | undefined, depth: number) {
    for (const folder of [...(children.get(parent) ?? [])].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
      if (seen.has(folder.id)) throw Error('invalid-tree');
      seen.add(folder.id);
      lines.push(`${'  '.repeat(depth)}${JSON.stringify(folder.id)} ${JSON.stringify(folder.path.at(-1) ?? '')}`);
      visit(folder.id, depth + 1);
    }
  }
  visit(undefined, 0);
  if (seen.size !== folders.length) throw Error('invalid-tree');
  return JSON.stringify({
    ...shared,
    folderTree: lines.join('\n'),
    ...(query === undefined ? {} : { query }),
    items,
    ...(fields === undefined ? {} : { fields }),
    ...(snippet === undefined ? {} : { snippet }),
  });
}

/** Exact UTF-8 increments when this JSON payload is embedded as one JSON string in a protocol envelope. */
export function serializedItemRequestSize(payload: string, emptyRequestBytes: number) {
  const parsed: { items: { id: string }[] } = JSON.parse(payload);
  const encoder = new TextEncoder();
  const sizes = new Map<string, number>();
  for (const item of parsed.items) {
    if (sizes.has(item.id)) throw Error('duplicate-id');
    // One outer string-escape layer, without the surrounding quotes. Commas are added by the partitioner.
    sizes.set(item.id, encoder.encode(JSON.stringify(JSON.stringify(item))).byteLength - 2);
  }
  return {
    sharedBytes: emptyRequestBytes,
    itemBytes(id: string) {
      const value = sizes.get(id);
      if (value === undefined) throw Error('invalid-reference');
      return value;
    },
  };
}
export type AiRequest =
  | { task: 'search'; query: string; itemIds: string[]; folderIds: string[] }
  | {
      task: 'organize';
      rootId: string;
      itemIds: string[];
      folderIds: string[];
      preference?: OrganizePreference;
      stage?: 'folders' | 'bookmarks';
      destinations?: OrganizeDestination[];
      placements?: Record<string, string>;
      sampleLimit?: number;
      omittedItemsUnchanged?: boolean;
    }
  | { task: 'save'; targetId: string; item: AiItem; folderIds: string[]; snippet?: string }
  | { task: 'import-map'; targetId: string; fields: { path: string[]; samples: AiSample[] }[]; folderIds: string[] }
  | {
      task: 'import-classify';
      targetId: string;
      items: AiItem[];
      folderIds: string[];
      proposedFolders?: { id: string; parentId: string; title: string }[];
    };
export function serializeAiPayload(tree: TreeSnapshot, privacy: AiPrivacy, request: AiRequest): string {
  const nodes = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
  const excluded = new Set(
    privacy.excludedFolders.filter(r => r.installationId === tree.installationId).map(r => r.nativeId),
  );
  function ancestors(id: string) {
    const result = [];
    const seen = new Set<string>();
    let node = nodes.get(id);
    if (!node) throw Error('invalid-reference');
    while (node) {
      if (seen.has(node.ref.nativeId)) throw Error('invalid-tree');
      seen.add(node.ref.nativeId);
      result.push(node);
      if (node.parentId === undefined) break;
      node = nodes.get(node.parentId);
      if (!node) throw Error('invalid-tree');
    }
    return result;
  }
  const allowed = (id: string) => !ancestors(id).some(n => excluded.has(n.ref.nativeId));
  const urlCopy = (url: string) => (privacy.fullUrl ? url : url.split(/[?#]/, 1)[0]!);
  const folders = request.folderIds.filter(allowed).map(id => {
    const chain = ancestors(id);
    if (chain[0]?.ref.kind !== 'folder') throw Error('invalid-folder');
    return { id, ancestorIds: chain.slice(1).map(n => n.ref.nativeId), path: chain.reverse().map(n => n.title) };
  });
  if (request.task === 'search' || request.task === 'organize') {
    if (request.task === 'organize' && !allowed(request.rootId)) throw Error('privacy-excluded');
    const ids = request.itemIds.filter(allowed);
    const items = ids.map(id => {
      const chain = ancestors(id);
      const node = chain[0]!;
      if (
        request.task === 'organize' &&
        request.stage &&
        node.ref.kind !== (request.stage === 'folders' ? 'folder' : 'bookmark')
      )
        throw Error('invalid-organize-stage');
      if (request.task === 'organize' && !chain.some(n => n.ref.nativeId === request.rootId))
        throw Error('outside-scope');
      return {
        id,
        title: node.title,
        ...(node.url === undefined ? {} : { url: urlCopy(node.url) }),
        path: chain
          .slice(1)
          .reverse()
          .map(n => n.title),
      };
    });
    if (request.task === 'organize' && folders.some(f => !ancestors(f.id).some(n => n.ref.nativeId === request.rootId)))
      throw Error('outside-scope');
    let destinations = folders;
    let folderSummaries: { folderId: string; bookmarkCount: number; sampleTitles: string[] }[] | undefined;
    if (request.task === 'organize' && request.stage === 'folders') {
      const summaries = new Map(
        folders.map(f => [f.id, { folderId: f.id, bookmarkCount: 0, sampleTitles: [] as string[] }]),
      );
      const limit = Math.min(2, Math.max(0, request.sampleLimit ?? 2));
      for (const node of tree.nodes) {
        if (node.ref.kind !== 'bookmark' || !allowed(node.ref.nativeId)) continue;
        const summary = summaries.get(node.parentId ?? '');
        if (!summary) continue;
        summary.bookmarkCount++;
        if (summary.sampleTitles.length < limit)
          summary.sampleTitles.push(Array.from(node.title).slice(0, 160).join(''));
      }
      folderSummaries = [...summaries.values()];
    }
    if (request.task === 'organize' && request.stage === 'bookmarks') {
      const planned = new Map(request.destinations?.map(f => [f.id, f]));
      if (!planned.has(request.rootId) || planned.size !== request.destinations?.length)
        throw Error('invalid-organize-plan');
      const offered = new Set(folders.map(f => f.id));
      destinations = [...planned.values()].map(folder => {
        const chain: OrganizeDestination[] = [];
        const seen = new Set<string>();
        let current: OrganizeDestination | undefined = folder;
        while (current) {
          if (
            seen.has(current.id) ||
            !current.id ||
            (!nodes.has(current.id) && !current.title.trim()) ||
            (nodes.has(current.id) && !offered.has(current.id))
          )
            throw Error('invalid-organize-plan');
          seen.add(current.id);
          chain.push(current);
          if (current.id === request.rootId) break;
          current = planned.get(current.parentId ?? '');
          if (!current) throw Error('invalid-organize-plan');
        }
        return { id: folder.id, ancestorIds: chain.slice(1).map(f => f.id), path: chain.reverse().map(f => f.title) };
      });
      for (const item of items) {
        const current = request.placements?.[item.id];
        if (request.placements && (!current || !planned.has(current))) throw Error('invalid-organize-plan');
        if (current) Object.assign(item, { currentFolderId: current });
      }
    }
    return JSON.stringify({
      task: request.task,
      ...(request.task === 'organize' && request.stage ? { stage: request.stage, folderSummaries } : {}),
      ...(request.task === 'organize' && request.stage === 'bookmarks' && request.omittedItemsUnchanged
        ? { omittedItemsUnchanged: true }
        : {}),
      ...(request.task === 'search' ? { query: request.query } : {}),
      ...(request.task === 'organize' && request.preference
        ? { preference: organizePreference(request.preference) }
        : {}),
      items,
      folders: destinations,
    });
  }
  if (!allowed(request.targetId)) throw Error('privacy-excluded');
  if (nodes.get(request.targetId)?.ref.kind !== 'folder') throw Error('invalid-folder');
  if (request.task !== 'save' && folders.some(f => !ancestors(f.id).some(n => n.ref.nativeId === request.targetId)))
    throw Error('outside-scope');
  if (request.task === 'import-map') {
    const fields = request.fields.map(field => ({
      path: [...field.path],
      samples: field.samples.flatMap(sample => {
        if (sample.source === 'bookmark') {
          if (!allowed(sample.contextId)) return [];
          const node = nodes.get(sample.contextId)!;
          if (sample.field === 'url') return node.url === undefined ? [] : [urlCopy(node.url)];
          if (sample.field !== 'title') throw Error('invalid-provenance');
          if (!privacy.fullUrl && /[?#]/.test(node.title)) throw Error('unsafe-text-sample');
          return [node.title];
        }
        if (sample.source !== 'new-import') throw Error('invalid-provenance');
        if (sample.kind === 'url') {
          new URL(sample.value);
          return [urlCopy(sample.value)];
        }
        if (sample.kind !== 'text') throw Error('invalid-provenance');
        // Unknown free-text URL boundaries cannot be sanitized reliably. Reject rather than leak or truncate.
        if (!privacy.fullUrl && /[?#]/.test(sample.value)) throw Error('unsafe-text-sample');
        return [sample.value];
      }),
    }));
    return JSON.stringify({ task: request.task, items: [], folders, fields });
  }
  if (request.task === 'import-classify' && request.proposedFolders?.length) {
    const proposals = new Map(request.proposedFolders.map(f => [f.id, f]));
    if (proposals.size !== request.proposedFolders.length) throw Error('invalid-proposed-folder');
    for (const folder of proposals.values()) {
      if (nodes.has(folder.id) || request.items.some(i => i.id === folder.id) || !folder.id || !folder.title.trim())
        throw Error('invalid-proposed-folder');
      const chain = [folder];
      const seen = new Set([folder.id]);
      let parent = folder.parentId;
      while (proposals.has(parent)) {
        if (seen.has(parent)) throw Error('invalid-proposed-folder');
        seen.add(parent);
        const next = proposals.get(parent)!;
        chain.push(next);
        parent = next.parentId;
      }
      const base = folders.find(f => f.id === parent);
      if (!base) throw Error('outside-scope');
      folders.push({
        id: folder.id,
        ancestorIds: [...chain.slice(1).map(f => f.id), base.id, ...base.ancestorIds],
        path: [...base.path, ...chain.reverse().map(f => f.title)],
      });
    }
  }
  const project = (item: AiItem) => {
    if (item.source === 'bookmark') {
      if (!allowed(item.id)) return [];
      const node = nodes.get(item.id)!;
      if (node.url === undefined) throw Error('invalid-reference');
      return [{ id: item.id, title: node.title, url: urlCopy(node.url) }];
    }
    if (item.source !== 'new-import' && item.source !== 'current-page') throw Error('invalid-provenance');
    if (nodes.has(item.id)) throw Error('ambiguous-provenance');
    return [{ id: item.id, title: item.title, url: urlCopy(item.url) }];
  };
  return JSON.stringify({
    task: request.task,
    items: request.task === 'save' ? project(request.item) : request.items.flatMap(project),
    folders,
    ...(request.task === 'save' && request.item.source === 'current-page' && privacy.bodyEnabled && request.snippet
      ? { snippet: Array.from(request.snippet).slice(0, 1500).join('') }
      : {}),
  });
}
