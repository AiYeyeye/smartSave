import { expect, it } from 'vitest';
import { ModelOutputValidationError, parseModelOutput, type ModelOutputContext } from '../schemas/model-output';

const context: ModelOutputContext = {
  task: 'organize',
  stage: 'folders',
  rootId: 'root',
  policy: { maxNewDepth: 1, allowRename: true },
  items: [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ],
  folders: [{ id: 'root' }, { id: 'a', ancestorIds: ['root'] }, { id: 'b', ancestorIds: ['root'] }],
};
const empty = { moves: [], newFolders: [], merges: [] };

it('accepts a declared new merge destination', () => {
  const proposal = {
    ...empty,
    newFolders: [{ id: 'new', parentId: 'root', title: 'Combined' }],
    merges: [{ sourceId: 'a', targetId: 'new' }],
  };
  expect(parseModelOutput(proposal, context)).toEqual(proposal);
});

it('canonicalizes merge-source cleanup without mutating the reply or dropping independent removals', () => {
  const proposal = {
    ...empty,
    merges: [{ sourceId: 'a', targetId: 'root' }],
    removeFolders: [{ folderId: 'a', reason: 'Empty after merge' }, { folderId: 'b' }],
  };
  expect(parseModelOutput(proposal, context)).toEqual({ ...proposal, removeFolders: [{ folderId: 'b' }] });
  expect(proposal.removeFolders).toHaveLength(2);
});

it.each([
  [{ moves: [{ itemId: 'outside', folderId: 'root' }] }, 'unknown-item', 'moves.0.itemId'],
  [{ moves: [{ itemId: 'a', folderId: 'outside' }] }, 'unknown-target', 'moves.0.folderId'],
  [{ moves: [{ itemId: 'a', folderId: 'a' }] }, 'target-is-self-or-descendant', 'moves.0.folderId'],
  [{ newFolders: [{ id: 'a', title: 'A', parentId: 'root' }] }, 'existing-id', 'newFolders.0.id'],
  [{ newFolders: [{ id: 'new', title: 'A', parentId: 'outside' }] }, 'unknown-parent', 'newFolders.0.parentId'],
  [{ newFolders: [{ id: 'new', title: 'A', parentId: 'new' }] }, 'folder-parent-cycle', 'newFolders.0.parentId'],
  [{ newFolders: [{ id: 'new', title: 'A', parentId: 'a' }] }, 'max-new-depth', 'newFolders.0.parentId'],
  [{ unchangedIds: ['outside'] }, 'unknown-folder', 'unchangedIds.0'],
  [{ renames: [{ folderId: 'outside', title: 'A' }] }, 'unknown-folder', 'renames.0.folderId'],
  [{ removeFolders: [{ folderId: 'outside' }] }, 'unknown-folder', 'removeFolders.0.folderId'],
  [{ merges: [{ sourceId: 'outside', targetId: 'a' }] }, 'unknown-merge-source', 'merges.0.sourceId'],
  [{ merges: [{ sourceId: 'a', targetId: 'outside' }] }, 'unknown-merge-target', 'merges.0.targetId'],
  [{ merges: [{ sourceId: 'a', targetId: 'a' }] }, 'target-is-self-or-descendant', 'merges.0.targetId'],
  [
    {
      merges: [
        { sourceId: 'a', targetId: 'root' },
        { sourceId: 'a', targetId: 'b' },
      ],
    },
    'duplicate-id',
    'merges.sourceId',
  ],
  [
    { merges: [{ sourceId: 'a', targetId: 'root' }], removeFolders: [{ folderId: 'a' }, { folderId: 'a' }] },
    'duplicate-id',
    'removeFolders.folderId',
  ],
  [
    { merges: [{ sourceId: 'a', targetId: 'outside' }], removeFolders: [{ folderId: 'a' }] },
    'unknown-merge-target',
    'merges.0.targetId',
  ],
  [
    { newFolders: [{ id: 'new', parentId: 'a', title: 'Child' }], merges: [{ sourceId: 'a', targetId: 'new' }] },
    'max-new-depth',
    'newFolders.0.parentId',
  ],
  [
    { renames: [{ folderId: 'a', title: 'A' }], removeFolders: [{ folderId: 'a' }] },
    'rename-removed-folder',
    'renames.0.folderId',
  ],
  [
    { moves: [{ itemId: 'a', folderId: 'root' }], removeFolders: [{ folderId: 'a' }] },
    'move-removed-folder',
    'moves.0.itemId',
  ],
  [
    {
      moves: [
        { itemId: 'a', folderId: 'b' },
        { itemId: 'b', folderId: 'a' },
      ],
    },
    'action-cycle',
    'moves+merges+newFolders',
  ],
  [
    {
      moves: [
        { itemId: 'a', folderId: 'root' },
        { itemId: 'a', folderId: 'b' },
      ],
    },
    'duplicate-id',
    'moves.itemId',
  ],
  [{ moves: [{ itemId: 'a', folderId: 123 }] }, 'invalid_type', 'moves.0.folderId'],
])('preserves a safe diagnostic and the invalid-output error contract: %j', (partial, code, path) => {
  let error: unknown;
  try {
    parseModelOutput({ ...empty, ...partial }, context);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ModelOutputValidationError);
  expect(error).toMatchObject({ message: 'invalid-output', code, path });
});

it('distinguishes bookmark coverage, unknown unchanged ids and taxonomy edits', () => {
  const bookmarks = { ...context, stage: 'bookmarks' as const };
  for (const [partial, code, path] of [
    [{ unchangedIds: ['a'] }, 'missing-items', 'moves+unchangedIds'],
    [{ unchangedIds: ['a', 'outside'] }, 'unknown-item', 'unchangedIds'],
    [{ unchangedIds: ['a', 'a'] }, 'duplicate-id', 'moves+unchangedIds'],
    [{ renames: [{ folderId: 'a', title: 'New' }] }, 'taxonomy-change-in-bookmark-stage', 'renames'],
  ] as const) {
    try {
      parseModelOutput({ ...empty, ...partial }, bookmarks);
      expect.fail('must reject');
    } catch (error) {
      expect(error).toMatchObject({ message: 'invalid-output', code, path });
    }
  }
});

it('still accepts a valid folder proposal and exhaustive bookmark batch', () => {
  const proposal = {
    ...empty,
    moves: [{ itemId: 'a', folderId: 'new' }],
    newFolders: [{ id: 'new', parentId: 'root', title: 'New' }],
  };
  expect(parseModelOutput(proposal, context)).toEqual(proposal);
  const batch = { ...empty, moves: [{ itemId: 'a', folderId: 'root' }], unchangedIds: ['b'] };
  expect(parseModelOutput(batch, { ...context, stage: 'bookmarks' })).toEqual(batch);
});
