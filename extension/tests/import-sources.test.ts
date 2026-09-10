import { expect, it } from 'vitest';
import { importSourceItems } from '../domain/import-sources';
import type { ImportCheckpoint } from '../persistence/import-checkpoints';
const item = (sourceOrdinal: number, start: number, title: string) => ({ sourceOrdinal, sourceSpan: { start, end: start + 1 }, rawURL: `https://${title}.test/`, title, oldPath: [title], provenance: { format: 'json' as const, sourcePath: [title], urlSpan: { start, end: start + 1 } } });
const runtime: NonNullable<ImportCheckpoint['runtime']> = { version: 2, semanticDigest: 'digest', contextDigest: 'digest', stage: 'classification', format: 'json', candidates: [{ sourcePath: ['link'], value: 'https://mapped.test/', sourceSpan: { start: 0, end: 1 } }], sourceItems: [item(9, 5, 'later'), item(4, 0, 'first')], mappedGroups: [], mappedItems: [] };
it('mapping-origin with zero mapped outputs still renumbers stable original span order', () => {
  expect(importSourceItems(runtime).map(i => [i.sourceOrdinal, i.title, i.oldPath, i.provenance.sourcePath])).toEqual([[0, 'first', ['first'], ['first']], [1, 'later', ['later'], ['later']]]);
  expect(runtime.sourceItems.map(i => i.sourceOrdinal)).toEqual([9, 4]);
});
it('ties preserve original-before-mapped provenance and nonmapping ordinals remain untouched', () => {
  expect(importSourceItems({ ...runtime, mappedItems: [item(10, 0, 'mapped')] }).map(i => i.title)).toEqual(['first', 'mapped', 'later']);
  expect(importSourceItems({ ...runtime, candidates: [] })).toEqual(runtime.sourceItems);
});
