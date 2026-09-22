import { z } from 'zod';
import { nodeRefSchema, type TreeSnapshot } from './node-reference';
import { importCheckpointSchema, type ImportCheckpoint } from '../persistence/import-checkpoints';
import { confirmSchema, type ConfirmMutation, type Command } from '../schemas/messages';
import { preflight } from './preflight';
export const importSelectionSchema = z
  .object({
    root: nodeRefSchema.strict(),
    selectedSourceOrdinals: z.array(z.number().int().nonnegative()),
    destinationEdits: z
      .array(z.object({ sourceOrdinal: z.number().int().nonnegative(), folderId: z.string().min(1) }).strict())
      .optional(),
    titleEdits: z.array(z.object({ sourceOrdinal: z.number().int().nonnegative(), title: z.string() }).strict()),
  })
  .strict();
export type ImportPreviewSelection = z.infer<typeof importSelectionSchema>;
/** Structural destination eligibility only; fresh privacy and write authorization remain background-owned. */
export function eligibleImportDestination(tree: TreeSnapshot, rootId: string, id: string): boolean {
  const nodes = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
  const node = nodes.get(id);
  let cursor = node;
  const seen = new Set<string>();
  if (!node?.childrenWritable || node.ref.kind !== 'folder') return false;
  while (cursor && !seen.has(cursor.ref.nativeId)) {
    seen.add(cursor.ref.nativeId);
    if (cursor.ref.nativeId === rootId) return true;
    cursor = cursor.parentId === undefined ? undefined : nodes.get(cursor.parentId);
  }
  return false;
}
/** Pure proposal compiler. No classification or durable data ever grants execution authority. */
export function compileImportPreview(
  raw: ImportCheckpoint,
  input: ImportPreviewSelection,
  tree: TreeSnapshot,
  requestId: string,
): ConfirmMutation | undefined {
  const checkpoint = importCheckpointSchema.parse(raw);
  const selection = importSelectionSchema.parse(input);
  if (
    checkpoint.phase !== 'classified' ||
    checkpoint.requestId ||
    JSON.stringify(checkpoint.root) !== JSON.stringify(selection.root) ||
    checkpoint.installationId !== tree.installationId
  )
    throw Error('import-reclassification-required');
  const nodes = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
  const folders = new Map(checkpoint.newFolders.map(f => [f.id, f]));
  if (checkpoint.newFolders.some(f => nodes.has(f.id))) throw Error('invalid-import-folder');
  const selected = new Set(selection.selectedSourceOrdinals);
  const edits = new Map(selection.titleEdits.map(e => [e.sourceOrdinal, e.title]));
  if (
    selected.size !== selection.selectedSourceOrdinals.length ||
    edits.size !== selection.titleEdits.length ||
    [...edits.keys()].some(id => !selected.has(id)) ||
    [...selected].some(id => !checkpoint.classified.some(r => r.sourceOrdinal === id))
  )
    throw Error('invalid-import-selection');
  const destinations = new Map((selection.destinationEdits ?? []).map(e => [e.sourceOrdinal, e.folderId]));
  if (
    destinations.size !== (selection.destinationEdits ?? []).length ||
    [...destinations.keys()].some(id => !selected.has(id))
  )
    throw Error('invalid-import-selection');
  const operations: Extract<Command, { type: 'batch' }>['operations'] = [];
  const owners = new Map<string, string>();
  const visiting = new Set<string>();
  const nativeParent = (id: string) => {
    if (!eligibleImportDestination(tree, selection.root.nativeId, id)) throw Error('invalid-import-target');
    return nodes.get(id)!.ref;
  };
  nativeParent(selection.root.nativeId);
  const parent = (id: string): { ref: typeof selection.root; dependsOn: string[] } => {
    const folder = folders.get(id);
    if (!folder) return { ref: nativeParent(id), dependsOn: [] };
    if (visiting.has(id)) throw Error('invalid-import-folder');
    let owner = owners.get(id);
    if (!owner) {
      visiting.add(id);
      const ancestor = parent(folder.parentId);
      visiting.delete(id);
      owner = `folder:${id}`;
      owners.set(id, owner);
      operations.push({
        id: owner,
        dependsOn: ancestor.dependsOn,
        command: { type: 'create', parent: ancestor.ref, title: folder.title },
      });
    }
    return { ref: { ...selection.root, nativeId: `$batch:${owner}:$created` }, dependsOn: [owner] };
  };
  const urls = new Set(tree.nodes.flatMap(n => (n.url === undefined ? [] : [n.url])));
  for (const row of checkpoint.classified) {
    if (!selected.has(row.sourceOrdinal)) continue;
    const item = checkpoint.items.find(i => i.item.sourceOrdinal === row.sourceOrdinal)!.item;
    if (urls.has(item.rawURL)) continue;
    urls.add(item.rawURL);
    const target = parent(destinations.get(row.sourceOrdinal) ?? row.folderId);
    operations.push({
      id: `item:${row.sourceOrdinal}`,
      dependsOn: target.dependsOn,
      command: {
        type: 'create',
        parent: target.ref,
        title: edits.get(row.sourceOrdinal) ?? row.title,
        url: item.rawURL,
      },
    });
  }
  if (!operations.length) return undefined;
  const request = confirmSchema.parse({
    version: 1,
    type: 'confirmMutation',
    requestId,
    installationId: tree.installationId,
    epoch: tree.epoch,
    observedRevision: tree.observedRevision,
    scope: selection.root,
    before: tree.nodes,
    command: { type: 'batch', operations, selectedOperationIds: operations.map(o => o.id) },
  });
  preflight(request, tree);
  return request;
}
