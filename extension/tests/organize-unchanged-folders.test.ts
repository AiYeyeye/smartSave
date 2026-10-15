import { expect, it } from 'vitest';
import { normalizeModelJson } from '../adapters/model-transport';
import { parseModelOutput, type ModelOutputContext } from '../schemas/model-output';

const context: ModelOutputContext = {
  task: 'organize',
  stage: 'folders',
  rootId: 'root',
  items: [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ],
  folders: [{ id: 'root' }, { id: 'a', ancestorIds: ['root'] }, { id: 'b', ancestorIds: ['root'] }],
};
const empty = { moves: [], newFolders: [], merges: [] };

it('accepts optional unchanged folder annotations without changing actions or the original reply', () => {
  const reply = {
    ...empty,
    newFolders: [{ id: 'new', parentId: 'root', title: 'Combined' }],
    merges: [{ sourceId: 'a', targetId: 'new' }],
    unchangedIds: ['b'],
  };
  const actions = { ...empty, newFolders: reply.newFolders, merges: reply.merges };
  const parsed = parseModelOutput(reply, context);
  expect(parsed).toEqual(actions);
  expect(reply.unchangedIds).toEqual(['b']);
  expect(parseModelOutput(parsed, context)).toEqual(actions);
});

it.each([undefined, [], ['a'], ['root', 'a', 'b']])('does not require exhaustive folder coverage: %j', unchangedIds => {
  expect(parseModelOutput({ ...empty, unchangedIds }, context)).toEqual(empty);
});

it('allows an unchanged existing destination to receive merged children', () => {
  expect(
    parseModelOutput({ ...empty, merges: [{ sourceId: 'a', targetId: 'b' }], unchangedIds: ['b'] }, context),
  ).toEqual({ ...empty, merges: [{ sourceId: 'a', targetId: 'b' }] });
});

it.each([
  [{ unchangedIds: ['outside'] }, 'unknown-folder'],
  [{ unchangedIds: ['a', 'a'] }, 'duplicate-id'],
  [{ newFolders: [{ id: 'new', parentId: 'root', title: 'New' }], unchangedIds: ['new'] }, 'unknown-folder'],
  [{ moves: [{ itemId: 'a', folderId: 'b' }], unchangedIds: ['a'] }, 'unchanged-folder-has-action'],
  [{ merges: [{ sourceId: 'a', targetId: 'b' }], unchangedIds: ['a'] }, 'unchanged-folder-has-action'],
  [{ renames: [{ folderId: 'a', title: 'Renamed' }], unchangedIds: ['a'] }, 'unchanged-folder-has-action'],
  [{ removeFolders: [{ folderId: 'a' }], unchangedIds: ['a'] }, 'unchanged-folder-has-action'],
])('rejects foreign, duplicate, new and contradictory unchanged folders: %j', (partial, code) => {
  expect(() => parseModelOutput({ ...empty, ...partial }, context)).toThrow(expect.objectContaining({ code }));
});

it('never accepts a bookmark ID as an unchanged folder', () => {
  expect(() =>
    parseModelOutput(
      { ...empty, unchangedIds: ['bookmark'] },
      {
        ...context,
        items: [...context.items, { id: 'bookmark', title: 'Bookmark', url: 'https://example.test' }],
      },
    ),
  ).toThrow(expect.objectContaining({ code: 'unknown-folder' }));
});

it('retains numeric ID normalization while validating against offered folders', () => {
  expect(
    parseModelOutput(normalizeModelJson({ ...empty, unchangedIds: [123] }, 'organize'), {
      ...context,
      folders: [{ id: '123' }],
    }),
  ).toEqual(empty);
});

it('still rejects invalid operations even alongside valid unchanged annotations', () => {
  expect(() =>
    parseModelOutput({ ...empty, merges: [{ sourceId: 'a', targetId: 'missing' }], unchangedIds: ['b'] }, context),
  ).toThrow(expect.objectContaining({ code: 'unknown-merge-target' }));
});
