import { expect, it } from 'vitest';
import { organizerTree } from './fixtures/organizer-tree';
import { compileBookmarkRenames, type RenameRow } from '../domain/bookmark-rename';
import { serializeAiPayload } from '../domain/ai-payload';
import { parseModelOutput } from '../schemas/model-output';
import { modelSystemPrompt } from '../domain/model-prompts';
import { DEFAULT_CLASSIFICATION_POLICY } from '../domain/classification-policy';
import { normalizeModelJson } from '../adapters/model-transport';
import { withCorrectionLearning } from '../domain/correction-learning';
import { prepareMutation } from '../domain/prepare-mutation';

const tree = organizerTree();
const privacy = { fullUrl: false, bodyEnabled: false, excludedFolders: [] };
const row = (id = 'a', edit = 'Clear tool name'): RenameRow => ({
  itemId: id,
  title: 'Clear tool name',
  original: tree.nodes.find(node => node.ref.nativeId === id)!.title,
  editedTitle: edit,
  decision: 'rename',
  reason: 'Supported by metadata',
  selected: true,
});
it('uses the same evidence-based naming rules for saving and batch renaming', () => {
  const save = modelSystemPrompt('save', DEFAULT_CLASSIFICATION_POLICY);
  const rename = modelSystemPrompt('rename', DEFAULT_CLASSIFICATION_POLICY);
  const guidance = (prompt: string) => prompt.split('Naming quality:')[1]!.split(' personalPreferences')[0];
  expect(guidance(save)).toBe(guidance(rename));
  expect(guidance(rename)).toContain('Folder names are weak context');
  expect(guidance(rename)).toContain('version-specific pages');
  expect(guidance(rename)).toContain('Keep already clear names unchanged');
  expect(rename).toContain('for keep/uncertain copy the original title exactly');
  expect(save).toContain('Omit suggestedTitle for clear names or insufficient evidence');
});
it('renames only selected titles and learns only user edits relative to the AI suggestion', () => {
  const accepted = compileBookmarkRenames(tree, 'bar', [row()], 'lease');
  expect(accepted.learning).toBeUndefined();
  expect(accepted.command).toMatchObject({
    operations: [{ command: { type: 'update', changes: { title: 'Clear tool name' } } }],
  });
  const edited = compileBookmarkRenames(tree, 'bar', [row(), row('b', 'My wording')], 'lease');
  expect(edited.learning).toEqual([{ id: 'b', title: 'Clear tool name', parentId: 'left' }]);
  expect(() => compileBookmarkRenames(tree, 'left', [row('c')], 'lease')).toThrow();
  expect(() => compileBookmarkRenames(tree, 'bar', [row('a', ' ')], 'lease')).toThrow();
});
it('manual no-ops and reordering do not generate learning, while actual title/folder edits do', () => {
  const a = tree.nodes.find(node => node.ref.nativeId === 'a')!;
  const left = tree.nodes.find(node => node.ref.nativeId === 'left')!;
  const right = tree.nodes.find(node => node.ref.nativeId === 'right')!;
  const update = prepareMutation(tree, { type: 'update', target: a.ref, changes: { title: a.title } });
  expect(withCorrectionLearning(update).learning).toBeUndefined();
  const reorder = prepareMutation(tree, { type: 'move', target: a.ref, parent: left.ref, index: 1 });
  expect(withCorrectionLearning(reorder).learning).toBeUndefined();
  const move = prepareMutation(tree, { type: 'move', target: a.ref, parent: right.ref, index: 0 });
  expect(withCorrectionLearning(move).learning).toHaveLength(1);
  expect(withCorrectionLearning(move, [{ id: 'a', title: a.title, parentId: 'right' }]).learning).toBeUndefined();
});
it('rename payload applies privacy, requires exhaustive valid IDs and preserves reasons', () => {
  const payload = JSON.parse(serializeAiPayload(tree, privacy, { task: 'rename', itemIds: ['a', 'b'], folderIds: [] }));
  expect(payload.items[0].url).not.toContain('?');
  const output = {
    suggestions: ['a', 'b'].map(itemId => ({
      itemId,
      title: 'Readable name',
      decision: 'rename',
      reason: 'Known subject',
    })),
  };
  expect(parseModelOutput(normalizeModelJson(output, 'rename'), payload)).toEqual(output);
  expect(() => parseModelOutput({ suggestions: [output.suggestions[0]] }, payload)).toThrow();
  expect(() => parseModelOutput({ suggestions: [output.suggestions[0], output.suggestions[0]] }, payload)).toThrow();
  expect(() =>
    parseModelOutput({ suggestions: output.suggestions.map(item => ({ ...item, decision: 'keep' })) }, payload),
  ).toThrow();
  expect(() =>
    parseModelOutput({ suggestions: output.suggestions.map(item => ({ ...item, title: 'x'.repeat(201) })) }, payload),
  ).toThrow();
  expect(() => serializeAiPayload(tree, privacy, { task: 'rename', itemIds: ['left'], folderIds: [] })).toThrow();
  const excluded = { ...privacy, excludedFolders: [tree.nodes.find(node => node.ref.nativeId === 'left')!.ref] };
  expect(
    JSON.parse(serializeAiPayload(tree, excluded, { task: 'rename', itemIds: ['a'], folderIds: [] })).items,
  ).toEqual([]);
  expect(modelSystemPrompt('rename', DEFAULT_CLASSIFICATION_POLICY)).not.toContain(
    'rewriting existing titles is not allowed',
  );
});
it('keeps empty and long original names exactly when no supported rename is available', () => {
  for (const title of ['', '  original  ', 'x'.repeat(300)]) {
    const value = { suggestions: [{ itemId: 'a', title, decision: 'uncertain', reason: '' }] };
    expect(parseModelOutput(value, { task: 'rename', items: [{ id: 'a', title }], folders: [] })).toEqual(value);
  }
});
it('save suggestions are optional, bounded and kept separate from folder assignment', () => {
  const context = { task: 'save', items: [{ id: 'a', title: 'Homepage' }], folders: [{ id: 'left' }] };
  expect(
    parseModelOutput(
      { assignments: [{ itemId: 'a', folderId: 'left', suggestedTitle: 'Tool | Diagram editor' }], newFolders: [] },
      context,
    ),
  ).toMatchObject({ assignments: [{ suggestedTitle: 'Tool | Diagram editor' }] });
  expect(() =>
    parseModelOutput(
      { assignments: [{ itemId: 'a', folderId: 'left', suggestedTitle: 'x'.repeat(201) }], newFolders: [] },
      context,
    ),
  ).toThrow();
});
