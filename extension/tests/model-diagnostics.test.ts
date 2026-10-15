import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelTransport } from '../adapters/model-transport';
import { modelBodyDiagnostics, redactModelDiagnosticText } from '../adapters/model-diagnostics';
import { readModelResponse } from '../adapters/model-byte-limits';
import type { ModelAdapter } from '../domain/model-route';
import type { TreeSnapshot } from '../domain/node-reference';
import type { AiRequest } from '../domain/ai-payload';
import {
  createDebugLog,
  DEBUG_BODY_CHAR_LIMIT,
  DEBUG_SETTINGS_KEY,
  DEBUG_TRAIL_BYTE_LIMIT,
  DEBUG_TRAIL_KEY,
  resetDebugLogForTests,
  type DebugEntry,
} from '../domain/debug-log';

const credential = 'diagnostic-credential-do-not-record';
const tree: TreeSnapshot = {
  installationId: 'i',
  epoch: 'e',
  observedRevision: 1,
  roots: ['root'],
  nodes: [
    {
      ref: { installationId: 'i', nativeId: 'root', kind: 'folder' },
      title: 'Root',
      index: 0,
      childrenIds: ['a'],
      readOnly: false,
      observedRevision: 1,
    },
    {
      ref: { installationId: 'i', nativeId: 'a', kind: 'bookmark' },
      title: 'Example',
      url: 'https://example.test/',
      parentId: 'root',
      index: 0,
      childrenIds: [],
      readOnly: false,
      observedRevision: 1,
    },
  ],
};
let data: Record<string, unknown>;
let debug: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  resetDebugLogForTests();
  data = { [DEBUG_SETTINGS_KEY]: { enabled: true } };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (field: string) => ({ [field]: data[field] }),
        set: async (values: Record<string, unknown>) => {
          Object.assign(data, values);
        },
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  resetDebugLogForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function trail(): Promise<DebugEntry[]> {
  await vi.advanceTimersByTimeAsync(400);
  return (data[DEBUG_TRAIL_KEY] as DebugEntry[] | undefined) ?? [];
}

function setup(
  adapter: ModelAdapter,
  fetcher: typeof fetch,
  request: AiRequest = { task: 'search', query: 'query-'.repeat(100), itemIds: ['a'], folderIds: [] },
) {
  const input = {
    config: { adapter, baseUrl: 'https://gateway.test', model: 'diagnostic-model', timeoutMs: 5000 },
    key: credential,
    tree,
    privacy: { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
    request,
  };
  const authority = {
    read: async () => ({ version: 1 as const, revision: 'r', sessionRevision: 0, ...structuredClone(input) }),
    subscribe: () => () => {},
  };
  const transport = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority);
  return { input, transport };
}

const answer = '{"rankedIds":["a"]}';
it('measures real SSE answer arrival without counting thinking, independently of a UI observer', async () => {
  const timing = vi.fn();
  const h = setup('openai-compatible', async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    return new Response(
      new ReadableStream({
        start(controller) {
          const send = (value: unknown) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
          setTimeout(() => send({ choices: [{ delta: { reasoning_content: 'private thinking' } }] }), 10);
          setTimeout(() => send({ choices: [{ delta: { content: answer } }] }), 200);
          setTimeout(() => {
            send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          }, 500);
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const pending = h.transport.run({ ...h.input, onTiming: timing });
  await vi.advanceTimersByTimeAsync(700);
  expect(await pending).toMatchObject({ status: 'completed' });
  expect(timing).toHaveBeenCalledExactlyOnceWith({
    ms: 600,
    attempts: 1,
    streaming: true,
    responseMs: 600,
    firstTokenMs: 300,
    generationMs: 300,
    validationMs: 0,
  });
  h.transport.dispose();
});

it('does not invent JSON first-token timing or let a timing observer invalidate a result', async () => {
  const h = setup(
    'openai-compatible',
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  const timing = vi.fn(value => {
    expect(value).toMatchObject({ streaming: false, firstTokenMs: undefined, generationMs: undefined });
    throw Error('observer failed');
  });
  expect(await h.transport.run({ ...h.input, onTiming: timing })).toMatchObject({ status: 'completed' });
  expect(timing).toHaveBeenCalledOnce();
  h.transport.dispose();
});
it('records external cancellation source and diagnostic run identity without sending it to the provider', async () => {
  const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
  const h = setup('anthropic', fetcher);
  const controller = new AbortController();
  const pending = h.transport.run({ ...h.input, signal: controller.signal, diagnosticRunId: 'organize-run' });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(String(fetcher.mock.calls[0]![1]?.body)).not.toContain('organize-run');
  controller.abort();
  expect((await pending).status).toBe('cancelled');
  expect((await trail()).find(e => e.event === 'cancel-requested')?.detail).toMatchObject({
    runId: 'organize-run',
    source: 'input-signal',
  });
  h.transport.dispose();
});
it.each([
  ['openai-compatible', { choices: [{ message: { content: answer }, finish_reason: 'stop' }] }],
  [
    'openai-responses',
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }] },
  ],
  ['anthropic', { content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' }],
  ['google-generative-ai', { candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }] }],
] as const)('captures a correlated, redacted request and actual response for %s', async (adapter, raw) => {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify(raw), {
        headers: { 'content-type': 'application/json', 'x-request-id': 'provider-request-1' },
      }),
  );
  const { input, transport } = setup(adapter, fetcher);
  expect(await transport.run(input)).toEqual({ status: 'completed', output: { rankedIds: ['a'] } });
  transport.dispose();
  const entries = await trail();
  const get = (event: string) => entries.find(entry => entry.event === event)!.detail!;
  expect(get('request')).toMatchObject({ method: 'POST', attempt: 1 });
  expect(String(get('request').headers)).toContain('[redacted]');
  expect(String(get('request-body').body).length).toBeGreaterThan(300);
  expect(JSON.parse(String(get('response-body').body))).toEqual(raw);
  expect(get('response-headers')).toMatchObject({
    httpStatus: 200,
    contentType: 'application/json',
    serverRequestId: 'provider-request-1',
  });
  expect(get('reply-extracted')).toMatchObject({ chars: answer.length, truncated: false, refused: false });
  expect(get('call-end')).toMatchObject({ attempts: 1, status: 'completed' });
  expect(new Set(entries.map(entry => entry.detail?.callId)).size).toBe(1);
  expect(entries.map(entry => entry.event)).toEqual([
    'call-start',
    'request',
    'request-body',
    'response-headers',
    'waiting-policy',
    'response-body',
    'reply-extracted',
    'answer-body',
    'output-validated',
    'call-end',
  ]);
  expect(JSON.stringify(entries)).not.toContain(credential);
  expect(JSON.stringify(debug.mock.calls)).not.toContain(credential);
});

it('keeps a rejected folder answer and precise validation cause after a thinking-only body prefix', async () => {
  const rejected = JSON.stringify({
    newFolders: [],
    merges: [],
    moves: [{ itemId: 'a', folderId: 'root', reason: `echo ${credential}` }],
  });
  const frames = [
    { type: 'message_start', message: { content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'THOUGHT'.repeat(12000) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: rejected } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
  const fetcher = vi.fn(
    async () =>
      new Response(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
  const h = setup('anthropic', fetcher, {
    task: 'organize',
    stage: 'folders',
    rootId: 'root',
    itemIds: [],
    folderIds: ['root'],
  });
  expect(await h.transport.run(h.input)).toEqual({ status: 'failed', reason: 'schema' });
  h.transport.dispose();
  const entries = await trail();
  const body = entries.find(entry => entry.event === 'response-body')!.detail!;
  expect(body.truncated).toBe(true);
  expect(String(body.body)).not.toContain('text_delta');
  const finalAnswer = entries.find(entry => entry.event === 'answer-body')!.detail!;
  expect(finalAnswer.truncated).toBe(false);
  expect(String(finalAnswer.body)).not.toContain('THOUGHT');
  expect(JSON.parse(String(finalAnswer.body))).toMatchObject({ moves: [{ itemId: 'a', reason: 'echo [redacted]' }] });
  expect(entries.find(entry => entry.event === 'parse-failed')?.detail).toMatchObject({
    stage: 'validate',
    issue: 'moves.0.itemId: unknown-item',
    organizeStage: 'folders',
    inputItems: 0,
    inputFolders: 1,
  });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.stringify([entries, debug.mock.calls])).not.toContain(credential);
});

it('records both Responses attempts without changing the missing-text response', async () => {
  const raw = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text' }] }] };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(raw)));
  const { input, transport } = setup('openai-responses', fetcher);
  expect(await transport.run(input)).toEqual({ status: 'failed', reason: 'empty' });
  transport.dispose();
  const entries = await trail();
  expect(fetcher).toHaveBeenCalledTimes(2);
  const requests = entries.filter(entry => entry.event === 'request-body');
  expect(requests.map(entry => entry.detail?.attempt)).toEqual([1, 2]);
  expect(JSON.parse(String(requests[0]!.detail!.body)).text).toEqual({ format: { type: 'json_object' } });
  expect(JSON.parse(String(requests[1]!.detail!.body)).text).toBeUndefined();
  for (const entry of entries.filter(entry => entry.event === 'response-body'))
    expect(JSON.parse(String(entry.detail!.body))).toEqual(raw);
  expect(entries.filter(entry => entry.event === 'parse-failed').map(entry => entry.detail?.stage)).toEqual([
    'empty',
    'empty',
  ]);
  expect(entries.find(entry => entry.event === 'call-end')?.detail).toMatchObject({
    httpStatus: 200,
    attempts: 2,
    reason: 'empty',
  });
});

it.each([
  ['text/event-stream', 'data: {"type":"response.output_text.delta","delta":"answer"}\n\n'],
  ['application/json', '{not-json'],
])('captures the actual %s body before JSON parsing fails', async (contentType, body) => {
  const fetcher = vi.fn(async () => new Response(body, { headers: { 'content-type': contentType } }));
  const { input, transport } = setup('openai-responses', fetcher);
  expect(await transport.run(input)).toEqual({
    status: 'failed',
    reason: contentType === 'text/event-stream' ? 'incomplete' : 'schema',
  });
  transport.dispose();
  const entries = await trail();
  expect(entries.find(entry => entry.event === 'response-body')?.detail).toMatchObject({
    body,
    format: 'text',
    truncated: false,
  });
  if (contentType === 'application/json')
    expect(entries.find(entry => entry.event === 'response-read-failed')?.detail).toMatchObject({
      stage: 'decode-or-protocol',
      error: 'SyntaxError',
    });
  else expect(entries.find(entry => entry.event === 'parse-failed')?.detail?.stage).toBe('incomplete');
  expect(fetcher).toHaveBeenCalledOnce();
});

it('captures HTTP error JSON while redacting nested secrets and echoed credentials in console and storage', async () => {
  const raw = {
    error: { message: `Invalid ${credential}`, apiKey: 'another-secret', nested: { access_token: 'secret-access' } },
  };
  const { input, transport } = setup(
    'openai-responses',
    async () => new Response(JSON.stringify(raw), { status: 401 }),
  );
  expect(await transport.run(input)).toEqual({ status: 'failed', reason: 'http-401' });
  transport.dispose();
  const entries = await trail();
  expect(entries.find(entry => entry.event === 'response-body')?.detail).toMatchObject({ format: 'json' });
  const output = JSON.stringify([entries, debug.mock.calls]);
  for (const secret of [credential, 'another-secret', 'secret-access']) expect(output).not.toContain(secret);
  expect(output).toContain('[redacted]');
});

it('does not create, persist or print body diagnostics while debug is off', async () => {
  data[DEBUG_SETTINGS_KEY] = { enabled: false };
  const bodyFactory = vi.fn(() => ({ body: 'sensitive-body' }));
  createDebugLog('test')('response-body', bodyFactory);
  const { input, transport } = setup(
    'openai-responses',
    async () => new Response(JSON.stringify({ output_text: answer })),
  );
  expect((await transport.run(input)).status).toBe('completed');
  transport.dispose();
  expect(await trail()).toEqual([]);
  expect(bodyFactory).not.toHaveBeenCalled();
  expect(debug).not.toHaveBeenCalled();
});

it('redacts malformed text and escaped credential spellings before a marked body truncation', () => {
  const body = `data: {"apiKey":"another-secret","note":"${credential}"}\n` + '文'.repeat(DEBUG_BODY_CHAR_LIMIT);
  const detail = modelBodyDiagnostics(body, credential);
  expect(detail).toMatchObject({ format: 'text', truncated: true, capturedChars: DEBUG_BODY_CHAR_LIMIT });
  expect(String(detail.body).length).toBe(DEBUG_BODY_CHAR_LIMIT);
  expect(String(detail.body)).not.toContain('another-secret');
  expect(String(detail.body)).not.toContain(credential);
  const quotedKey = 'secret-with"quote';
  expect(redactModelDiagnosticText(JSON.stringify({ text: quotedKey }), quotedKey)).not.toContain('secret-with');
});

it('bounds the stored trail by encoded bytes with multibyte bodies', async () => {
  const log = createDebugLog('test');
  for (let i = 0; i < 20; i++) log('response-body', { body: '文'.repeat(DEBUG_BODY_CHAR_LIMIT), index: i });
  const entries = await trail();
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.length).toBeLessThan(20);
  expect(entries.at(-1)?.detail?.index).toBe(19);
  expect(new TextEncoder().encode(JSON.stringify(entries)).byteLength).toBeLessThanOrEqual(DEBUG_TRAIL_BYTE_LIMIT);
});

it('does not give diagnostics a partial over-budget response or let an observer fail a good response', async () => {
  const observer = vi.fn();
  await expect(readModelResponse(new Response('"文"'), 4, undefined, observer)).rejects.toThrow('response-too-large');
  expect(observer).not.toHaveBeenCalled();
  await expect(
    readModelResponse(new Response('"ok"'), 1024, undefined, () => {
      throw Error('diagnostic-only');
    }),
  ).resolves.toBe('ok');
});
