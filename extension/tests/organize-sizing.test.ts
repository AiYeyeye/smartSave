import { expect, it } from 'vitest';
import { compactAiPayload, serializeAiPayload, serializedItemRequestSize, type AiRequest } from '../domain/ai-payload';
import { modelRequestBody } from '../adapters/model-transport';
import { partitionOrganizeItems } from '../domain/organize-batches';
import { organizerTree } from './fixtures/organizer-tree';

it.each(['openai-compatible', 'openai-responses', 'anthropic', 'google-generative-ai', 'ollama', 'lm-studio'] as const)(
  'matches actual %s envelope bytes, including escaping and exact boundaries',
  adapter => {
    const tree = organizerTree();
    tree.nodes.find(n => n.ref.nativeId === 'a')!.title = '中文 😀 "quotes" \\ slash\nnewline\t\ud800';
    const privacy = { fullUrl: false, bodyEnabled: false, excludedFolders: [] };
    const config = { adapter, baseUrl: 'https://example.test/v1', model: 'm', timeoutMs: 1000 };
    const base: AiRequest = {
      task: 'organize',
      stage: 'bookmarks',
      rootId: 'bar',
      folderIds: ['bar', 'left', 'right'],
      itemIds: [],
      destinations: tree.nodes
        .filter(n => ['bar', 'left', 'right'].includes(n.ref.nativeId))
        .map(n => ({ id: n.ref.nativeId, title: n.title, parentId: n.parentId })),
    };
    const measure = (ids: string[]) =>
      new TextEncoder().encode(
        modelRequestBody(config, 'organize', serializeAiPayload(tree, privacy, { ...base, itemIds: ids })),
      ).byteLength;
    const sizes = serializedItemRequestSize(
      serializeAiPayload(tree, privacy, { ...base, itemIds: ['a', 'b'] }),
      measure([]),
    );
    for (const ids of [[], ['a'], ['b'], ['a', 'b'], ['b', 'a']]) {
      const sum =
        sizes.sharedBytes + ids.reduce((total, id) => total + sizes.itemBytes(id), 0) + Math.max(0, ids.length - 1);
      expect(sum).toBe(measure(ids));
      expect(partitionOrganizeItems(ids, sizes, 1)).toEqual(partitionOrganizeItems(ids, measure, 1));
    }
    expect(partitionOrganizeItems(['a'], sizes, 100, measure(['a']))).toEqual([['a']]);
    expect(() => partitionOrganizeItems(['a'], sizes, 100, measure(['a']) - 1)).toThrow('bookmark-context-too-large');
    expect(() => partitionOrganizeItems(['a'], sizes, 100, measure([]) - 1)).toThrow('folder-context-too-large');
    expect(() => partitionOrganizeItems(['missing'], sizes)).toThrow('invalid-reference');
  },
);

it('keeps the complete canonical catalog while putting a stable, quoted tree before variable items on the wire', () => {
  const catalog = [
    { id: 'parent', ancestorIds: [], path: ['名称\n注入'] },
    { id: 'child', ancestorIds: ['parent'], path: ['名称\n注入', '子目录'] },
  ];
  const canonical = JSON.stringify({ task: 'save', items: [{ id: 'a' }], folders: catalog });
  const one = compactAiPayload(canonical);
  const two = compactAiPayload(JSON.stringify({ task: 'save', items: [{ id: 'b' }], folders: [...catalog].reverse() }));
  const wire = JSON.parse(one);
  expect(wire.folderTree).toBe('"parent" "名称\\n注入"\n  "child" "子目录"');
  expect(one.split('"items":')[0]).toBe(two.split('"items":')[0]);
  expect(wire.folders).toBeUndefined();
  expect(JSON.parse(canonical).folders).toEqual(catalog);
});
