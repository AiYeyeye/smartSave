import { expect, it } from 'vitest';
import {
  organizeCompilation,
  organizeProposal,
  organizeRequest,
  reconcileOrganizeSelection,
} from '../domain/organize-proposal';
import { organizePaths, organizeReview, organizeRejectionKey } from '../domain/organize-review';
import { normalizeModelJson } from '../adapters/model-transport';
import { organizerTree } from './fixtures/organizer-tree';

const privacy = { fullUrl: true, bodyEnabled: false, excludedFolders: [] };
const empty = { moves: [], newFolders: [], merges: [] };
it('compiles merge into a new folder with redundant cleanup as one dependent operation, preserving bookmarks', () => {
  const tree = organizerTree();
  const proposal = organizeProposal(
    tree,
    'bar',
    {
      ...empty,
      newFolders: [{ id: 'combined', parentId: 'bar', title: 'Combined' }],
      merges: [{ sourceId: 'left', targetId: 'combined' }],
      removeFolders: [{ folderId: 'left', reason: 'Empty after merge' }],
    },
    privacy,
  );
  expect(proposal.actions.map(a => a.id)).toEqual(['create:combined', 'merge:left']);
  const selected = proposal.actions.map(a => a.id);
  const { plan, request } = organizeCompilation(proposal, selected, {}, 'lease');
  expect(plan.simulated.nodes.find(n => n.ref.nativeId === 'left')).toBeUndefined();
  for (const id of ['a', 'b']) {
    const before = tree.nodes.find(n => n.ref.nativeId === id)!;
    expect(plan.simulated.nodes.find(n => n.ref.nativeId === id)).toMatchObject({
      title: before.title,
      url: before.url,
      parentId: '$batch:create:combined:$created',
    });
  }
  expect(request.command).toMatchObject({
    operations: [
      { id: 'create:combined' },
      { id: 'merge:left:child:a', dependsOn: ['create:combined'] },
      { id: 'merge:left:child:b', dependsOn: ['create:combined'] },
      { id: 'merge:left', command: { type: 'remove' } },
    ],
  });
  expect(reconcileOrganizeSelection(proposal, ['merge:left'], {})).toEqual([]);
  const deselected = organizeCompilation(proposal, ['create:combined'], {}, 'lease').plan.simulated;
  expect(deselected.nodes.find(n => n.ref.nativeId === 'left')?.childrenIds).toEqual(['a', 'b']);
});

it('still rejects merging into a newly declared descendant of the source', () => {
  expect(() =>
    organizeProposal(
      organizerTree(),
      'bar',
      {
        ...empty,
        newFolders: [{ id: 'child', parentId: 'left', title: 'Child' }],
        merges: [{ sourceId: 'left', targetId: 'child' }],
        removeFolders: [{ folderId: 'left' }],
      },
      privacy,
    ),
  ).toThrow('invalid-output');
});
const split = {
  moves: [
    { itemId: 'a', folderId: 'writing', reason: '集中写作内容' },
    { itemId: 'b', folderId: 'drawing', reason: '分开绘图内容' },
  ],
  newFolders: [
    { id: 'writing', parentId: 'bar', title: '写作', reason: '形成可复用的用途分类' },
    { id: 'drawing', parentId: 'bar', title: '画图' },
  ],
  merges: [],
  renames: [{ folderId: 'right', title: '参考资料', reason: '统一名称' }],
};
it('projects a complete split/rename/cleanup using the exact execution planner with all bookmarks retained', () => {
  const tree = organizerTree();
  const proposal = organizeProposal(tree, 'bar', split, privacy, { cleanupEmpty: true });
  const selected = proposal.actions.map(a => a.id);
  const { plan, request } = organizeCompilation(proposal, selected, {}, 'lease');
  const preview = organizeReview(proposal, selected, {});
  expect(preview.tree).toEqual(plan.simulated);
  const after = plan.simulated;
  expect(after.nodes.find(n => n.ref.nativeId === 'left')).toBeUndefined();
  expect(after.nodes.find(n => n.ref.nativeId === 'right')?.title).toBe('参考资料');
  expect(organizePaths(after).get('a')).toContain('写作');
  expect(organizePaths(after).get('b')).toContain('画图');
  expect(
    after.nodes
      .filter(n => n.ref.kind === 'bookmark')
      .map(n => n.ref.nativeId)
      .sort(),
  ).toEqual(['a', 'b', 'c']);
  expect(after.nodes.find(n => n.ref.nativeId === 'outside')).toEqual(
    tree.nodes.find(n => n.ref.nativeId === 'outside'),
  );
  expect(proposal.actions.find(a => a.id === 'delete:left')?.dependsOn).toEqual(['move:a', 'move:b']);
  expect(JSON.stringify(request)).not.toContain('deleteSubtree');
  expect(tree.nodes.find(n => n.ref.nativeId === 'left')?.childrenIds).toEqual(['a', 'b']);
});
it('cascades cleanup and new-folder dependencies when unchecked and removes cleanup after retargeting back', () => {
  const p = organizeProposal(organizerTree(), 'bar', split, privacy, { cleanupEmpty: true });
  const all = p.actions.map(a => a.id);
  const selected = reconcileOrganizeSelection(
    p,
    all.filter(id => id !== 'create:writing'),
    {},
  );
  expect(selected).not.toContain('move:a');
  expect(selected).not.toContain('delete:left');
  expect(organizeReview(p, selected, {}).tree?.nodes.find(n => n.ref.nativeId === 'left')?.childrenIds).toEqual(['a']);
  const targets = { 'move:a': 'left' };
  const changed = reconcileOrganizeSelection(p, all, targets);
  expect(changed).not.toContain('delete:left');
  expect(organizeReview(p, changed, targets).error).toBeUndefined();
  expect(() => organizeRequest(p, all, targets, 'lease')).toThrow();
});
it('removes nested empty folders deepest first and never removes protected, excluded or structural roots', () => {
  const tree = organizerTree();
  const right = tree.nodes.find(n => n.ref.nativeId === 'right')!;
  tree.nodes.push({ ...right, ref: { ...right.ref, nativeId: 'empty-child' }, parentId: 'right' });
  right.childrenIds = ['empty-child'];
  const p = organizeProposal(tree, 'bar', empty, privacy, { cleanupEmpty: true });
  expect(p.actions.map(a => a.id)).toEqual(['delete:empty-child', 'delete:right']);
  expect(p.actions[1]?.dependsOn).toEqual(['delete:empty-child']);
  expect(
    organizeCompilation(
      p,
      p.actions.map(a => a.id),
      {},
      'lease',
    ).plan.steps.map(s => s.type),
  ).toEqual(['remove', 'remove']);
  expect(
    organizeProposal(tree, 'bar', empty, privacy, { cleanupEmpty: true, protectedFolderIds: ['right'] }).actions,
  ).toEqual([]);
  expect(
    organizeProposal(tree, 'bar', empty, { ...privacy, excludedFolders: [right.ref] }, { cleanupEmpty: true }).actions,
  ).toEqual([]);
  expect(() => organizeProposal(tree, 'bar', { ...empty, removeFolders: [{ folderId: 'bar' }] }, privacy)).toThrow();
});
it('rejects nonempty removals, excluded descendants, overlapping merges and changes to a protected folder path', () => {
  const tree = organizerTree();
  expect(() => organizeProposal(tree, 'bar', { ...empty, removeFolders: [{ folderId: 'left' }] }, privacy)).toThrow(
    'unsafe-folder-removal',
  );
  expect(() =>
    organizeProposal(
      tree,
      'bar',
      { ...empty, moves: [{ itemId: 'a', folderId: 'right' }], merges: [{ sourceId: 'left', targetId: 'right' }] },
      privacy,
    ),
  ).toThrow('overlapping-merge');
  const a = tree.nodes.find(n => n.ref.nativeId === 'a')!;
  tree.nodes.push({
    ...tree.nodes.find(n => n.ref.nativeId === 'right')!,
    ref: { ...a.ref, kind: 'folder', nativeId: 'protected' },
    parentId: 'left',
    childrenIds: [],
  });
  tree.nodes.find(n => n.ref.nativeId === 'left')!.childrenIds.push('protected');
  expect(() =>
    organizeProposal(tree, 'bar', { ...empty, renames: [{ folderId: 'left', title: 'changed' }] }, privacy, {
      protectedFolderIds: ['protected'],
    }),
  ).toThrow('protected-folder');
});
it('keeps explicit opt-outs and rejects invalid target edits without a false after tree', () => {
  const tree = organizerTree();
  const p = organizeProposal(
    tree,
    'bar',
    { ...empty, renames: [{ folderId: 'left', title: 'New' }], removeFolders: [{ folderId: 'right' }] },
    privacy,
    { allowRename: false, cleanupEmpty: false },
  );
  expect(p.actions).toEqual([]);
  const q = organizeProposal(tree, 'bar', split, privacy);
  const preview = organizeReview(
    q,
    q.actions.map(a => a.id),
    { 'move:a': 'outside' },
  );
  expect(preview.tree).toBeUndefined();
  expect(preview.error).toContain('冲突');
});
it('retains action reasons through transport normalization and remembers temporary destinations by path', () => {
  const tree = organizerTree();
  const normalized = normalizeModelJson({ ...split, reason: 'top-level commentary' }, 'organize');
  const p = organizeProposal(tree, 'bar', normalized, privacy);
  expect(p.actions.find(a => a.id === 'move:a')?.reason).toBe('集中写作内容');
  const q = organizeProposal(
    tree,
    'bar',
    {
      ...split,
      moves: split.moves.map(m => ({ ...m, folderId: m.folderId === 'writing' ? 'new-id' : m.folderId })),
      newFolders: split.newFolders.map(f => ({ ...f, id: f.id === 'writing' ? 'new-id' : f.id })),
    },
    privacy,
  );
  expect(
    organizeRejectionKey(
      p,
      p.actions.find(a => a.id === 'move:a')!,
      {},
    ),
  ).toBe(
    organizeRejectionKey(
      q,
      q.actions.find(a => a.id === 'move:a')!,
      {},
    ),
  );
});
