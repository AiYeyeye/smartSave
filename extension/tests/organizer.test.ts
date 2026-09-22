import { expect, it } from 'vitest';
import { organizeProposal, organizeRequest, scopeNodes } from '../domain/organize-proposal';
import { exactDuplicates, duplicateProposal } from '../domain/exact-duplicates';
import { preflight } from '../domain/preflight';
import { organizerTree } from './fixtures/organizer-tree';
const noExclusions = { fullUrl: true, bodyEnabled: false, excludedFolders: [] };
it('accepts writable structural scope and expands merge to dependent moves and empty remove only', () => {
  const tree = organizerTree();
  const p = organizeProposal(
    tree,
    'bar',
    { moves: [], newFolders: [], merges: [{ sourceId: 'left', targetId: 'right' }] },
    noExclusions,
  );
  const request = organizeRequest(p, ['merge:left'], {}, 'lease');
  const plan = preflight(request, tree);
  expect(plan.steps.map(s => s.type)).toEqual(['move', 'move', 'remove']);
  expect(JSON.stringify(request)).not.toContain('deleteSubtree');
  expect(scopeNodes(tree, 'bar').map(n => n.ref.nativeId)).not.toContain('c');
});
it('rejects outside references and unsafe adjusted targets before any submission', () => {
  const tree = organizerTree();
  expect(() =>
    organizeProposal(
      tree,
      'bar',
      { moves: [{ itemId: 'a', folderId: 'outside' }], newFolders: [], merges: [] },
      noExclusions,
    ),
  ).toThrow();
  const p = organizeProposal(
    tree,
    'bar',
    { moves: [{ itemId: 'a', folderId: 'right' }], newFolders: [], merges: [] },
    noExclusions,
  );
  expect(() => organizeRequest(p, ['move:a'], { 'move:a': 'outside' }, 'lease')).toThrow();
});
it('unchecked actions stay absent, and new folder dependencies require explicit selection', () => {
  const tree = organizerTree();
  const p = organizeProposal(
    tree,
    'bar',
    {
      moves: [{ itemId: 'a', folderId: 'new' }],
      newFolders: [{ id: 'new', parentId: 'bar', title: 'New' }],
      merges: [],
    },
    noExclusions,
  );
  expect(() => organizeRequest(p, ['move:a'], {}, 'lease')).toThrow();
  const r = organizeRequest(p, ['create:new', 'move:a'], {}, 'lease');
  expect(preflight(r, tree).steps.map(s => s.type)).toEqual(['create', 'move']);
  expect(preflight(organizeRequest(p, ['create:new'], {}, 'lease'), tree).steps.map(s => s.type)).toEqual(['create']);
});
it('groups only raw exact URLs inside scope and requires explicit keep and delete', () => {
  const tree = organizerTree();
  const groups = exactDuplicates(tree, 'bar');
  expect(groups[0]?.items.map(n => n.ref.nativeId)).toEqual(['a', 'b']);
  expect(duplicateProposal(tree, 'bar', {}).actions).toEqual([]);
  expect(() => duplicateProposal(tree, 'bar', { a: 'delete', b: 'delete' })).toThrow();
  const p = duplicateProposal(tree, 'bar', { a: 'keep', b: 'delete' });
  expect(preflight(organizeRequest(p, ['delete:b'], {}, 'lease'), tree).steps).toEqual([{ type: 'remove', id: 'b' }]);
  tree.nodes.find(n => n.ref.nativeId === 'b')!.url = 'https://x.test/?other#b';
  expect(exactDuplicates(tree, 'bar')).toEqual([]);
});
it('rejects merge or folder move that would carry privacy-excluded descendants', () => {
  const tree = organizerTree();
  const privacy = {
    fullUrl: true,
    bodyEnabled: false,
    excludedFolders: [tree.nodes.find(n => n.ref.nativeId === 'a')!.ref],
  };
  expect(() =>
    organizeProposal(
      tree,
      'bar',
      { moves: [], newFolders: [], merges: [{ sourceId: 'left', targetId: 'right' }] },
      privacy,
    ),
  ).toThrow();
});
it('compiles a sizable merge with all children retained in its dependency closure', () => {
  const tree = organizerTree();
  const left = tree.nodes.find(n => n.ref.nativeId === 'left')!;
  const sample = tree.nodes.find(n => n.ref.nativeId === 'a')!;
  for (let i = 0; i < 300; i++) {
    const id = `large-${i}`;
    left.childrenIds.push(id);
    tree.nodes.push({ ...sample, index: i + 2, ref: { ...sample.ref, nativeId: id }, url: `https://large.test/${i}` });
  }
  const p = organizeProposal(
    tree,
    'bar',
    { moves: [], newFolders: [], merges: [{ sourceId: 'left', targetId: 'right' }] },
    noExclusions,
  );
  const r = organizeRequest(p, ['merge:left'], {}, 'lease');
  expect(r.command.type === 'batch' && r.command.operations.length).toBe(303);
});
