import { expect, it } from 'vitest';
import { parseImport } from '../import/parsers';
import { deduplicateImport } from '../domain/import-deduplication';
import type { TreeSnapshot } from '../domain/node-reference';
const tree: TreeSnapshot = { installationId: 'test', epoch: 'epoch', observedRevision: 1, roots: [], nodes: [] };
const parse = (text: string) => parseImport(new TextEncoder().encode(text), 'json').items;
it('consumes real parser order, retains first valid title and every later duplicate diagnostic without changing sources', () => {
  const items = parse('[{"url":"https://a.test/","title":" "},{"url":"https://a.test/","title":" first "},{"url":"https://a.test/","title":"later"}]');
  const original = structuredClone(items);
  const result = deduplicateImport([...items].reverse(), tree);
  expect(result.pending).toHaveLength(1);
  expect(result.pending[0]).toMatchObject({ titleLocked: true, item: { sourceOrdinal: 0, title: ' first ' } });
  expect(result.diagnostics).toEqual([1, 2].map(sourceOrdinal => ({ sourceOrdinal, reason: 'file-duplicate', retainedSourceOrdinal: 0 })));
  expect(items).toEqual(original);
});
it('skips exact original URLs globally but does not canonicalize query, fragment or spelling', () => {
  const snapshot: TreeSnapshot = { ...tree, nodes: [{ ref: { installationId: 'test', nativeId: 'outside', kind: 'bookmark' }, title: 'existing', url: 'https://a.test/?q=1#x', index: 0, childrenIds: [], readOnly: false, observedRevision: 1 }] };
  const result = deduplicateImport(parse('[{"url":"https://a.test/?q=1#x"},{"url":"https://a.test/?q=1#y"},{"url":"https://A.test/?q=1#x"}]'), snapshot);
  expect(result.pending.map(p => p.item.rawURL)).toEqual(['https://a.test/?q=1#y', 'https://A.test/?q=1#x']);
  expect(result.diagnostics).toEqual([{ sourceOrdinal: 0, reason: 'existing-url' }]);
});
it('retains invalid and unsupported diagnostics and validates caller values even without parser flags', () => {
  const items = parse('[{"url":"ftp://a.test/"},{"url":"bad"},{"url":"https://a.test/","title":""}]');
  delete items[0]!.diagnostic;
  const result = deduplicateImport(items, tree);
  expect(result.diagnostics.map(d => d.reason)).toEqual(['unsupported-protocol', 'invalid-url']);
  expect(result.pending[0]!.titleLocked).toBe(false);
});
it('rejects ambiguous provenance ordinals instead of losing an item', () => {
  const items = parse('[{"url":"https://a.test/"}]');
  expect(() => deduplicateImport([...items, ...items], tree)).toThrow('invalid-source-ordinal');
});

it('shares Unicode whitespace policy with parser even when the diagnostic is removed', () => {
  const items = parse(JSON.stringify([{ url: ' https://a.test/ ' }]));
  expect(items[0]!.diagnostic).toBe('invalid-url');
  delete items[0]!.diagnostic;
  expect(deduplicateImport(items, tree)).toEqual({ pending: [], diagnostics: [{ sourceOrdinal: 0, reason: 'invalid-url' }] });
});
