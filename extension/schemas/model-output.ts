import { z } from 'zod';
const id = z.string().min(1);
const mapping = z.strictObject({ urlPath: z.array(id).min(1), titlePath: z.array(id).min(1).nullable() });
const search = z.strictObject({ rankedIds: z.array(id) });
const folder = z.strictObject({ id, parentId: id, title: z.string().min(1) });
const assignments = z.strictObject({ assignments: z.array(z.strictObject({ itemId: id, folderId: id })), newFolders: z.array(folder) });
const importAssignments = z.strictObject({ assignments: z.array(z.strictObject({ itemId: id, folderId: id, title: z.string().min(1).optional() })), newFolders: z.array(folder) });
const organize = z.strictObject({ moves: z.array(z.strictObject({ itemId: id, folderId: id })), newFolders: z.array(folder), merges: z.array(z.strictObject({ sourceId: id, targetId: id })) });
export interface ModelOutputContext { task: string; items: { id: string; title: string; url?: string }[]; folders: { id: string; path?: string[]; ancestorIds?: string[] }[]; fields?: { path: string[] }[] }
export function outputSchema(task: string) { return task === 'import-classify' ? importAssignments : task === 'import-map' ? mapping : task === 'search' ? search : task === 'organize' ? organize : assignments; }
export function modelOutputJsonSchema(task: string) { return z.toJSONSchema(outputSchema(task)); }
export function parseModelOutput(value: unknown, context: ModelOutputContext) {
  try {
    const result = outputSchema(context.task).parse(value);
    if ('urlPath' in result) {
      const paths = new Set(context.fields?.map(f => JSON.stringify(f.path)));
      if (!paths.has(JSON.stringify(result.urlPath)) || (result.titlePath !== null && !paths.has(JSON.stringify(result.titlePath)))) throw Error();
      return result;
    }
    const unique = (ids: string[]) => { if (new Set(ids).size !== ids.length) throw Error(); };
    const items = new Set(context.items.map(i => i.id));
    const folders = new Set(context.folders.map(f => f.id));
    if ('rankedIds' in result) {
      unique(result.rankedIds); if (result.rankedIds.some(i => !items.has(i))) throw Error(); return result;
    }
    unique(result.newFolders.map(f => f.id));
    const parents = new Map(result.newFolders.map(f => [f.id, f.parentId]));
    for (const f of result.newFolders) {
      if (folders.has(f.id) || items.has(f.id)) throw Error();
      let parent = f.parentId; const seen = new Set([f.id]);
      while (!folders.has(parent)) { if (seen.has(parent)) throw Error(); seen.add(parent); const next = parents.get(parent); if (!next) throw Error(); parent = next; }
    }
    const targets = new Set([...folders, ...parents.keys()]);
    const descendant = (source: string, target: string) => {
      let current = target; const seen = new Set<string>();
      while (parents.has(current)) { if (current === source || seen.has(current)) return true; seen.add(current); current = parents.get(current)!; }
      return current === source || context.folders.find(f => f.id === current)?.ancestorIds?.includes(source) === true;
    };
    const actions = 'assignments' in result ? result.assignments : result.moves;
    unique(actions.map(a => a.itemId));
    if (actions.some(a => !items.has(a.itemId) || !targets.has(a.folderId) || descendant(a.itemId, a.folderId))) throw Error();
    if ('assignments' in result && actions.length !== items.size) throw Error();
    if ('merges' in result) {
      // Both action kinds write the same identity; reject overlap before Map can erase an edge.
      unique([...result.moves.map(m => m.itemId), ...result.merges.map(m => m.sourceId)]);
      for (const m of result.merges) if (!folders.has(m.sourceId) || !folders.has(m.targetId) || descendant(m.sourceId, m.targetId)) throw Error();
      const edges = new Map([...result.moves.map(m => [m.itemId, m.folderId] as const), ...result.merges.map(m => [m.sourceId, m.targetId] as const), ...parents]);
      for (const start of edges.keys()) { const seen = new Set<string>(); let cursor: string | undefined = start; while (cursor !== undefined) { if (seen.has(cursor)) throw Error(); seen.add(cursor); cursor = edges.get(cursor); } }
    }
    return result;
  } catch { throw Error('invalid-output'); }
}
