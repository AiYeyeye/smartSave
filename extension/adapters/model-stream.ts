import { createParser, type EventSourceMessage } from 'eventsource-parser';
import type { ModelAdapter } from '../domain/model-route';
import { readModelChunks, readModelResponse, MODEL_STREAM_LIMITS, type ModelBodyObserver } from './model-byte-limits';
import {
  arr,
  obj,
  str,
  partText,
  providerFailureCode,
  readModelReply,
  ModelParseError,
  type Json,
  type ModelReply,
} from './model-replies';

interface Reducer {
  push(value: Json, event?: string): void;
  done(): void;
  finish(): ModelReply;
}
export interface ModelStreamProgress {
  /** Bounded assistant answer prefix only; never reasoning or executable output. */
  text: string;
  receivedChars: number;
  streaming: boolean;
}
export const MODEL_PREVIEW_CHARS = 32_768;

const index = (value: unknown): number => {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new ModelParseError('envelope', 'invalid stream index');
  return value;
};

/** Explicit errors survive later completed snapshots. No provider body leaks into ModelResult. */
function providerError(value: Json, event?: string): string | undefined {
  return event === 'error' || value.error != null || value.type === 'error'
    ? providerFailureCode(value.error)
    : undefined;
}

/** Incremental answer bytes, independent of progress observers and the larger SSE wire budget. */
function answerBudget(limit: number) {
  const encoder = new TextEncoder();
  let bytes = 0;
  return (before: string, value: string, append = false) => {
    bytes += encoder.encode(value).byteLength - (append ? 0 : encoder.encode(before).byteLength);
    // JSON deltas may split a UTF-16 surrogate pair: together it encodes as 4 bytes, not 3 + 3.
    if (append && /[\uD800-\uDBFF]$/.test(before) && /^[\uDC00-\uDFFF]/.test(value)) bytes -= 2;
    if (bytes > limit) throw Error('response-too-large');
    return append ? before + value : value;
  };
}

function responsesReducer(limit: number): Reducer {
  const write = answerBudget(limit);
  const parts = new Map<string, { output: number; content: number; text: string }>();
  const items = new Map<string, number>();
  const slots = new Map<number, string>();
  const outcome: ModelReply = { text: '', truncated: false };
  let terminal = false;
  const bind = (id: string, output: number) => {
    if ((items.has(id) && items.get(id) !== output) || (slots.has(output) && slots.get(output) !== id))
      throw new ModelParseError('envelope', 'inconsistent item index');
    items.set(id, output);
    slots.set(output, id);
  };
  const set = (output: number, content: number, text: string, delta = false) => {
    const key = `${output}:${content}`;
    const before = parts.get(key)?.text ?? '';
    // Gateway compatibility: missing/empty final snapshots cannot erase observed text.
    parts.set(key, { output, content, text: write(before, delta ? text : text || before, delta) });
  };
  const snapshot = (item: Json, output: number) => {
    if (item.type !== 'message' || (item.role !== undefined && item.role !== 'assistant')) return;
    const id = str(item.id);
    if (id) bind(id, output);
    arr(item.content).forEach((raw, content) => {
      const part = obj(raw);
      if (part.type === 'output_text') set(output, content, partText(part));
      if (part.type === 'refusal') outcome.refused = str(part.refusal) || 'refusal';
    });
  };
  return {
    push(value, event) {
      const error = providerError(value, event);
      if (error) outcome.failed = error;
      const type = str(value.type) ?? event ?? '';
      if (terminal && /^response\.(output_text|content_part|output_item)\./.test(type))
        throw new ModelParseError('envelope', 'answer event after terminal');
      const output =
        value.output_index === undefined && str(value.item_id)
          ? (items.get(String(value.item_id)) ?? 0)
          : index(value.output_index);
      const content = index(value.content_index);
      const itemId = str(value.item_id);
      if (itemId) bind(itemId, output);
      if (type === 'response.output_text.delta') {
        if (terminal) throw new ModelParseError('envelope', 'text after terminal');
        if (typeof value.delta !== 'string') throw new ModelParseError('envelope', 'missing delta');
        set(output, content, value.delta, true);
      } else if (type === 'response.output_text.done') {
        if (typeof value.text === 'string') set(output, content, value.text);
      } else if (type === 'response.content_part.done' || type === 'response.content_part.added') {
        const part = obj(value.part);
        if (part.type === 'output_text') set(output, content, partText(part));
        if (part.type === 'refusal') outcome.refused = str(part.refusal) || 'refusal';
      } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        const item = obj(value.item);
        snapshot(item, output);
        if (type === 'response.output_item.done') {
          const reply = readModelReply('openai-responses', { status: 'completed', output: [item] });
          outcome.failed ||= reply.failed;
          outcome.refused ||= reply.refused;
          outcome.truncated ||= reply.truncated;
        }
      } else if (type === 'response.refusal.delta' || type === 'response.refusal.done') {
        outcome.refused = 'refusal';
      } else if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
        terminal = true;
        const response = obj(value.response);
        const status = str(response.status);
        const responseError = providerError(response);
        if (responseError) outcome.failed = responseError;
        if (type === 'response.completed' && status !== undefined && status !== 'completed')
          outcome.failed ||= 'contradictory-completion';
        if (type === 'response.failed' && (!outcome.failed || outcome.failed === 'contradictory-completion'))
          outcome.failed = 'failed';
        if (type === 'response.incomplete') outcome.truncated = true;
        const reply = readModelReply('openai-responses', { ...response, status: status ?? type.slice(9) });
        if (reply.failed && (!outcome.failed || outcome.failed === 'contradictory-completion'))
          outcome.failed = reply.failed;
        outcome.refused ||= reply.refused;
        outcome.truncated ||= reply.truncated;
        outcome.finish = reply.finish ?? status ?? type.slice(9);
        arr(response.output).forEach((item, i) => snapshot(obj(item), i));
        if (![...parts.values()].some(part => part.text.trim()) && reply.text) set(0, 0, reply.text);
      }
    },
    done() {
      /* [DONE] alone does not complete Responses. */
    },
    finish() {
      return {
        ...outcome,
        text: [...parts.values()]
          .sort((a, b) => a.output - b.output || a.content - b.content)
          .map(p => p.text)
          .join(''),
        truncated: outcome.truncated || !terminal,
        finish: outcome.finish ?? (terminal ? 'completed' : 'missing-terminal'),
      };
    },
  };
}

function chatReducer(limit: number): Reducer {
  const write = answerBudget(limit);
  let text = '';
  let refusal = '';
  let finish: string | undefined;
  let failed: string | undefined;
  let terminal = false;
  return {
    push(value, event) {
      failed ||= providerError(value, event);
      const choice = arr(value.choices)
        .map(obj)
        .find(c => index(c.index) === 0);
      if (!choice) return; // e.g. final usage-only frame
      const delta = obj(choice.delta);
      if ((terminal || finish) && (str(delta.content) || str(delta.refusal)))
        throw new ModelParseError('envelope', 'text after finish');
      text = write(text, str(delta.content) ?? '', true);
      refusal += str(delta.refusal) ?? '';
      const stop = str(choice.finish_reason);
      if (finish && stop && finish !== stop) failed = 'contradictory-finish';
      if (stop) finish = stop;
    },
    done() {
      terminal = true;
    },
    finish() {
      const reply = readModelReply('openai-compatible', {
        choices: [{ message: { content: text, refusal }, finish_reason: finish }],
      });
      return { ...reply, failed: failed ?? reply.failed, truncated: reply.truncated || !terminal || !finish };
    },
  };
}

function anthropicReducer(limit: number): Reducer {
  const write = answerBudget(limit);
  const blocks = new Map<number, { type: string; text: string }>();
  let stop: string | undefined;
  let terminal = false;
  let failed: string | undefined;
  const start = (i: number, block: Json) => {
    if (terminal || stop) throw new ModelParseError('envelope', 'content after finish');
    const text = block.type === 'text' ? (str(block.text) ?? '') : '';
    blocks.set(i, { type: str(block.type) ?? '', text: write(blocks.get(i)?.text ?? '', text) });
  };
  return {
    push(value, event) {
      failed ||= providerError(value, event);
      const type = str(value.type) ?? event;
      if (type === 'message_start') {
        arr(obj(value.message).content).forEach((block, i) => {
          start(i, obj(block));
        });
      } else if (type === 'content_block_start') {
        start(index(value.index), obj(value.content_block));
      } else if (type === 'content_block_delta') {
        const delta = obj(value.delta);
        const block = blocks.get(index(value.index));
        if (delta.type === 'text_delta') {
          if (terminal || stop || !block || block.type !== 'text' || typeof delta.text !== 'string')
            throw new ModelParseError('envelope', 'invalid text delta');
          block.text = write(block.text, delta.text, true);
        }
      } else if (type === 'message_delta') {
        const reason = str(obj(value.delta).stop_reason);
        if (stop && reason && reason !== stop) failed = 'contradictory-finish';
        stop = reason ?? stop;
      } else if (type === 'message_stop') terminal = true;
    },
    done() {},
    finish() {
      const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
      const reply = readModelReply('anthropic', { content, stop_reason: stop });
      return { ...reply, failed: failed ?? reply.failed, truncated: reply.truncated || !terminal || !stop };
    },
  };
}

function googleReducer(limit: number): Reducer {
  const write = answerBudget(limit);
  let text = '';
  let stop: string | undefined;
  let outcome: ModelReply = { text: '', truncated: false };
  return {
    push(value, event) {
      outcome.failed ||= providerError(value, event);
      const block = str(obj(value.promptFeedback).blockReason);
      if (block && block !== 'BLOCK_REASON_UNSPECIFIED') outcome.refused = `prompt ${block}`;
      const candidate = arr(value.candidates)
        .map(obj)
        .find(c => index(c.index) === 0);
      if (!candidate) return;
      const reply = readModelReply('google-generative-ai', { candidates: [candidate] });
      if (stop && reply.text) throw new ModelParseError('envelope', 'text after finish');
      text = write(text, reply.text, true);
      if (stop && reply.finish && stop !== reply.finish) outcome.failed = 'contradictory-finish';
      stop = reply.finish ?? stop;
      outcome = {
        ...outcome,
        failed: outcome.failed ?? reply.failed,
        refused: outcome.refused ?? reply.refused,
        truncated: outcome.truncated || reply.truncated,
      };
    },
    done() {},
    finish() {
      return { ...outcome, text, finish: stop, truncated: outcome.truncated || !stop };
    },
  };
}

/** Select actual wire format, accepting JSON from gateways even when streaming was requested. */
export async function readWireReply(
  response: Response,
  adapter: ModelAdapter,
  limit: number,
  signal?: AbortSignal,
  onBody?: ModelBodyObserver,
  onProgress?: (progress: ModelStreamProgress) => void,
  /** Complete SSE events/comments renew transport liveness, independent of UI progress. */
  onActivity?: () => void,
  /** Usage is accounting evidence even when the following completion/schema check fails. */
  onUsage?: (raw: unknown) => void,
): Promise<{ reply: ModelReply; raw?: unknown; events?: number }> {
  const usage = (raw: unknown) => {
    try {
      onUsage?.(raw);
    } catch {
      /* Accounting observers cannot change protocol validity. */
    }
  };
  const report = (reply: ModelReply, streaming: boolean) => {
    if (!onProgress || reply.failed || reply.refused) return;
    if (new TextEncoder().encode(reply.text).byteLength > limit) throw Error('response-too-large');
    try {
      onProgress({ text: reply.text.slice(0, MODEL_PREVIEW_CHARS), receivedChars: reply.text.length, streaming });
    } catch {
      /* Display observers never change protocol validation. */
    }
  };
  if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
    const raw = await readModelResponse(response, limit, signal, onBody);
    usage(raw);
    const reply = readModelReply(adapter, raw);
    report(reply, false);
    return { reply, raw };
  }
  if (adapter === 'ollama') throw new ModelParseError('envelope', 'unsupported SSE protocol');
  const reducer =
    adapter === 'openai-responses'
      ? responsesReducer(limit)
      : adapter === 'anthropic'
        ? anthropicReducer(limit)
        : adapter === 'google-generative-ai'
          ? googleReducer(limit)
          : chatReducer(limit);
  let events = 0;
  const parser = createParser({
    maxBufferSize: Math.min(MODEL_STREAM_LIMITS.frameBytes, limit * 2),
    onComment() {
      onActivity?.();
    },
    onError(error) {
      if (error.type === 'max-buffer-size-exceeded') throw Error('response-too-large');
    },
    onEvent(event: EventSourceMessage) {
      if (new TextEncoder().encode(event.data).byteLength > Math.min(MODEL_STREAM_LIMITS.frameBytes, limit * 2))
        throw Error('response-too-large');
      events++;
      if (event.data.trim() === '[DONE]') {
        reducer.done();
        onActivity?.();
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        throw new ModelParseError('envelope', 'invalid SSE JSON');
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ModelParseError('envelope', 'invalid SSE payload');
      usage(value);
      reducer.push(obj(value), event.event);
      onActivity?.();
    },
  });
  const raw = await readModelChunks(
    response,
    Math.min(MODEL_STREAM_LIMITS.wireBytes, limit * 16),
    signal,
    text => {
      parser.feed(text);
      if (onProgress && !signal?.aborted) report(reducer.finish(), true);
    },
    onBody,
  );
  const tail =
    raw
      .replace(/\r\n|\r/g, '\n')
      .split('\n\n')
      .at(-1) ?? '';
  if (tail.split('\n').some(line => line.trim() && !line.startsWith(':')))
    throw new ModelParseError('incomplete', 'unfinished SSE frame');
  parser.reset({ consume: true }); // Never invent an empty line to complete a partial frame.
  const reply = reducer.finish();
  if (new TextEncoder().encode(reply.text).byteLength > limit) throw Error('response-too-large');
  return { reply, events };
}
