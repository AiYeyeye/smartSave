import { expect, it } from 'vitest';
import { ImportDrafts } from '../panel/import-drafts';
import type { ImportCheckpoint } from '../persistence/import-checkpoints';
const checkpoint: ImportCheckpoint = { schemaVersion: 1, id: 'task', revision: 0, installationId: 'i', root: { installationId: 'i', nativeId: 'r', kind: 'folder' }, items: [{ titleLocked: true, item: { sourceOrdinal: 0, title: 'Original', rawURL: 'https://example.test', oldPath: [], sourceSpan: { start: 0, end: 20 }, provenance: { format: 'txt', urlSpan: { start: 0, end: 20 } } } }], classified: [], diagnostics: [], newFolders: [], phase: 'paused' };
it('ImportDrafts preserves intentional deselect-all and title edits through resume and same-task load', () => {
  const owner = new ImportDrafts(); expect(owner.get(checkpoint).selected).toEqual([0]);
  owner.set(checkpoint.id, { selected: [], edits: { 0: 'Explicit edit' } });
  expect(owner.get({ ...checkpoint, revision: 1, phase: 'classified', classified: [{ sourceOrdinal: 0, title: 'Original', folderId: 'r' }] })).toEqual({ selected: [], edits: { 0: 'Explicit edit' } });
  expect(owner.get(structuredClone(checkpoint))).toEqual({ selected: [], edits: { 0: 'Explicit edit' } });
  expect(owner.get({ ...checkpoint, id: 'other' }).selected).toEqual([0]);
  expect(checkpoint.items[0]!.item.title).toBe('Original');
});
it('explicit empty drafts before items arrive survive committed item batches without stage inference', () => {
  const owner = new ImportDrafts(); expect(owner.updateItems('mapping', []).selected).toEqual([]);
  owner.set('mapping', { selected: [], edits: { 0: '' }, destinations: { 0: '' } });
  expect(owner.updateItems('mapping', [0, 1])).toEqual({ selected: [], edits: { 0: '' }, destinations: { 0: '' } });
  expect(owner.updateItems('mapping', [0, 1, 2])).toEqual({ selected: [], edits: { 0: '' }, destinations: { 0: '' } });
  expect(owner.updateItems('untouched', []).selected).toEqual([]);
  expect(owner.updateItems('untouched', [0, 1])).toEqual({ selected: [0, 1], edits: {} });
});
