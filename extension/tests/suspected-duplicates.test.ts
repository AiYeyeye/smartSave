import { expect, it } from 'vitest';
import { duplicateGroups, suspectedDuplicateKey } from '../domain/suspected-duplicates';
import { duplicateProposal, exactDuplicates } from '../domain/exact-duplicates';
import { organizeRequest } from '../domain/organize-proposal';
import { preflight } from '../domain/preflight';
import { organizerTree } from './fixtures/organizer-tree';

it.each([
  ['http://www.example.test/article/?utm_source=mail&utm_medium=email#part', 'https://example.test/article#part'],
  ['https://example.test/?id=3&utm_campaign=test&lang=zh', 'http://www.example.test?id=3&lang=zh'],
  ['https://example.test/a?%75tm_source=mail&id=3', 'https://example.test/a?id=3'],
  ['https://EXAMPLE.test/a?UTM_CAMPAIGN=x', 'https://example.test/a/'],
])('compares only the approved variants without changing either URL: %s', (a, b) => {
  expect(suspectedDuplicateKey(a)).toBeDefined();
  expect(suspectedDuplicateKey(a)).toBe(suspectedDuplicateKey(b));
});

it.each([
  ['https://example.test/a?id=1', 'https://example.test/a?id=2'],
  ['https://example.test/a#one', 'https://example.test/a#two'],
  ['https://example.test/a?ref=x', 'https://example.test/a'],
  ['https://example.test/a?gclid=x', 'https://example.test/a'],
  ['https://example.test/A', 'https://example.test/a'],
  ['https://example.test/a%2Fb', 'https://example.test/a/b'],
  ['https://example.test/a/../b', 'https://example.test/b'],
  ['https://example.test/a?x=1&y=2', 'https://example.test/a?y=2&x=1'],
  ['https://example.test/a?x=%20', 'https://example.test/a?x=+'],
  ['http://example.test:80/a', 'https://example.test:443/a'],
  ['https://example.test:443/a', 'https://example.test/a'],
  ['https://other.example.test/a', 'https://example.test/a'],
])('retains meaningful differences: %s', (a, b) => {
  expect(suspectedDuplicateKey(a)).toBeDefined();
  expect(suspectedDuplicateKey(a)).not.toBe(suspectedDuplicateKey(b));
});

it.each([
  'javascript:alert(1)',
  'file:///a',
  'https://user:pass@example.test/a',
  'https://example.test/a?%invalid=1',
  ' https://example.test/a',
  'https://example.test/a\u0000',
  'https://example.test\\a',
  'not a URL',
])('does not normalize unsupported, malformed or credential-bearing URL %s', url => {
  expect(suspectedDuplicateKey(url)).toBeUndefined();
});

it('keeps disjoint labeled groups, exact API behavior, original URLs and scope boundaries', () => {
  const tree = organizerTree();
  const a = tree.nodes.find(node => node.ref.nativeId === 'a')!;
  const b = tree.nodes.find(node => node.ref.nativeId === 'b')!;
  a.url = 'http://www.x.test/article/?utm_source=mail#same';
  b.url = 'https://x.test/article#same';
  tree.nodes.find(node => node.ref.nativeId === 'c')!.url = b.url;
  const copy = { ...structuredClone(a), ref: { ...a.ref, nativeId: 'copy' }, index: 2 };
  tree.nodes.push(copy);
  tree.nodes.find(node => node.ref.nativeId === 'left')!.childrenIds.push('copy');
  const before = structuredClone(tree);
  expect(exactDuplicates(tree, 'bar')[0]!.items.map(node => node.ref.nativeId)).toEqual(['a', 'copy']);
  const groups = duplicateGroups(tree, 'bar');
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({ suspected: true });
  expect(groups[0]!.items.map(node => node.ref.nativeId)).toEqual(['a', 'b', 'copy']);
  expect(tree).toEqual(before);
  expect(duplicateProposal(tree, 'bar', {}, true).actions).toEqual([]);
  expect(() => duplicateProposal(tree, 'bar', { b: 'delete' }, true)).toThrow('explicit-keep-required');
  expect(() => duplicateProposal(tree, 'bar', { a: 'keep', c: 'delete' }, true)).toThrow('unknown-duplicate');
  expect(() => duplicateProposal(tree, 'bar', { a: 'keep', b: 'delete' })).toThrow('unknown-duplicate');
  const proposal = duplicateProposal(tree, 'bar', { a: 'keep', b: 'delete' }, true);
  expect(proposal.actions).toHaveLength(1);
  expect(proposal.actions[0]?.reason).toContain('疑似重复');
  expect(preflight(organizeRequest(proposal, ['delete:b'], {}, 'lease'), tree).steps).toEqual([
    { type: 'remove', id: 'b' },
  ]);
  b.readOnly = true;
  expect(() => duplicateProposal(tree, 'bar', { a: 'keep', b: 'delete' }, true)).toThrow('protected-source');
});
