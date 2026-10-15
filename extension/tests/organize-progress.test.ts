import { expect, it } from 'vitest';
import { organizeProgressPreview } from '../domain/organize-progress';
import { organizeCandidates } from '../domain/organize-proposal';
import { serializeAiPayload } from '../domain/ai-payload';
import { organizePreference } from '../domain/organize-preferences';
import { organizerTree } from './fixtures/organizer-tree';
const tree = organizerTree();
const privacy = { fullUrl: false, bodyEnabled: false, excludedFolders: [] };
const candidates = organizeCandidates(tree, 'bar', privacy);
it('previews complete known actions inside incomplete JSON without accepting unknown IDs or incomplete strings', () => {
  const text =
    '{"moves":[{"itemId":"a","folderId":"right"},{"itemId":"unknown","folderId":"right"},{"itemId":"b","folderId":"rig';
  expect(organizeProgressPreview(text, candidates)).toEqual([expect.stringContaining('移动：a →')]);
  expect(organizeProgressPreview('<think>' + text, candidates)).toEqual([]);
});
it('projects excluded candidates before producing display labels and limits preview rows', () => {
  const excluded = { ...privacy, excludedFolders: [tree.nodes.find(n => n.ref.nativeId === 'left')!.ref] };
  const text = JSON.stringify({ moves: Array.from({ length: 20 }, () => ({ itemId: 'a', folderId: 'right' })) });
  expect(organizeProgressPreview(text, organizeCandidates(tree, 'bar', excluded))).toEqual([]);
  expect(organizeProgressPreview(text, candidates)).toHaveLength(6);
});
it('serializes per-request preferences with private URLs stripped and validates custom input', () => {
  const request = {
    task: 'organize' as const,
    rootId: 'bar',
    itemIds: candidates.items.map(i => i.id),
    folderIds: candidates.folders.map(f => f.id),
    preference: { style: 'custom' as const, instructions: '  分成写作、画图、编程  ' },
  };
  const payload = JSON.parse(serializeAiPayload(tree, privacy, request));
  expect(payload.preference).toEqual({ style: 'custom', instructions: '分成写作、画图、编程' });
  expect(() => organizePreference({ style: 'custom', instructions: ' ' })).toThrow('missing-organize-instructions');
  expect(() => organizePreference({ style: 'topic', instructions: 'x'.repeat(1001) })).toThrow(
    'invalid-organize-preference',
  );
});
