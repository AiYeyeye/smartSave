import { expect, it } from 'vitest';
import { compileImportPreview } from '../domain/import-preview';
import type { ImportCheckpoint } from '../persistence/import-checkpoints';
import type { TreeSnapshot } from '../domain/node-reference';
const root = { installationId: 'i', nativeId: 'bar', kind: 'folder' as const };
const tree: TreeSnapshot = { installationId: 'i', epoch: 'e', observedRevision: 0, roots: ['bar'], nodes: [{ ref: root, title: 'Bar', childrenIds: [], index: 0, readOnly: true, childrenWritable: true, observedRevision: 0 }] };
const checkpoint: ImportCheckpoint = { schemaVersion: 1, id: 'c', revision: 0, installationId: 'i', root, phase: 'classified', diagnostics: [], items: [0, 1].map(sourceOrdinal => ({ titleLocked: true, item: { sourceOrdinal, sourceSpan: { start: 0, end: 1 }, rawURL: `https://example.test/${sourceOrdinal}?x=1#q`, title: 'Source', oldPath: [], provenance: { format: 'txt', urlSpan: { start: 0, end: 1 } } } })), classified: [0, 1].map(sourceOrdinal => ({ sourceOrdinal, folderId: sourceOrdinal ? 'unused' : 'inner', title: 'Source' })), newFolders: [{ id: 'outer', parentId: 'bar', title: 'Outer' }, { id: 'inner', parentId: 'outer', title: 'Inner' }, { id: 'unused', parentId: 'bar', title: 'Unused' }] };
it('compiles only selected ancestor creates and explicit title edits, retaining source evidence', () => {
  const before = structuredClone(checkpoint);
  const request = compileImportPreview(checkpoint, { root, selectedSourceOrdinals: [0], titleEdits: [{ sourceOrdinal: 0, title: 'User' }] }, tree, 'r')!;
  expect(request.command.type).toBe('batch');
  if (request.command.type !== 'batch') throw Error('not batch');
  expect(request.command.operations.map(o => o.command.type)).toEqual(['create', 'create', 'create']);
  expect(request.command.operations.map(o => 'title' in o.command && o.command.title)).toEqual(['Outer', 'Inner', 'User']);
  expect(checkpoint).toEqual(before);
});
it('returns no request and no directories for empty selection or global exact duplicates', () => {
  expect(compileImportPreview(checkpoint, { root, selectedSourceOrdinals: [], titleEdits: [] }, tree, 'r')).toBeUndefined();
  const duplicateTree = structuredClone(tree);
  duplicateTree.nodes.push({ ...tree.nodes[0]!, ref: { ...root, nativeId: 'elsewhere', kind: 'bookmark' }, url: checkpoint.items[0]!.item.rawURL, childrenWritable: false });
  expect(compileImportPreview(checkpoint, { root, selectedSourceOrdinals: [0], titleEdits: [] }, duplicateTree, 'r')).toBeUndefined();
});
it('rejects unknown selection, root replacement, cycles and applying checkpoints', () => {
  const selection = { root, selectedSourceOrdinals: [0], titleEdits: [] };
  expect(() => compileImportPreview(checkpoint, { ...selection, selectedSourceOrdinals: [99] }, tree, 'r')).toThrow();
  expect(() => compileImportPreview(checkpoint, { ...selection, root: { ...root, nativeId: 'other' } }, tree, 'r')).toThrow();
  expect(() => compileImportPreview({ ...checkpoint, newFolders: [{ id: 'inner', parentId: 'inner', title: 'Loop' }] }, selection, tree, 'r')).toThrow();
  expect(() => compileImportPreview({ ...checkpoint, phase: 'applying', requestId: 'old' }, selection, tree, 'r')).toThrow();
});
it('explicit destinations prune old proposals, preserve classification and reject outside/managed/empty targets', () => {
  const before = structuredClone(checkpoint);
  const selection = { root, selectedSourceOrdinals: [0], titleEdits: [], destinationEdits: [{ sourceOrdinal: 0, folderId: 'bar' }] };
  const result = compileImportPreview(checkpoint, selection, tree, 'destination')!;
  expect(result.command.type === 'batch' && result.command.operations.map(o => o.id)).toEqual(['item:0']);
  expect(checkpoint).toEqual(before);
  for (const folderId of ['outside', 'managed', '']) {
    const context = structuredClone(tree);
    context.nodes.push({ ...tree.nodes[0]!, ref: { ...root, nativeId: folderId }, childrenWritable: folderId !== 'managed' });
    expect(() => compileImportPreview(checkpoint, { ...selection, destinationEdits: [{ sourceOrdinal: 0, folderId }] }, context, 'bad')).toThrow();
  }
});
