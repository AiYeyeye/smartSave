import { expect, it, vi } from 'vitest';
import { analyzeOrganizeRepair, completeOrganizeRepair } from '../domain/organize-partial-repair';
import { parseModelOutput, type ModelOutputContext } from '../schemas/model-output';
import { ModelTransport } from '../adapters/model-transport';
import { organizerTree } from './fixtures/organizer-tree';

const context: ModelOutputContext = {
  task: 'organize',
  stage: 'bookmarks',
  omittedItemsUnchanged: true,
  items: ['a', 'b', 'c'].map(id => ({ id, title: id })),
  folders: [{ id: 'bar' }, { id: 'right' }],
  rootId: 'bar',
};
const output = {
  newFolders: [],
  merges: [],
  moves: [
    { itemId: 'a', folderId: 'right', reason: 'retain exactly' },
    { itemId: 'b', folderId: 'hallucinated' },
  ],
};
const known = ['bar', 'left', 'right', 'a', 'b', 'c', 'unselected-alias'];

it('retains valid and normally omitted rows but never accepts the pending identity until the complete batch is revalidated', () => {
  expect(() => parseModelOutput(output, context)).toThrow('invalid-output');
  const repair = analyzeOrganizeRepair(output, context, known)!;
  expect(repair.itemIds).toEqual(['b']);
  expect(repair.retained.moves).toEqual([output.moves[0]]);
  expect(repair.retained.unchangedIds).toEqual(['c']);
  expect(JSON.stringify(repair)).not.toContain('hallucinated');
  const final = completeOrganizeRepair(repair, { ...output, moves: [{ itemId: 'b', folderId: 'bar' }] }, context);
  expect(final).toMatchObject({ moves: [output.moves[0], { itemId: 'b', folderId: 'bar' }], unchangedIds: ['c'] });
  expect(completeOrganizeRepair(repair, { ...output, moves: [] }, context)).toMatchObject({ unchangedIds: ['c', 'b'] });
  expect(analyzeOrganizeRepair({ ...output, moves: [output.moves[0]] }, context, known)).toBeUndefined();
});

it.each([
  { ...output, moves: [...output.moves, { itemId: 'foreign', folderId: 'right' }] },
  { ...output, moves: [...output.moves, output.moves[0]] },
  { ...output, unchangedIds: ['b'] },
  { ...output, unchangedIds: ['foreign'] },
  { ...output, renames: [{ folderId: 'right', title: 'Changed' }] },
  { ...output, newFolders: [{ id: 'new', parentId: 'bar', title: 'new' }] },
  { ...output, merges: [{ sourceId: 'left', targetId: 'right' }] },
  { ...output, removeFolders: [{ folderId: 'left' }] },
  { ...output, moves: [{ itemId: 'b', folderId: 'left' }] },
  { ...output, moves: [{ itemId: 'b', folderId: 'unselected-alias' }] },
  { ...output, moves: [{ itemId: 'b', folderId: 'a' }] },
  { ...output, moves: [...output.moves, { itemId: 'c', folderId: 'right', url: 'https://injected.test' }] },
  { ...output, moves: [{ itemId: 'b' }] },
  { ...output, moves: [{ itemId: 'b', folderId: 'missing', reason: 'x'.repeat(501) }] },
  { ...output, extra: true },
])('rejects the entire candidate for any additional non-whitelisted defect: %j', value => {
  expect(analyzeOrganizeRepair(value, context, known)).toBeUndefined();
});

it('refuses folder-stage, non-sparse, oversized repair and attempts to rewrite retained identities', () => {
  expect(analyzeOrganizeRepair(output, { ...context, stage: 'folders' }, known)).toBeUndefined();
  expect(analyzeOrganizeRepair(output, { ...context, omittedItemsUnchanged: false }, known)).toBeUndefined();
  const items = Array.from({ length: 6 }, (_, i) => ({ id: String(i), title: 'item' }));
  expect(
    analyzeOrganizeRepair(
      { ...output, moves: items.map(item => ({ itemId: item.id, folderId: 'missing' })) },
      { ...context, items },
      known,
    ),
  ).toBeUndefined();
  const repair = analyzeOrganizeRepair(output, context, known)!;
  for (const value of [
    { ...output, moves: [{ itemId: 'a', folderId: 'bar' }] },
    { ...output, moves: [{ itemId: 'b', folderId: 'missing-again' }] },
    { ...output, moves: [], unchangedIds: ['a'] },
    { ...output, moves: [], renames: [{ folderId: 'right', title: 'Changed' }] },
  ])
    expect(() => completeOrganizeRepair(repair, value, context)).toThrow();
});

function transport(fetcher: typeof fetch) {
  const authority = {
    version: 1 as const,
    revision: 'one',
    sessionRevision: 0,
    key: '',
    tree: organizerTree(),
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
    config: { adapter: 'openai-compatible' as const, baseUrl: 'https://models.test/v1', model: 'm', timeoutMs: 1000 },
  };
  const model = new ModelTransport(
    { fetch: fetcher, contains: async () => true },
    {
      read: async () => structuredClone(authority),
      subscribe: () => () => {},
    },
  );
  const input = {
    ...authority,
    request: {
      task: 'organize' as const,
      stage: 'bookmarks' as const,
      rootId: 'bar',
      itemIds: ['a', 'b'],
      folderIds: ['bar', 'right'],
      omittedItemsUnchanged: true,
      destinations: [
        { id: 'bar', title: 'bar' },
        { id: 'right', parentId: 'bar', title: 'right' },
      ],
    },
    organizeRepair: { knownIds: ['unselected-alias'] },
  };
  return { model, input, authority };
}
const reply = (content: string, finish_reason = 'stop') =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }] }));

it('real transport exposes repair evidence only on explicit opt-in, after complete validation, without another fetch', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => reply(JSON.stringify(output)));
  const h = transport(fetcher);
  expect(await h.model.run(h.input)).toMatchObject({ status: 'repairable', repair: { itemIds: ['b'] } });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain('unselected-alias');
  expect(await h.model.run({ ...h.input, organizeRepair: undefined })).toMatchObject({
    status: 'failed',
    reason: 'schema',
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  h.model.dispose();
});

it.each(['length', 'json', 'unknown-item', 'stream-error', 'missing-terminal', 'network'])(
  'never salvages %s or sends an automatic follow-up',
  async failure => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (failure === 'length') return reply(JSON.stringify(output), 'length');
      if (failure === 'json') return reply('{"moves":[');
      if (failure === 'unknown-item') return reply(JSON.stringify({ ...output, unchangedIds: ['foreign'] }));
      const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(output) }, finish_reason: null }] })}\n\n`;
      if (failure === 'network')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(Error('disconnected'));
            },
          }),
        );
      return new Response(chunk + (failure === 'stream-error' ? 'data: {"error":{"message":"failed"}}\n\n' : ''), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const h = transport(fetcher);
    expect(await h.model.run(h.input)).toMatchObject({ status: 'failed' });
    expect(fetcher).toHaveBeenCalledOnce();
    h.model.dispose();
  },
);
