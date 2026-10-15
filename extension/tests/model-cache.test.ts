import { expect, it } from 'vitest';
import { modelRequestBody } from '../adapters/model-transport';
import { compactAiPayload, serializeAiPayload, serializedItemRequestSize } from '../domain/ai-payload';
import { organizerTree } from './fixtures/organizer-tree';

const config = {
  adapter: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-sonnet-4-6',
  timeoutMs: 1000,
};
const tree = organizerTree();
tree.nodes.find(node => node.ref.nativeId === 'a')!.title = '中文 "quotes" 😀\nline';
const privacy = { fullUrl: false, bodyEnabled: false, excludedFolders: [] };
const request = {
  task: 'organize' as const,
  stage: 'bookmarks' as const,
  rootId: 'bar',
  folderIds: ['bar', 'left', 'right'],
  itemIds: [] as string[],
  destinations: tree.nodes
    .filter(node => ['bar', 'left', 'right'].includes(node.ref.nativeId))
    .map(node => ({ id: node.ref.nativeId, parentId: node.parentId, title: node.title })),
};
const payload = (itemIds: string[]) => serializeAiPayload(tree, privacy, { ...request, itemIds });
const body = (itemIds: string[]) => JSON.parse(modelRequestBody(config, 'organize', payload(itemIds)));

it('marks only the stable directory prefix and reconstructs the exact compact input', () => {
  const one = body(['a']);
  const two = body(['b']);
  const blocks = one.messages[0].content;
  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toEqual(two.messages[0].content[0]);
  expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
  expect(blocks[0].text).not.toContain('https://');
  expect(blocks[0].text).not.toContain('items');
  expect(blocks[1].cache_control).toBeUndefined();
  expect(blocks.map((block: { text: string }) => block.text).join('')).toBe(compactAiPayload(payload(['a'])));
  expect(one.max_tokens).toBe(128000);
});

it('keeps exact additive batch sizing with the official two-block envelope', () => {
  const measure = (ids: string[]) =>
    new TextEncoder().encode(modelRequestBody(config, 'organize', payload(ids))).byteLength;
  const sizes = serializedItemRequestSize(payload(['a', 'b']), measure([]));
  for (const ids of [[], ['a'], ['b'], ['a', 'b'], ['b', 'a']])
    expect(
      sizes.sharedBytes + ids.reduce((sum, id) => sum + sizes.itemBytes(id), 0) + Math.max(0, ids.length - 1),
    ).toBe(measure(ids));
});

it.each(['https://gateway.test/v1', 'https://api.anthropic.com.untrusted.test/v1', 'http://api.anthropic.com/v1'])(
  'preserves string content for unverified route %s',
  baseUrl => {
    const result = JSON.parse(modelRequestBody({ ...config, baseUrl }, 'organize', payload(['a'])));
    expect(typeof result.messages[0].content).toBe('string');
  },
);

it('does not mark empty catalogs and keeps variable queries after the marker', () => {
  const input = { task: 'search', query: 'private query', folders: [], items: [] };
  const empty = JSON.parse(modelRequestBody(config, 'search', JSON.stringify(input)));
  expect(typeof empty.messages[0].content).toBe('string');
  const withCatalog = { ...input, folders: [{ id: 'bar', path: ['书签栏'], ancestorIds: [] }] };
  const result = JSON.parse(modelRequestBody(config, 'search', JSON.stringify(withCatalog)));
  expect(result.messages[0].content[0].text).not.toContain(input.query);
  expect(result.messages[0].content[1].text).toContain(input.query);
});
