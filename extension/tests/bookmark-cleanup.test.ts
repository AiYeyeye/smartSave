import { expect, it } from 'vitest';
import { exactDuplicateCleanup, unreachableSiteCleanup } from '../domain/bookmark-cleanup';
import { checkScopeNodes, compileCheckDeletion, type LinkResult } from '../domain/bookmark-check';
import { preflight } from '../domain/preflight';
import { organizerTree } from './fixtures/organizer-tree';

it('keeps original URLs distinct, including exact copies inside a suspected group', () => {
  const tree = organizerTree();
  tree.nodes.find(n => n.ref.nativeId === 'c')!.url = 'http://www.x.test/?a#b';
  const before = structuredClone(tree);
  expect(exactDuplicateCleanup(checkScopeNodes(tree, null))).toEqual({ deleteIds: ['b'], keepIds: ['a'], total: 1 });
  expect(tree).toEqual(before);
  expect(exactDuplicateCleanup(checkScopeNodes(tree, 'outside')).total).toBe(0);
});

it('prefers protected keepers, never removes protected copies, and caps a batch at 500', () => {
  const nodes = checkScopeNodes(organizerTree(), null);
  nodes[1]!.readOnly = true;
  expect(exactDuplicateCleanup(nodes)).toEqual({ deleteIds: ['a', 'c'], keepIds: ['b'], total: 2 });
  nodes.forEach(n => (n.readOnly = true));
  expect(exactDuplicateCleanup(nodes).total).toBe(0);
  const many = Array.from({ length: 603 }, (_, index) => ({
    ...nodes[0]!,
    readOnly: false,
    ref: { ...nodes[0]!.ref, nativeId: String(index) },
  }));
  const plan = exactDuplicateCleanup(many);
  expect(plan.total).toBe(602);
  expect(plan.keepIds).toEqual(['0']);
  expect(plan.deleteIds).toHaveLength(500);
  expect(new Set(plan.deleteIds).size).toBe(500);
  expect(plan.deleteIds).not.toContain('0');
});

it('rejects the frozen batch if the keeper changes or disappears', () => {
  const tree = organizerTree();
  const plan = exactDuplicateCleanup(checkScopeNodes(tree, null));
  const request = compileCheckDeletion(tree, null, plan.deleteIds);
  expect(preflight(request, tree).steps).toHaveLength(2);
  tree.nodes.find(n => n.ref.nativeId === 'a')!.url = 'https://edited.test/';
  expect(() => preflight(request, tree)).toThrow();
  tree.nodes = tree.nodes.filter(n => n.ref.nativeId !== 'a');
  expect(() => preflight(request, tree)).toThrow();
});

it('only proposes unreachable sites, excluding page failures, unknowns and protected bookmarks', () => {
  const base = checkScopeNodes(organizerTree(), null)[0]!;
  const values: LinkResult[] = [
    { status: 'review', reason: 'network', at: 1, site: { status: 'unreachable', reason: 'network', at: 1 } },
    { status: 'broken', reason: 'http', code: 404, at: 1 },
    { status: 'review', reason: 'http', code: 403, at: 1 },
    { status: 'review', reason: 'timeout', at: 1 },
    { status: 'ok', reason: 'manual', at: 1 },
  ];
  const nodes = values.map((_, index) => ({ ...base, ref: { ...base.ref, nativeId: String(index) } }));
  const checked = new Map(values.map((value, index) => [String(index), value]));
  expect(unreachableSiteCleanup(nodes, checked)).toEqual({ deleteIds: ['0'], keepIds: [], total: 1 });
  nodes[0]!.readOnly = true;
  expect(unreachableSiteCleanup(nodes, checked).total).toBe(0);
});
