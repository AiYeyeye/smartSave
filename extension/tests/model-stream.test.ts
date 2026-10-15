import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWireReply } from '../adapters/model-stream';
import { completedReplyText, readModelReply } from '../adapters/model-replies';
import { ModelTransport, modelRequestBody } from '../adapters/model-transport';
import { modelStreaming, parseModelEndpoint, parseModelListEndpoint, type ModelAdapter } from '../domain/model-route';
import { syntheticConnectionTree } from '../adapters/ai-connection';

const answer = '{"rankedIds":[]}';
const frame = (value: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;

it('rejects thinking-only Anthropic output exhausted at max_tokens without treating it as an answer', async () => {
  const fetcher = vi.fn(async () =>
    response([
      { type: 'message_start', message: { content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'synthetic reasoning' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 8192 } },
      { type: 'message_stop' },
    ]),
  );
  const h = harness('anthropic', fetcher);
  expect(await h.transport.run(h.input)).toEqual({ status: 'failed', reason: 'incomplete', detail: 'output-limit' });
  expect(fetcher).toHaveBeenCalledOnce();
  h.transport.dispose();
});
const responses = (text = answer) => [
  { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'm', delta: text },
  {
    type: 'response.completed',
    response: { status: 'completed', output: [{ id: 'm', type: 'message', content: [{ type: 'output_text' }] }] },
  },
];
const streams: [ModelAdapter, unknown[]][] = [
  ['openai-responses', responses()],
  [
    'openai-compatible',
    [
      { choices: [{ index: 0, delta: { content: answer } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { total_tokens: 2 } },
      '[DONE]',
    ],
  ],
  [
    'anthropic',
    [
      { type: 'message_start', message: { content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ],
  ],
  [
    'google-generative-ai',
    [
      {
        candidates: [{ index: 0, content: { parts: [{ thought: true, text: 'private thought' }, { text: answer }] } }],
      },
      { usageMetadata: {} },
      { candidates: [{ index: 0, finishReason: 'STOP' }] },
    ],
  ],
];
function response(values: unknown[], chunkSize = 19, newline = '\n') {
  const bytes = new TextEncoder().encode(
    '\uFEFF: heartbeat\n\n' +
      values
        .map(v => frame(v))
        .join('')
        .replace(/\n/g, newline),
  );
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (offset === bytes.length) {
          c.close();
          return;
        }
        c.enqueue(bytes.slice(offset, (offset += chunkSize)));
        offset = Math.min(offset, bytes.length);
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
}
const read = async (adapter: ModelAdapter, values: unknown[], chunkSize?: number, newline?: string) =>
  (await readWireReply(response(values, chunkSize, newline), adapter, 1024 * 1024)).reply;

it.each(streams)(
  'reports a rejected body read as network-error for %s, even after terminal text',
  async (adapter, frames) => {
    const bytes = new TextEncoder().encode(frames.map(value => frame(value)).join(''));
    let sent = false;
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(bytes);
              } else controller.error(new TypeError('network error'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const h = harness(adapter, fetcher);
    expect(await h.transport.run(h.input)).toEqual({ status: 'failed', reason: 'network-error' });
    expect(fetcher).toHaveBeenCalledOnce();
    h.transport.dispose();
  },
);

it('keeps invalid UTF-8 as schema while distinguishing JSON body transport failure', async () => {
  const invalid = harness(
    'anthropic',
    async () =>
      new Response(new Uint8Array([0xff]), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
  expect(await invalid.transport.run(invalid.input)).toEqual({ status: 'failed', reason: 'schema' });
  invalid.transport.dispose();
  const broken = harness(
    'anthropic',
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new TypeError('network error'));
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  expect(await broken.transport.run(broken.input)).toEqual({ status: 'failed', reason: 'network-error' });
  broken.transport.dispose();
});
it.each(streams)(
  'publishes only assistant answer progress for %s while keeping completion validation',
  async (adapter, values) => {
    const progress = vi.fn();
    const wire = await readWireReply(response(values), adapter, 1024 * 1024, undefined, undefined, progress);
    expect(wire.reply.text).toBe(answer);
    expect(progress.mock.calls.some(([value]) => value.text === answer && value.streaming)).toBe(true);
    expect(JSON.stringify(progress.mock.calls)).not.toContain('private thought');
  },
);
it('observer exceptions do not change protocol validation or permit an incomplete reply', async () => {
  const progress = () => {
    throw Error('display failed');
  };
  const wire = await readWireReply(
    response(responses().slice(0, 1)),
    'openai-responses',
    1024,
    undefined,
    undefined,
    progress,
  );
  expect(wire.reply.truncated).toBe(true);
  expect(() => completedReplyText(wire.reply)).toThrow();
});
it('accepts bounded SSE metadata exceeding the former 1MiB wire cap while the answer stays small', async () => {
  const events = Array.from({ length: 140 }, () => ({ type: 'response.created', padding: 'x'.repeat(8192) }));
  const reply = await read('openai-responses', [...events, ...responses()], 16384);
  expect(reply.text).toBe(answer);
});
it('still bounds an individual stream frame and the assembled answer independently', async () => {
  await expect(
    read('openai-responses', [{ type: 'response.created', padding: 'x'.repeat(2 * 1024 * 1024) }], 65536),
  ).rejects.toThrow('response-too-large');
  await expect(read('openai-responses', responses('x'.repeat(1024 * 1024 + 1)), 65536)).rejects.toThrow(
    'response-too-large',
  );
});
function harness(
  adapter: ModelAdapter = 'openai-responses',
  fetcher: typeof fetch = vi.fn(async () => response(responses())),
) {
  const input = {
    config: { adapter, baseUrl: 'https://model.test/v1', model: 'm', timeoutMs: 1000 },
    key: 'test-key',
    tree: syntheticConnectionTree(),
    privacy: { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
    request: { task: 'search' as const, query: 'test', itemIds: [], folderIds: [] },
  };
  let listener: (() => void) | undefined;
  const authority = {
    read: vi.fn(async () => ({ version: 1 as const, revision: 'r', sessionRevision: 0, ...structuredClone(input) })),
    subscribe: (fn: () => void) => {
      listener = fn;
      return () => {};
    },
  };
  const contains = vi.fn(async () => true);
  const transport = new ModelTransport({ fetch: fetcher, contains }, authority);
  return { input, authority, contains, transport, invalidate: () => listener?.() };
}
it.each(['response.completed', 'response.incomplete'])(
  'reports output budget stops under %s without executing or retrying partial text',
  async type => {
    const fetcher = vi.fn(async () =>
      response([
        responses()[0],
        {
          type,
          response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: answer },
        },
      ]),
    );
    const h = harness('openai-responses', fetcher);
    expect(await h.transport.run(h.input)).toEqual({ status: 'failed', reason: 'incomplete', detail: 'output-limit' });
    expect(fetcher).toHaveBeenCalledOnce();
    h.transport.dispose();
  },
);
it.each(['before', 'after', 'nested'])(
  'keeps an explicit provider error %s a contradictory budget stop',
  async where => {
    const terminal = {
      type: 'response.completed',
      response: {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output_text: answer,
        ...(where === 'nested' ? { error: { code: 'upstream-failed' } } : {}),
      },
    };
    const error = { type: 'error', error: { code: 'upstream-failed' } };
    const h = harness('openai-responses', async () =>
      response([
        responses()[0],
        ...(where === 'before' ? [error] : []),
        terminal,
        ...(where === 'after' ? [error] : []),
      ]),
    );
    expect(await h.transport.run(h.input)).toEqual({ status: 'failed', reason: 'provider-error' });
    h.transport.dispose();
  },
);
it.each([
  [
    'openai-responses',
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: answer },
  ],
  ['openai-compatible', { choices: [{ message: { content: answer }, finish_reason: 'length' }] }],
  ['anthropic', { content: [{ type: 'text', text: answer }], stop_reason: 'max_tokens' }],
  ['google-generative-ai', { candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'MAX_TOKENS' }] }],
] as const)('preserves the output-limit detail for %s JSON too', async (adapter, raw) => {
  const h = harness(adapter, async () => new Response(JSON.stringify(raw)));
  expect(await h.transport.run(h.input)).toEqual({ status: 'failed', reason: 'incomplete', detail: 'output-limit' });
  h.transport.dispose();
});
it('allows a per-task deadline without changing saved authority identity and publishes progress before completion', async () => {
  vi.useFakeTimers();
  try {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const h = harness(
      'openai-responses',
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              stream = c;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const onProgress = vi.fn();
    const pending = h.transport.run({ ...h.input, timeoutMs: 5000, onProgress });
    await vi.advanceTimersByTimeAsync(1500);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'waiting' }));
    stream.enqueue(new TextEncoder().encode(frame(responses()[0])));
    await vi.advanceTimersByTimeAsync(0);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ text: answer, phase: 'receiving' }));
    stream.enqueue(new TextEncoder().encode(frame(responses()[1])));
    stream.close();
    expect((await pending).status).toBe('completed');
    expect(h.input.config.timeoutMs).toBe(1000);
    h.transport.dispose();
  } finally {
    vi.useRealTimers();
  }
});
it('throttles thinking-only chunks but immediately delivers the first answer and final validation', async () => {
  vi.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const h = harness(
    'anthropic',
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const onProgress = vi.fn();
  const pending = h.transport.run({ ...h.input, onProgress });
  await vi.advanceTimersByTimeAsync(0);
  const send = async (value: unknown) => {
    stream.enqueue(new TextEncoder().encode(frame(value)));
    await vi.advanceTimersByTimeAsync(0);
  };
  for (let index = 0; index < 100; index++)
    await send({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'private thought' },
    });
  expect(onProgress.mock.calls.filter(([value]) => value.phase === 'receiving')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(150);
  await send({ type: 'ping' });
  expect(onProgress.mock.calls.filter(([value]) => value.phase === 'receiving')).toHaveLength(2);
  // First actual answer arrives in the same throttle window and must be visible immediately.
  await send({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  await send({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: answer } });
  expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'receiving', text: answer }));
  await send({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
  await send({ type: 'message_stop' });
  stream.close();
  expect((await pending).status).toBe('completed');
  expect(onProgress).toHaveBeenLastCalledWith(
    expect.objectContaining({ phase: 'validating', receivedChars: answer.length }),
  );
  expect(JSON.stringify(onProgress.mock.calls)).not.toContain('private thought');
  h.transport.dispose();
});
afterEach(() => vi.useRealTimers());

describe('native streaming requests', () => {
  it.each(['openai-compatible', 'openai-responses', 'anthropic', 'google-generative-ai'] as const)(
    '%s supports stream and JSON with stable route identity',
    adapter => {
      const config = { adapter, baseUrl: 'https://model.test/v1', model: 'models/m', timeoutMs: 1000 };
      expect(modelStreaming(config)).toBe(true);
      const streaming = JSON.parse(modelRequestBody(config, 'search', '{}'));
      const json = JSON.parse(modelRequestBody({ ...config, streaming: false }, 'search', '{}'));
      if (adapter === 'google-generative-ai') {
        expect(parseModelEndpoint(config).url).toBe('https://model.test/v1/models/m:streamGenerateContent?alt=sse');
        expect(parseModelEndpoint({ ...config, streaming: false }).url).toBe(
          'https://model.test/v1/models/m:generateContent',
        );
        expect(streaming.stream).toBeUndefined();
      } else {
        expect(streaming.stream).toBe(true);
        expect(json.stream).toBe(false);
      }
      expect(parseModelEndpoint(config).identity).toBe(parseModelEndpoint({ ...config, streaming: false }).identity);
      expect(parseModelListEndpoint(config).url).toBe('https://model.test/v1/models');
    },
  );
  it('keeps local adapter defaults unchanged', () => {
    expect(modelStreaming({ adapter: 'ollama', streaming: true })).toBe(false);
    expect(modelStreaming({ adapter: 'lm-studio' })).toBe(false);
  });
});

describe('stream framing and protocol completion', () => {
  it('counts a surrogate pair split across deltas as four UTF-8 bytes at the answer limit', async () => {
    const text = '😀'.repeat(255);
    const values = [
      { type: 'response.output_text.delta', delta: text + '\uD83D' },
      { type: 'response.output_text.delta', delta: '\uDE00' },
      { type: 'response.completed', response: { status: 'completed' } },
    ];
    const result = await readWireReply(response(values), 'openai-responses', 1024);
    expect(completedReplyText(result.reply)).toBe('😀'.repeat(256));
  });
  it('keeps an incomplete Responses item terminal sticky when the final gateway snapshot omits its status', async () => {
    const reply = await read('openai-responses', [
      responses()[0],
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          status: 'incomplete',
          content: [{ type: 'output_text', text: answer }],
        },
      },
      responses()[1],
    ]);
    expect(() => completedReplyText(reply)).toThrow('incomplete');
  });
  it.each([
    [
      'openai-compatible',
      [
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [{ index: 0, delta: { content: answer } }] },
        '[DONE]',
      ],
    ],
    ['openai-responses', [...responses(), { type: 'response.output_text.done', text: '{"rankedIds":["late"]}' }]],
    [
      'anthropic',
      [...streams[2]![1], { type: 'content_block_start', index: 0, content_block: { type: 'text', text: answer } }],
    ],
  ] as [ModelAdapter, unknown[]][])('%s rejects answer changes after its terminal', async (adapter, values) => {
    await expect(read(adapter, values)).rejects.toThrow('envelope');
  });
  it.each(streams)(
    '%s bounds assembled answers before EOF even without a progress observer',
    async (adapter, values) => {
      // Two individually legal frames cross the answer budget while the wire remains below its own limit.
      const text = '中'.repeat(180);
      const data =
        adapter === 'anthropic'
          ? [
              values[0],
              values[1],
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
            ]
          : adapter === 'openai-responses'
            ? [0, 1].map(() => ({ type: 'response.output_text.delta', delta: text }))
            : adapter === 'google-generative-ai'
              ? [0, 1].map(() => ({ candidates: [{ content: { parts: [{ text }] } }] }))
              : [0, 1].map(() => ({ choices: [{ delta: { content: text } }] }));
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(data.map(value => frame(value)).join('')));
          // Deliberately no EOF: the answer guard must cancel this open stream itself.
        },
        cancel,
      });
      const pending = readWireReply(
        new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
        adapter,
        1024,
      );
      const outcome = await Promise.race([
        pending.then(
          () => 'accepted',
          e => (e as Error).message,
        ),
        new Promise<string>(resolve => setTimeout(() => resolve('still-reading'), 30)),
      ]);
      expect(outcome).toBe('response-too-large');
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it.each(streams)('%s assembles its native stream', async (adapter, values) => {
    expect(completedReplyText(await read(adapter, values))).toBe(answer);
    const h = harness(
      adapter,
      vi.fn(async () => response(values)),
    );
    expect(await h.transport.run(h.input)).toEqual({ status: 'completed', output: { rankedIds: [] } });
    h.transport.dispose();
  });
  it.each(['\n', '\r\n', '\r'])('handles BOM, split UTF-8, comments and %j at each byte', async newline => {
    const text = '{"中文":"收藏😀"}';
    expect(completedReplyText(await read('openai-responses', responses(text), 1, newline))).toBe(text);
  });
  it('handles multi-line data and typed SSE events', async () => {
    const body =
      'event: response.output_text.delta\ndata: {"delta":\ndata: "' +
      answer.replace(/"/g, '\\"') +
      '"}\n\n' +
      frame(responses()[1]);
    const reply = await readWireReply(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      'openai-responses',
      10000,
    );
    expect(completedReplyText(reply.reply)).toBe(answer);
  });
  it.each(streams)('%s requires a successful terminal', async (adapter, values) => {
    const reply = await read(adapter, values.slice(0, adapter === 'anthropic' ? -2 : -1));
    expect(() => completedReplyText(reply)).toThrow('incomplete');
  });
  it.each(streams)('%s fails on error after valid answer', async (adapter, values) => {
    const reply = await read(adapter, [
      ...values,
      { type: 'error', error: { message: 'failed', code: 'upstream_error' } },
    ]);
    expect(() => completedReplyText(reply)).toThrow('provider');
  });
  it('recognizes SSE event:error without a typed body', async () => {
    const body =
      responses()
        .map(v => frame(v))
        .join('') + frame({ message: 'failure' }, 'error');
    const { reply } = await readWireReply(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      'openai-responses',
      10000,
    );
    expect(() => completedReplyText(reply)).toThrow('provider');
  });
  it('does not accept unfinished final frames even after completion', async () => {
    const body =
      responses()
        .map(v => frame(v))
        .join('') + 'data: {"type":"error"}';
    await expect(
      readWireReply(
        new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
        'openai-responses',
        10000,
      ),
    ).rejects.toThrow('incomplete');
  });
  it('replaces snapshots, orders parts, skips reasoning and preserves missing final text', async () => {
    const values = [
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'B' },
      { type: 'response.output_text.delta', output_index: 0, content_index: 1, delta: '2' },
      { type: 'response.reasoning_summary_text.delta', delta: 'THINK' },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'A' },
      { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'A1' },
      {
        type: 'response.content_part.done',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: 'A1' },
      },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'A1' }, { type: 'output_text' }] }],
        },
      },
    ];
    expect(completedReplyText(await read('openai-responses', values))).toBe('A12B');
  });
  it.each(['failed', 'incomplete'])('Responses %s overrides valid text', async status => {
    const reply = await read('openai-responses', [
      responses()[0],
      { type: `response.${status}`, response: { status } },
    ]);
    expect(() => completedReplyText(reply)).toThrow(status === 'failed' ? 'provider' : 'incomplete');
  });
  it('Responses refusal wins over text and top-level output_text', async () => {
    const reply = await read('openai-responses', [...responses(), { type: 'response.refusal.done', refusal: 'no' }]);
    expect(() => completedReplyText(reply)).toThrow('refused');
  });
  it('rejects contradictory Responses item identities instead of merging answers', async () => {
    await expect(
      read('openai-responses', [
        responses()[0],
        { type: 'response.output_text.delta', output_index: 1, item_id: 'm', content_index: 0, delta: 'other' },
        responses()[1],
      ]),
    ).rejects.toThrow('envelope');
  });
  it.each(['length', 'content_filter', 'tool_calls'])('Chat %s cannot authorize task output', async finish => {
    const reply = await read('openai-compatible', [
      { choices: [{ index: 0, delta: { content: answer }, finish_reason: finish }] },
      '[DONE]',
    ]);
    expect(() => completedReplyText(reply)).toThrow(
      finish === 'length' ? 'incomplete' : finish === 'content_filter' ? 'refused' : 'provider',
    );
  });
  it('Anthropic appends equal deltas, skips thinking, and does not duplicate starts', async () => {
    const values = [
      { type: 'message_start', message: { content: [{ type: 'text', text: 'A' }] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'A' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'THINK' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];
    expect(completedReplyText(await read('anthropic', values))).toBe('AAA');
  });
  it.each(['max_tokens', 'model_context_window_exceeded', 'refusal', 'tool_use', 'pause_turn'])(
    'Anthropic %s does not succeed',
    async stop => {
      const values = [...streams[2]![1]];
      values[4] = { type: 'message_delta', delta: { stop_reason: stop } };
      const reply = await read('anthropic', values);
      expect(() => completedReplyText(reply)).toThrow(
        stop === 'refusal'
          ? 'refused'
          : ['max_tokens', 'model_context_window_exceeded'].includes(stop)
            ? 'incomplete'
            : 'provider',
      );
    },
  );
  it.each(['MAX_TOKENS', 'SAFETY', 'MALFORMED_FUNCTION_CALL', 'FINISH_REASON_UNSPECIFIED'])(
    'Google %s cannot succeed',
    async finish => {
      const reply = await read('google-generative-ai', [
        { candidates: [{ content: { parts: [{ text: answer }] }, finishReason: finish }] },
      ]);
      expect(() => completedReplyText(reply)).toThrow(
        finish === 'MAX_TOKENS' ? 'incomplete' : finish === 'SAFETY' ? 'refused' : 'provider',
      );
    },
  );
  it('Google prompt block wins even with text; STOP frame text is retained', async () => {
    const reply = await read('google-generative-ai', [
      {
        candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }],
        promptFeedback: { blockReason: 'SAFETY' },
      },
    ]);
    expect(() => completedReplyText(reply)).toThrow('refused');
    expect(
      completedReplyText(
        await read('google-generative-ai', [
          { candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }] },
        ]),
      ),
    ).toBe(answer);
  });
});

describe('JSON outcome precedes usable task text', () => {
  it.each([
    ['openai-compatible', { choices: [{ message: { content: answer }, finish_reason: 'length' }] }, 'incomplete'],
    ['openai-compatible', { choices: [{ message: { content: answer }, finish_reason: null }] }, 'incomplete'],
    [
      'openai-compatible',
      { choices: [{ message: { content: answer, refusal: 'no' }, finish_reason: 'stop' }] },
      'refused',
    ],
    ['anthropic', { content: [{ type: 'text', text: answer }], stop_reason: 'max_tokens' }, 'incomplete'],
    ['anthropic', { content: [{ type: 'text', text: answer }], stop_reason: null }, 'incomplete'],
    ['anthropic', { content: [{ type: 'text', text: answer }], stop_reason: 'refusal' }, 'refused'],
    [
      'google-generative-ai',
      { candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'MAX_TOKENS' }] },
      'incomplete',
    ],
    [
      'google-generative-ai',
      {
        candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }],
        promptFeedback: { blockReason: 'SAFETY' },
      },
      'refused',
    ],
  ] as const)('%s JSON does not accept valid partial text with %s', (adapter, raw, failure) => {
    expect(() => completedReplyText(readModelReply(adapter, raw))).toThrow(failure);
  });
  it('selects explicit choice/candidate zero regardless of array order', () => {
    const chat = {
      choices: [
        { index: 1, message: { content: 'wrong' }, finish_reason: 'stop' },
        { index: 0, message: { content: answer }, finish_reason: 'stop' },
      ],
    };
    const google = {
      candidates: [
        { index: 1, content: { parts: [{ text: 'wrong' }] }, finishReason: 'STOP' },
        { index: 0, content: { parts: [{ text: answer }] }, finishReason: 'STOP' },
      ],
    };
    expect(completedReplyText(readModelReply('openai-compatible', chat))).toBe(answer);
    expect(completedReplyText(readModelReply('google-generative-ai', google))).toBe(answer);
  });
  it.each(['failed', 'cancelled', 'queued', 'in_progress', 'incomplete'])(
    'Responses status %s never succeeds',
    status => {
      const reply = readModelReply('openai-responses', { status, output_text: answer });
      expect(() => completedReplyText(reply)).toThrow(status === 'incomplete' ? 'incomplete' : 'provider');
    },
  );
  it.each(streams)('%s checks JSON error first', adapter => {
    expect(() => completedReplyText(readModelReply(adapter, { error: { code: 'bad' }, output_text: answer }))).toThrow(
      'provider',
    );
  });
  it('canonical Responses text wins over contradictory SDK convenience value', () => {
    expect(
      completedReplyText(
        readModelReply('openai-responses', {
          status: 'completed',
          output_text: 'wrong',
          output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }],
        }),
      ),
    ).toBe(answer);
  });
  it('preserves the user missing-text payload as empty, never a successful classification', async () => {
    const raw = {
      id: 'resp_14e9bf6b712e2dce9a081933',
      object: 'response',
      created_at: 1791788931,
      model: 'gpt-5.6-sol',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'item_2fe67cddfd4e6a5ceb95d229',
          role: 'assistant',
          content: [{ type: 'output_text' }],
          status: 'completed',
        },
      ],
    };
    expect(new TextEncoder().encode(JSON.stringify(raw))).toHaveLength(267);
    const fetcher = vi.fn(async () => new Response(JSON.stringify(raw)));
    const h = harness('openai-responses', fetcher);
    expect(await h.transport.run(h.input)).toEqual({ status: 'failed', reason: 'empty' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    h.transport.dispose();
  });
});

describe('one logical operation owns abort and deadline', () => {
  it.each(streams)(
    '%s keeps a healthy stream alive beyond its original request budget without a UI observer',
    async (adapter, values) => {
      vi.useFakeTimers();
      let source!: ReadableStreamDefaultController<Uint8Array>;
      const h = harness(
        adapter,
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                source = c;
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      );
      const pending = h.transport.run(h.input);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(700);
        source.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
      }
      source.enqueue(new TextEncoder().encode(values.map(value => frame(value)).join('')));
      source.close();
      expect(await pending).toEqual({ status: 'completed', output: { rankedIds: [] } });
      h.transport.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(['thinking', 'comment'] as const)(
    'renews on %s and expires only after a full silent interval',
    async activity => {
      vi.useFakeTimers();
      let source!: ReadableStreamDefaultController<Uint8Array>;
      const cancel = vi.fn();
      const h = harness(
        'anthropic',
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                source = c;
              },
              cancel,
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      );
      const pending = h.transport.run(h.input);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(800);
      source.enqueue(
        new TextEncoder().encode(
          activity === 'comment'
            ? ': ping\n\n'
            : frame({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'synthetic' },
              }),
        ),
      );
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ status: 'failed', reason: 'timeout' });
      expect(cancel).toHaveBeenCalledOnce();
      h.transport.dispose();
    },
  );
  it('does not let incomplete frames extend inactivity indefinitely or revive an expired clock', async () => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const h = harness(
      'anthropic',
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              source = c;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const pending = h.transport.run(h.input);
    await vi.advanceTimersByTimeAsync(700);
    source.enqueue(new TextEncoder().encode('data: {'));
    await vi.advanceTimersByTimeAsync(0);
    // Simulate a throttled timer: a late complete heartbeat must not resurrect the call.
    vi.setSystemTime(Date.now() + 400);
    source.enqueue(new TextEncoder().encode('"type":"ping"}\n\n'));
    expect(await pending).toEqual({ status: 'failed', reason: 'timeout' });
    h.transport.dispose();
  });
  it('does not wait for a stalled source cancellation to report a protocol failure', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: invalid\n\n'));
      },
      cancel,
    });
    await expect(
      readWireReply(new Response(source, { headers: { 'content-type': 'text/event-stream' } }), 'anthropic', 1024),
    ).rejects.toThrow('envelope');
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });
  it('aborts an authority read before any fetch', async () => {
    const fetcher = vi.fn();
    const h = harness('openai-responses', fetcher);
    h.authority.read.mockImplementation(() => new Promise(() => {}));
    const promise = h.transport.run(h.input);
    h.transport.cancel();
    expect(await promise).toEqual({ status: 'cancelled', reason: 'cancelled' });
    expect(fetcher).not.toHaveBeenCalled();
    h.transport.dispose();
  });
  it('reports a forbidden redirect without waiting for stalled body cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel }));
    Object.defineProperty(response, 'redirected', { value: true });
    const h = harness('anthropic', async () => response);
    expect(await h.transport.run(h.input)).toEqual({ status: 'failed', reason: 'redirect' });
    expect(cancel).toHaveBeenCalledOnce();
    h.transport.dispose();
  });
  it('times out an authority wait within the same total deadline', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.authority.read.mockImplementation(() => new Promise(() => {}));
    const promise = h.transport.run(h.input);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toEqual({ status: 'failed', reason: 'timeout' });
    h.transport.dispose();
  });
  it('does not reset timeout for the empty retry', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      signals.push(init!.signal as AbortSignal);
      if (signals.length === 1) {
        await new Promise(resolve => setTimeout(resolve, 700));
        return new Response('{"status":"completed","output":[]}');
      }
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const h = harness('openai-responses', fetcher);
    const promise = h.transport.run(h.input);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toEqual({ status: 'failed', reason: 'timeout' });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    h.transport.dispose();
  });
  it('settings invalidation before the retry prevents a new fetch', async () => {
    const fetcher = vi.fn(async () => new Response('{"status":"completed","output":[]}'));
    const h = harness('openai-responses', fetcher);
    const normal = h.authority.read.getMockImplementation()!;
    let reads = 0;
    h.authority.read.mockImplementation(async () => {
      const value = await normal();
      if (++reads === 3) h.invalidate();
      return value;
    });
    expect(await h.transport.run(h.input)).toEqual({ status: 'cancelled', reason: 'cancelled' });
    expect(fetcher).toHaveBeenCalledOnce();
    h.transport.dispose();
  });
  it('abort cancels a hanging response reader and does not deliver observed text', async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(frame(responses()[0])));
      },
      cancel,
    });
    const h = harness(
      'openai-responses',
      vi.fn(async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } })),
    );
    const controller = new AbortController();
    const promise = h.transport.run({ ...h.input, signal: controller.signal });
    await vi.waitFor(() => expect(source.locked).toBe(true));
    controller.abort();
    expect(await promise).toEqual({ status: 'cancelled', reason: 'cancelled' });
    expect(cancel).toHaveBeenCalledOnce();
    h.transport.dispose();
  });
  it('enforces raw-byte budget and cancels the reader', async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(64 * 16 + 1));
      },
      cancel,
    });
    await expect(
      readWireReply(new Response(source, { headers: { 'content-type': 'text/event-stream' } }), 'openai-responses', 64),
    ).rejects.toThrow('response-too-large');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
