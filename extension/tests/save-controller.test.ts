import { expect, it } from 'vitest';
import { applySaveSuggestion, beginSave, prepareSave, selectSaveDuplicate } from '../panel/save-controller';
import type { TreeSnapshot } from '../domain/node-reference';
const tree: TreeSnapshot = {
  installationId: 'i',
  epoch: 'e',
  observedRevision: 0,
  roots: ['root'],
  nodes: [
    {
      ref: { installationId: 'i', nativeId: 'root', kind: 'folder' },
      title: '',
      index: 0,
      childrenIds: ['f', 'g'],
      readOnly: true,
      childrenWritable: false,
      observedRevision: 0,
    },
    ...['f', 'g'].map((id, index) => ({
      ref: { installationId: 'i', nativeId: id, kind: 'folder' as const },
      parentId: 'root',
      title: id,
      index,
      childrenIds: id === 'f' ? ['b'] : [],
      readOnly: false,
      childrenWritable: true,
      observedRevision: 0,
    })),
    {
      ref: { installationId: 'i', nativeId: 'b', kind: 'bookmark' },
      parentId: 'f',
      title: 'old',
      url: 'https://example.test/',
      index: 0,
      childrenIds: [],
      readOnly: false,
      observedRevision: 0,
    },
  ],
};
it('requires explicit duplicate selection and edits/moves original through one durable batch', () => {
  let draft = beginSave(tree, { title: 'page', url: 'https://example.test/' }, []);
  draft.parentId = 'g';
  expect(() => prepareSave(draft, tree)).toThrow('select-existing');
  draft = selectSaveDuplicate(draft, 'b');
  draft.parentId = 'g';
  draft.title = 'edited';
  expect(prepareSave(draft, tree).command).toMatchObject({
    type: 'batch',
    operations: [
      { id: 'edit', command: { type: 'update', target: { nativeId: 'b' }, changes: { title: 'edited' } } },
      { id: 'move', command: { type: 'move', target: { nativeId: 'b' }, parent: { nativeId: 'g' } } },
    ],
  });
});
it('never overwrites a user-edited directory with late AI and uses the existing composite writer', () => {
  const draft = beginSave(tree, { title: 'page', url: 'https://new.test/' }, []);
  expect(draft.rememberRule).toBe(false);
  expect(draft.includeSubdomains).toBe(false);
  expect(applySaveSuggestion({ ...draft, parentId: 'g', directoryEdited: true }, { parentId: 'f' }).parentId).toBe('g');
  const suggested = applySaveSuggestion(draft, { parentId: 'f', folderTitle: 'Visible proposal' });
  expect(prepareSave(suggested, tree).command).toMatchObject({
    type: 'createFolderAndBookmark',
    folderTitle: 'Visible proposal',
    title: 'page',
  });
  expect(() => prepareSave(suggested, { ...tree, observedRevision: 1 })).toThrow();
});
it('late rules hydrate destination only, retaining edited title and explicit rule consent', async () => {
  const { hydrateSaveRules } = await import('../panel/save-controller');
  const draft = {
    ...beginSave(tree, { title: 'page', url: 'https://new.test/' }, []),
    title: 'hand edited',
    rememberRule: true,
    includeSubdomains: true,
  };
  const hydrated = hydrateSaveRules(draft, [
    { host: 'new.test', includeSubdomains: false, folder: tree.nodes[1]!.ref },
  ]);
  expect(hydrated).toMatchObject({ title: 'hand edited', rememberRule: true, includeSubdomains: true, parentId: 'f' });
});
it('nested folder proposals become a dependency chain through the existing batch planner', () => {
  const draft = {
    ...beginSave(tree, { title: 'new', url: 'https://new.test/' }, []),
    parentId: 'f',
    newFolder: true,
    proposedPath: ['One', 'Two'],
    folderTitle: 'One',
  };
  const request = prepareSave(draft, tree);
  expect(request.command).toMatchObject({ type: 'batch', selectedOperationIds: ['folder-0', 'folder-1', 'bookmark'] });
});
it('only completed durable native folder receipt authorizes a rule target', async () => {
  const { completedSaveFolder } = await import('../panel/save-receipt');
  const result = {
    requestId: 'r',
    status: 'completed' as const,
    completedSteps: 2,
    remainingSteps: 0,
    needsReconcile: false,
    evidence: [{ stepIndex: 0, state: 'checkpointed' as const, nativeId: 'returned', currentMatchesReceipt: true }],
  };
  expect(completedSaveFolder(result, 'r', 'i', 0).nativeId).toBe('returned');
  expect(() => completedSaveFolder({ ...result, status: 'partial' }, 'r', 'i', 0)).toThrow();
  expect(() => completedSaveFolder({ ...result, status: 'unknown' }, 'r', 'i', 0)).toThrow();
  expect(() => completedSaveFolder({ ...result, evidence: [] }, 'r', 'i', 0)).toThrow();
  expect(() => completedSaveFolder(result, 'different', 'i', 0)).toThrow();
});
it('rejects cyclic, dangling and colliding proposal folders; selects only necessary ancestor chain', async () => {
  const { saveSuggestionPath } = await import('../panel/save-controller');
  const draft = beginSave(tree, { title: 'new', url: 'https://new.test/' }, []);
  expect(() => saveSuggestionPath(draft, 'a', [{ id: 'a', parentId: 'a', title: 'Cycle' }])).toThrow();
  expect(() => saveSuggestionPath(draft, 'a', [{ id: 'a', parentId: 'missing', title: 'Dangling' }])).toThrow();
  expect(() => saveSuggestionPath(draft, 'f', [{ id: 'f', parentId: 'g', title: 'Collision' }])).toThrow();
  const suggestion = saveSuggestionPath(draft, 'a', [
    { id: 'a', parentId: 'f', title: 'Selected' },
    { id: 'unused', parentId: 'g', title: 'Unselected' },
  ]);
  expect(suggestion.proposedPath).toEqual(['Selected']);
});
it('uses typed origin rather than translated presentation text for rule hydration and invalidation', async () => {
  const { invalidateSaveSuggestion } = await import('../panel/save-controller');
  const draft = beginSave(tree, { title: 'new', url: 'https://new.test/' }, []);
  const ai = { ...applySaveSuggestion(draft, { parentId: 'f' }), source: 'Translated suggestion' };
  expect(invalidateSaveSuggestion(ai).aiInvalidated).toBe(true);
  expect(invalidateSaveSuggestion({ ...draft, source: 'AI manual label' }).aiInvalidated).not.toBe(true);
  const { hydrateSaveRules } = await import('../panel/save-controller');
  expect(hydrateSaveRules(ai, []).parentId).toBe('f');
});
