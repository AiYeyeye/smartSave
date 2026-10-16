import { afterEach, expect, it, vi } from 'vitest';
import { tokenUsageAccumulator, type TokenUsageRecord } from '../domain/token-usage';
import {
  recordTokenUsage,
  readTokenUsage,
  tokenUsageView,
  watchTokenUsage,
  TOKEN_USAGE_KEY,
} from '../persistence/token-usage';
import { ModelTransport } from '../adapters/model-transport';
import { MODEL_BYTE_LIMITS } from '../adapters/model-byte-limits';
import { syntheticConnectionTree } from '../adapters/ai-connection';
import type { ModelAdapter } from '../domain/model-route';
import { readWireReply } from '../adapters/model-stream';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const at = new Date(2026, 9, 15, 12).getTime();
const record = (id = 'r', overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord => ({
  id,
  at,
  adapter: 'openai-compatible',
  model: 'literal-model',
  purpose: 'save',
  counts: { input: 10, output: 5, total: 15 },
  complete: true,
  ...overrides,
});
function storage() {
  let data: Record<string, unknown> = {};
  const area = {
    get: vi.fn(async () => structuredClone(data)),
    set: vi.fn(async (next: Record<string, unknown>) => {
      data = structuredClone(next);
    }),
  };
  let pending = Promise.resolve();
  const lock = <T>(operation: () => Promise<T>) => {
    const next = pending.then(operation, operation);
    pending = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  return { area, lock };
}
it.each([
  [
    'openai-compatible',
    [
      {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      },
    ],
    { input: 10, output: 20, total: 30 },
  ],
  ['lm-studio', [{ usage: { prompt_tokens: 10, completion_tokens: 20 } }], { input: 10, output: 20, total: 30 }],
  [
    'openai-responses',
    [
      {
        type: 'response.completed',
        response: {
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, input_tokens_details: { cached_tokens: 8 } },
        },
      },
    ],
    { input: 10, output: 20, total: 30 },
  ],
  [
    'anthropic',
    [
      {
        type: 'message_start',
        message: {
          usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 },
        },
      },
      { type: 'message_delta', usage: { output_tokens: 10 } },
      { type: 'message_delta', usage: { output_tokens: 20 } },
    ],
    { input: 60, output: 20, total: 80 },
  ],
  [
    'google-generative-ai',
    [
      { usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 5, candidatesTokenCount: 4 } },
      { usageMetadata: { candidatesTokenCount: 20, thoughtsTokenCount: 8, totalTokenCount: 38 } },
    ],
    { input: 10, output: 28, total: 38 },
  ],
  ['ollama', [{ done: true, prompt_eval_count: 10, eval_count: 20 }], { input: 10, output: 20, total: 30 }],
] as [ModelAdapter, unknown[], object][])(
  'normalizes %s without adding cumulative/cache/reasoning subsets twice',
  (adapter, values, expected) => {
    const usage = tokenUsageAccumulator(adapter);
    values.forEach(value => usage.push(value));
    expect(usage.snapshot()).toEqual(expected);
  },
);
it('keeps missing distinct from zero and rejects malformed counters', () => {
  const usage = tokenUsageAccumulator('openai-compatible');
  usage.push({ usage: { prompt_tokens: -1, completion_tokens: '2', total_tokens: 1.5 } });
  expect(usage.snapshot()).toEqual({});
  usage.push({ usage: { prompt_tokens: 0, completion_tokens: 0 } });
  expect(usage.snapshot()).toEqual({ input: 0, output: 0, total: 0 });
  usage.push({ usage: { total_tokens: null, prompt_tokens: 1e30 } });
  expect(usage.snapshot()).toEqual({ input: 0, output: 0, total: 0 });
});
it('replaces a stale early total when a later cumulative snapshot updates only the components', () => {
  const usage = tokenUsageAccumulator('openai-compatible');
  usage.push({ usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
  usage.push({ usage: { completion_tokens: 8 } });
  expect(usage.snapshot()).toEqual({ input: 2, output: 8, total: 10 });
});
it.each([
  [
    'openai-compatible',
    {
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    },
  ],
  [
    'openai-responses',
    { status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
  ],
  ['anthropic', { content: [], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 } }],
  [
    'google-generative-ai',
    {
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    },
  ],
  ['ollama', { message: { content: '{}' }, done: true, prompt_eval_count: 2, eval_count: 3 }],
  [
    'lm-studio',
    {
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    },
  ],
] as [ModelAdapter, unknown][])('observes actual %s JSON counters before output validation', async (adapter, raw) => {
  const usage = tokenUsageAccumulator(adapter);
  await readWireReply(Response.json(raw), adapter, 10000, undefined, undefined, undefined, undefined, raw =>
    usage.push(raw),
  );
  expect(usage.snapshot()).toEqual({ input: 2, output: 3, total: 5 });
});
it.each([
  [
    'openai-responses',
    [
      {
        type: 'response.completed',
        response: { status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
      },
    ],
  ],
  [
    'anthropic',
    [
      { type: 'message_start', message: { content: [], usage: { input_tokens: 2, output_tokens: 1 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ],
  ],
  [
    'google-generative-ai',
    [
      {
        candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
      },
    ],
  ],
] as [ModelAdapter, unknown[]][])(
  'observes %s native SSE snapshots independently of UI progress',
  async (adapter, frames) => {
    const usage = tokenUsageAccumulator(adapter);
    await readWireReply(sse(frames), adapter, 10000, undefined, undefined, undefined, undefined, raw =>
      usage.push(raw),
    );
    expect(usage.snapshot()).toEqual({ input: 2, output: 3, total: 5 });
  },
);
it('ignores a failing usage observer without changing the wire result', async () => {
  const raw = { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] };
  const wire = await readWireReply(
    Response.json(raw),
    'openai-compatible',
    10000,
    undefined,
    undefined,
    undefined,
    undefined,
    () => {
      throw Error('observer');
    },
  );
  expect(wire.reply.text).toBe('{}');
});
it('serializes concurrent writers, deduplicates receipts and retains lifetime totals after recent/day eviction', async () => {
  vi.setSystemTime(at);
  const { area, lock } = storage();
  await Promise.all(Array.from({ length: 120 }, (_, i) => recordTokenUsage(record(String(i)), area, lock)));
  await recordTokenUsage(record('119'), area, lock);
  await recordTokenUsage(record('old', { at: at - 60 * 86400000, counts: {}, complete: false }), area, lock);
  const ledger = await readTokenUsage(area);
  expect(ledger.recent).toHaveLength(100);
  expect(tokenUsageView(ledger, 'all', at).summary).toMatchObject({ requests: 121, total: 1800, missing: 1 });
  expect(tokenUsageView(ledger, '30', at).summary.requests).toBe(120);
  expect(ledger.days.every(day => day.day >= '2026-09-15')).toBe(true);
  expect(JSON.stringify(ledger)).not.toMatch(/key|url|prompt|secret/i);
});
it('does not overwrite invalid/future storage or write without cross-context locking', async () => {
  const area = { get: async () => ({ [TOKEN_USAGE_KEY]: { version: 2 } }), set: vi.fn() };
  await expect(recordTokenUsage(record(), area, async op => op())).rejects.toThrow();
  expect(area.set).not.toHaveBeenCalled();
  vi.stubGlobal('navigator', {});
  await expect(recordTokenUsage(record(), storage().area)).rejects.toThrow('usage-lock-unavailable');
});
it('subscribes before initial read, ignores unrelated writes, fences late snapshots and disposes', async () => {
  let resolve!: (value: Record<string, unknown>) => void;
  const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: () =>
          new Promise(r => {
            resolve = r;
          }),
      },
      onChanged: { addListener: (fn: never) => listeners.add(fn), removeListener: (fn: never) => listeners.delete(fn) },
    },
  });
  const receive = vi.fn();
  const failed = vi.fn();
  const stop = watchTokenUsage(receive, failed);
  const { area, lock } = storage();
  await recordTokenUsage(record(), area, lock);
  const latest = await readTokenUsage(area);
  for (const fn of listeners) {
    fn({ modelSecurity: { newValue: {} } }, 'local');
    fn({ [TOKEN_USAGE_KEY]: { newValue: latest } }, 'local');
  }
  resolve({});
  await Promise.resolve();
  await Promise.resolve();
  expect(receive).toHaveBeenCalledOnce();
  expect(receive).toHaveBeenLastCalledWith(latest);
  expect(failed).not.toHaveBeenCalled();
  stop();
  expect(listeners.size).toBe(0);
});

const sse = (values: unknown[]) =>
  new Response(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
function harness(
  fetcher: typeof fetch,
  recorder = vi.fn(async (record: TokenUsageRecord) => {
    void record;
  }),
) {
  const input = {
    config: {
      adapter: 'openai-compatible' as const,
      baseUrl: 'https://model.test/v1',
      model: 'model',
      timeoutMs: 1000,
    },
    key: 'secret',
    tree: syntheticConnectionTree(),
    privacy: { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
    request: { task: 'search' as const, query: 'test', itemIds: [], folderIds: [] },
  };
  const contains = vi.fn(async () => true);
  const authority = {
    read: async () => ({ version: 1 as const, revision: 'r', sessionRevision: 0, ...structuredClone(input) }),
    subscribe: () => () => {},
  };
  const transport = new ModelTransport({ fetch: fetcher, contains }, authority, MODEL_BYTE_LIMITS, recorder);
  return { input, contains, transport, recorder };
}
it('records usage-only final SSE frames once, retains usage when schema fails and shares recorder with forks', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    sse([
      { choices: [{ delta: { content: '{"rankedIds":["foreign"]}' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
    ]),
  );
  const h = harness(fetcher);
  expect(await h.transport.run(h.input)).toMatchObject({ status: 'failed', reason: 'schema' });
  expect(h.recorder).toHaveBeenCalledOnce();
  expect(h.recorder.mock.calls[0]![0]).toMatchObject({
    purpose: 'search',
    counts: { input: 10, output: 20, total: 30 },
    complete: true,
  });
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).stream_options).toEqual({ include_usage: true });
  const fork = h.transport.fork();
  await fork.run(h.input);
  expect(h.recorder).toHaveBeenCalledTimes(2);
  expect(h.recorder.mock.calls[0]![0].id).not.toBe(h.recorder.mock.calls[1]![0].id);
  fork.dispose();
  h.transport.dispose();
});
it('counts each compatibility retry separately and does not record prefetch failures', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('{"error":{"message":"unknown parameter stream_options"}}', { status: 400 }))
    .mockResolvedValueOnce(
      Response.json({
        choices: [{ message: { content: '{"rankedIds":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    );
  const h = harness(fetcher);
  expect(await h.transport.run({ ...h.input, usagePurpose: 'connection-test' })).toMatchObject({ status: 'completed' });
  expect(h.recorder.mock.calls.map(call => call[0].counts)).toEqual([{}, { input: 3, output: 2, total: 5 }]);
  expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string).stream_options).toBeUndefined();
  h.contains.mockResolvedValue(false);
  await h.transport.run(h.input);
  expect(h.recorder).toHaveBeenCalledTimes(2);
  h.transport.dispose();
});
it('retains partial stream counters on cancellation and isolates recorder failures', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":10}}\n\n'));
            setTimeout(() => controller.abort(), 5);
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const h = harness(fetcher);
  expect(await h.transport.run({ ...h.input, signal: controller.signal })).toMatchObject({ status: 'cancelled' });
  expect(h.recorder.mock.calls[0]![0]).toMatchObject({ counts: { input: 10 }, complete: false });
  h.transport.dispose();
  const failing = harness(
    vi.fn(async () =>
      Response.json({ choices: [{ message: { content: '{"rankedIds":[]}' }, finish_reason: 'stop' }] }),
    ),
    vi.fn(async () => {
      throw Error('quota');
    }),
  );
  expect(await failing.transport.run(failing.input)).toMatchObject({ status: 'completed' });
  failing.transport.dispose();
});
