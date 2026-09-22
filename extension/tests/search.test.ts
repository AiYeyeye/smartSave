import { describe, expect, it } from 'vitest';
import { SearchIndex } from '../domain/search-index';
import { searchCandidates, applySearchOrder } from '../domain/search-rerank';
import { searchTree } from './fixtures/search-tree';
describe('SearchIndex', () => {
  it.each(['重庆', 'chongqing', 'cqdx', 'example.com', '/guide/0', '学习资料', 'xuexiziliao', 'chongqng'])(
    'matches cached local fields: %s',
    query => {
      expect(new SearchIndex(searchTree()).query(query).map(hit => hit.id)).toContain('1');
    },
  );
  it('requires every token, ranks title first, has empty state and rebuilds deletions', () => {
    const tree = searchTree();
    const index = new SearchIndex(tree);
    expect(index.query('bookmark example')[0]?.id).toBe('2');
    expect(index.query('bookmark nonexistent')).toEqual([]);
    expect(index.query('  ')).toEqual([]);
    tree.nodes = tree.nodes.filter(n => n.ref.nativeId !== '1');
    expect(new SearchIndex(tree).query('重庆')).toEqual([]);
  });
  it('bounds fuzzy edits but retains long exact strings', () => {
    const tree = searchTree();
    tree.nodes[1]!.title = 'a'.repeat(100);
    const index = new SearchIndex(tree);
    expect(index.query('a'.repeat(100))).toHaveLength(1);
    expect(index.query('a'.repeat(99) + 'b')).toEqual([]);
    expect(index.query('bo')).toHaveLength(2);
    expect(index.query('bk')).toEqual([]);
  });
});
describe('search rerank projection', () => {
  it('caps only model candidates, excludes ancestry without hiding local hits', () => {
    const tree = searchTree(12);
    const hits = new SearchIndex(tree).query('example');
    expect(hits).toHaveLength(12);
    expect(searchCandidates(tree, { fullUrl: false, bodyEnabled: false, excludedFolders: [] }, hits)).toHaveLength(8);
    expect(
      searchCandidates(tree, { fullUrl: true, bodyEnabled: false, excludedFolders: [tree.nodes[0]!.ref] }, hits),
    ).toEqual([]);
  });
  it('rejects unknown/duplicate IDs and retains unranked local results', () => {
    const hits = new SearchIndex(searchTree()).query('example');
    expect(() => applySearchOrder(hits, ['1'], ['2'])).toThrow();
    expect(() => applySearchOrder(hits, ['1'], ['1', '1'])).toThrow();
    expect(applySearchOrder(hits, ['1', '2'], ['2']).map(h => h.id)).toEqual(['2', '1', '3']);
  });
});
