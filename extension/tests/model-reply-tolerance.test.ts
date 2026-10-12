import { expect, it } from 'vitest';
import { extractJsonObject, normalizeModelJson } from '../adapters/model-transport';
import { parseModelOutput } from '../schemas/model-output';

const context = {
  task: 'save',
  items: [{ id: '2506', title: '百度一下' }],
  folders: [{ id: '2348' }, { id: '17' }],
};

it('extracts JSON from fenced, prefixed and <think>-wrapped replies', () => {
  const body = '{"assignments":[{"itemId":"2506","folderId":"17"}],"newFolders":[]}';
  for (const reply of [
    body,
    '```json\n' + body + '\n```',
    '好的，结果如下：\n' + body,
    '<think>先看目录…</think>\n' + body,
  ])
    expect(extractJsonObject(reply)).toEqual(JSON.parse(body));
  expect(() => extractJsonObject('抱歉，我无法完成')).toThrow('json');
});

it('accepts numeric ids, commentary keys and a missing empty newFolders, but still rejects smuggled fields', () => {
  const sloppy = { assignments: [{ itemId: 2506, folderId: 17, reason: '搜索引擎' }], confidence: 0.9 };
  expect(parseModelOutput(normalizeModelJson(sloppy, 'save'), context)).toEqual({
    assignments: [{ itemId: '2506', folderId: '17' }],
    newFolders: [],
  });
  const smuggled = { assignments: [{ itemId: '2506', folderId: '17', url: 'https://evil.test' }], newFolders: [] };
  expect(() => parseModelOutput(normalizeModelJson(smuggled, 'save'), context)).toThrow('invalid-output');
  expect(() =>
    parseModelOutput(normalizeModelJson({ rankedIds: [2506], url: 'x' }, 'search'), { ...context, task: 'search' }),
  ).toThrow('invalid-output');
});

it('reads raw Responses API replies (no output_text) by walking output[] message parts', async () => {
  const { extractAssistantText } = await import('../adapters/model-transport');
  const raw = {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    model: 'gpt-5.6-sol',
    status: 'completed',
    output: [
      { id: 'rs_1', type: 'reasoning', summary: [], content: null },
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '{"assignments":[{"itemId":"2508","folderId":"17"}],"newFolders":[]}' }],
      },
    ],
  };
  expect(JSON.parse(extractAssistantText('openai-responses', raw))).toMatchObject({ newFolders: [] });
  expect(() =>
    extractAssistantText('openai-responses', {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'reasoning', summary: [] }],
    }),
  ).toThrow('incomplete');
});

it('Responses gateways: text on nested value / message item, and one retry without JSON mode on an empty reply', async () => {
  const { extractAssistantText, ModelTransport } = await import('../adapters/model-transport');
  const body = '{"rankedIds":["a"]}';
  expect(
    extractAssistantText('openai-responses', {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: { value: body } }] }],
    }),
  ).toBe(body);
  expect(
    extractAssistantText('openai-responses', { status: 'completed', output: [{ type: 'message', text: body }] }),
  ).toBe(body);

  const tree = {
    installationId: 'i',
    epoch: 'e',
    observedRevision: 1,
    roots: ['root'],
    nodes: [
      {
        ref: { installationId: 'i', nativeId: 'root', kind: 'folder' as const },
        title: 'Root',
        index: 0,
        childrenIds: ['a'],
        readOnly: false,
        observedRevision: 1,
      },
      {
        ref: { installationId: 'i', nativeId: 'a', kind: 'bookmark' as const },
        title: 'A',
        url: 'https://a.test/',
        parentId: 'root',
        index: 0,
        childrenIds: [],
        readOnly: false,
        observedRevision: 1,
      },
    ],
  };
  const input = {
    config: { adapter: 'openai-responses' as const, baseUrl: 'https://gw.test/v1', model: 'm', timeoutMs: 5000 },
    key: 'k',
    tree,
    privacy: { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
    request: { task: 'search' as const, query: 'a', itemIds: ['a'], folderIds: [] },
  };
  const bodies: Record<string, unknown>[] = [];
  const fetcher = async (_url: string, init: RequestInit) => {
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(sent);
    const content = sent.text ? [{ type: 'output_text', text: '' }] : [{ type: 'output_text', text: body }];
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content }] }));
  };
  const authority = {
    read: async () => ({ version: 1 as const, revision: 'r', sessionRevision: 0, ...structuredClone(input) }),
    subscribe: () => () => {},
  };
  const transport = new ModelTransport(
    { fetch: fetcher as unknown as typeof fetch, contains: async () => true },
    authority,
  );
  expect(await transport.run(input)).toEqual({ status: 'completed', output: { rankedIds: ['a'] } });
  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.text).toEqual({ format: { type: 'json_object' } });
  expect(bodies[1]!.text).toBeUndefined();
});
