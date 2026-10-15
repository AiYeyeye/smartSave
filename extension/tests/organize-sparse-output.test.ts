import { expect, it } from 'vitest';
import { parseModelOutput, type ModelOutputContext } from '../schemas/model-output';

const context: ModelOutputContext = {
  task: 'organize',
  stage: 'bookmarks',
  omittedItemsUnchanged: true,
  items: [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
    { id: 'c', title: 'C' },
  ],
  folders: [
    { id: 'root', ancestorIds: [] },
    { id: 'target', ancestorIds: ['root'] },
  ],
  rootId: 'root',
};
const empty = { moves: [], newFolders: [], merges: [] };
it('fills only implicitly unchanged input IDs after validating all explicit actions, without mutating the reply', () => {
  const reply = { ...empty, moves: [{ itemId: 'a', folderId: 'target' }], unchangedIds: ['b'] };
  const output = parseModelOutput(reply, context);
  expect(output).toEqual({ ...reply, unchangedIds: ['b', 'c'] });
  expect(reply.unchangedIds).toEqual(['b']);
  expect(parseModelOutput(output, context)).toEqual(output);
  expect(parseModelOutput(empty, context)).toMatchObject({ unchangedIds: ['a', 'b', 'c'] });
});
it('keeps strict exhaustive coverage unless the trusted bookmark-stage input explicitly opts in', () => {
  expect(() => parseModelOutput(empty, { ...context, omittedItemsUnchanged: undefined })).toThrow('invalid-output');
  expect(() => parseModelOutput(empty, { ...context, omittedItemsUnchanged: false })).toThrow('invalid-output');
});
it.each([
  { ...empty, moves: [{ itemId: 'foreign', folderId: 'target' }] },
  { ...empty, moves: [{ itemId: 'a', folderId: 'missing' }] },
  { ...empty, moves: [{ itemId: 'a', folderId: 'target' }], unchangedIds: ['a'] },
  { ...empty, unchangedIds: ['foreign'] },
  { ...empty, unchangedIds: ['b', 'b'] },
  { ...empty, newFolders: [{ id: 'new', parentId: 'root', title: 'Forbidden in bookmark stage' }] },
  { ...empty, renames: [{ folderId: 'target', title: 'Forbidden' }] },
])('does not silently repair invalid identities, conflicts or forbidden folder actions: %j', reply => {
  expect(() => parseModelOutput(reply, context)).toThrow('invalid-output');
});
