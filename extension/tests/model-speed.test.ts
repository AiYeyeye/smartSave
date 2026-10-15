import { afterEach, expect, it, vi } from 'vitest';
import { ModelTransport, modelRequestBody } from '../adapters/model-transport';
import { syntheticConnectionTree } from '../adapters/ai-connection';
import type { ModelConfig } from '../domain/model-route';
import { modelThinkingPlan } from '../domain/model-thinking';

const base: ModelConfig = {
  adapter: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'o3-mini',
  timeoutMs: 60000,
};
afterEach(() => {
  vi.useRealTimers();
});
it.each([
  [{ ...base }, { reasoning_effort: 'low' }],
  [{ ...base, adapter: 'openai-responses' as const }, { reasoning: { effort: 'low' } }],
  [{ ...base, model: 'gpt-5' }, { reasoning_effort: 'minimal' }],
  [{ ...base, model: 'gpt-5.1' }, { reasoning_effort: 'none' }],
  [
    {
      ...base,
      adapter: 'google-generative-ai' as const,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-flash',
    },
    { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
  ],
  [
    {
      ...base,
      adapter: 'google-generative-ai' as const,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-pro',
    },
    { generationConfig: { thinkingConfig: { thinkingBudget: 128 } } },
  ],
  [
    {
      ...base,
      adapter: 'google-generative-ai' as const,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-3-flash-preview',
    },
    { generationConfig: { thinkingConfig: { thinkingLevel: 'minimal' } } },
  ],
  [{ ...base, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5' }, { thinking: { type: 'disabled' } }],
] as const)('uses only verified native thinking controls for %j', (config, expected) => {
  const body = JSON.parse(modelRequestBody(config, 'search', '{"items":[],"folders":[]}'));
  expect(body).toMatchObject(expected);
  const budget = body.max_completion_tokens ?? body.max_output_tokens ?? body.generationConfig?.maxOutputTokens;
  expect(budget).toBe(128000);
});

it.each([
  { ...base, fastMode: false },
  { ...base, model: 'gpt-4.1-mini' },
  { ...base, model: 'gpt-5.1-codex' },
  { ...base, baseUrl: 'https://unverified-gateway.test/v1' },
  { ...base, baseUrl: 'https://api.openai.com.untrusted.test/v1' },
  { ...base, baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner' },
])('leaves unknown/disabled capabilities unchanged: %j', config => {
  expect(modelThinkingPlan(config)).toBeUndefined();
});

function setup(fetcher: typeof fetch, config = { ...base, baseUrl: 'https://retry.test/v1', model: 'test' }) {
  const context = {
    version: 1 as const,
    revision: 'r',
    sessionRevision: 0,
    config,
    key: '',
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
    tree: syntheticConnectionTree(),
  };
  const transport = new ModelTransport(
    { fetch: fetcher, contains: async () => true },
    { read: async () => structuredClone(context), subscribe: () => () => {} },
  );
  const input = {
    ...context,
    request: { task: 'search' as const, query: 'example', itemIds: ['test-bookmark'], folderIds: [] },
  };
  return { transport, input, context };
}
const success = () =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: '{"rankedIds":["test-bookmark"]}' }, finish_reason: 'stop' }] }),
  );

it('retries only 429/5xx at 2/4/8 seconds with a shared three-retry allowance', async () => {
  vi.useFakeTimers();
  const times: number[] = [];
  const start = Date.now();
  const fetcher = vi.fn(async () => {
    times.push(Date.now() - start);
    return times.length < 4 ? new Response('busy', { status: times.length === 1 ? 429 : 503 }) : success();
  });
  const h = setup(fetcher);
  const progress = vi.fn();
  const pending = h.transport.run({ ...h.input, onProgress: progress });
  await vi.advanceTimersByTimeAsync(14000);
  expect(await pending).toMatchObject({ status: 'completed' });
  expect(times).toEqual([0, 2000, 6000, 14000]);
  expect(progress.mock.calls.flatMap(([p]) => (p.retry ? [p.retry.delaySeconds] : []))).toEqual([2, 4, 8]);
  h.transport.dispose();
});

it('cancels backoff immediately and rechecks freshness before any replay', async () => {
  vi.useFakeTimers();
  for (const cancel of [true, false]) {
    const fetcher = vi.fn(async () => new Response('busy', { status: 429 }));
    const h = setup(fetcher);
    const signal = new AbortController();
    const pending = h.transport.run({ ...h.input, signal: signal.signal });
    await vi.advanceTimersByTimeAsync(1);
    if (cancel) signal.abort();
    else h.context.config = { ...h.context.config, model: 'changed' };
    await vi.advanceTimersByTimeAsync(20000);
    expect(await pending).toMatchObject({
      status: cancel ? 'cancelled' : 'failed',
      reason: cancel ? 'cancelled' : 'stale-context',
    });
    expect(fetcher).toHaveBeenCalledOnce();
    h.transport.dispose();
  }
});

it('never retries a body-read network failure or extends the configured request deadline', async () => {
  vi.useFakeTimers();
  const broken = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new TypeError('network'));
          },
        }),
      ),
  );
  const h = setup(broken);
  expect(await h.transport.run(h.input)).toMatchObject({ status: 'failed', reason: 'network-error' });
  expect(broken).toHaveBeenCalledOnce();
  h.transport.dispose();
  const busy = vi.fn(async () => new Response('busy', { status: 503 }));
  const timed = setup(busy, { ...base, timeoutMs: 1000 });
  const pending = timed.transport.run(timed.input);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ status: 'failed', reason: 'timeout' });
  expect(busy).toHaveBeenCalledOnce();
  timed.transport.dispose();
});

it('removes only the automatically rejected thinking control once and remembers it for the same route', async () => {
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    JSON.parse(String(init?.body)).reasoning_effort
      ? new Response(JSON.stringify({ error: { param: 'reasoning_effort', message: 'Unsupported parameter' } }), {
          status: 400,
        })
      : success(),
  );
  const h = setup(fetcher, { ...base, baseUrl: 'https://api.openai.com/v1/compatibility-test' });
  expect(await h.transport.run(h.input)).toMatchObject({ status: 'completed' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies[0].reasoning_effort).toBe('low');
  expect(bodies[1]).toEqual(
    Object.fromEntries(Object.entries(bodies[0]).filter(([key]) => key !== 'reasoning_effort')),
  );
  expect(await h.transport.run(h.input)).toMatchObject({ status: 'completed' });
  expect(fetcher).toHaveBeenCalledTimes(3);
  h.transport.dispose();
});

it.each([400, 401, 403, 404])('does not replay unrelated HTTP %s failures', async status => {
  const fetcher = vi.fn(async () => new Response('invalid model or input', { status }));
  const h = setup(fetcher, { ...base, baseUrl: `https://api.openai.com/v1/unrelated-${status}` });
  expect(await h.transport.run(h.input)).toMatchObject({ status: 'failed' });
  expect(fetcher).toHaveBeenCalledOnce();
  h.transport.dispose();
});
