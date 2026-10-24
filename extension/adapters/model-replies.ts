import type { ModelConfig } from '../domain/model-route';

/**
 * Reading the answer text out of each wire protocol's reply. The four user-facing modes (plus local
 * Ollama / LM Studio) put the text, the stop reason and refusals in different places:
 *
 * | mode                     | text                                          | stop / truncation                       | refusal / block                         |
 * |--------------------------|-----------------------------------------------|-----------------------------------------|-----------------------------------------|
 * | OpenAI Chat Completions  | choices[0].message.content (string or parts)  | choices[0].finish_reason = "length"     | message.refusal, finish_reason "content_filter" |
 * | OpenAI Responses         | output[type=message].content[type=output_text].text (output_text is SDK-only) | status "incomplete" + incomplete_details.reason | content[type=refusal].refusal |
 * | Anthropic Messages       | content[type=text].text (skip thinking blocks) | stop_reason = "max_tokens"             | stop_reason = "refusal"                 |
 * | Google Generative AI     | candidates[0].content.parts[].text (skip thought parts) | candidates[0].finishReason = "MAX_TOKENS" | promptFeedback.blockReason, finishReason SAFETY/RECITATION/… |
 * | Ollama                   | message.content                               | done_reason = "length"                  | —                                       |
 */
export type ModelReply = {
  text: string;
  /** The model stopped because it ran out of output budget; partial JSON is expected. */
  truncated: boolean;
  /** Safety block or explicit refusal, with the provider's reason when given. */
  refused?: string;
  /** Provider stop reason, for the debug trail. */
  finish?: string;
  /** Explicit provider failure or unsupported terminal state; wins over text. */
  failed?: string;
};

/** Where parsing a model reply failed; recorded in the opt-in debug trail only. */
export class ModelParseError extends Error {
  constructor(
    readonly stage: 'envelope' | 'empty' | 'incomplete' | 'refused' | 'provider' | 'json' | 'validate',
    readonly issue?: string,
    readonly detail?: 'output-limit',
  ) {
    super(stage);
  }
}

export type Json = Record<string, unknown>;
export const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Recognize the specific JSON-mode prerequisite without exposing remote text to callers. */
export function isJsonModeInputError(message: unknown): boolean {
  return (
    typeof message === 'string' &&
    /\bmessages\s+must\s+contain\s+the\s+word\s+['"]json['"]/i.test(message) &&
    /\bjson_object\b/i.test(message)
  );
}

export function providerFailureCode(error: unknown): string {
  const record = obj(error);
  return isJsonModeInputError(record.message)
    ? 'json-mode-input-required'
    : (str(record.code) ?? str(record.type) ?? 'provider-error');
}

/** OpenAI-style content: a string, or an array of { type, text } parts (some proxies), or null. */
function contentText(content: unknown, accept: (type: string | undefined) => boolean): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .map(part => {
      const p = obj(part);
      const type = str(p.type);
      return accept(type) ? (str(p.text) ?? '') : '';
    })
    .join('');
}

function chatCompletions(raw: unknown): ModelReply {
  const choices = arr(obj(raw).choices);
  if (!choices.length) throw new ModelParseError('envelope', 'no choices');
  const choice = obj(
    choices.find(value => obj(value).index === 0) ?? choices.find(value => obj(value).index === undefined),
  );
  if (!Object.keys(choice).length) throw new ModelParseError('envelope', 'no selected choice');
  const message = obj(choice.message);
  const finish = str(choice.finish_reason);
  const text = contentText(message.content, type => type === undefined || type === 'text' || type === 'output_text');
  const refusal = str(message.refusal);
  return {
    text,
    finish,
    truncated: finish === 'length' || choice.finish_reason === null,
    refused: refusal || (finish === 'content_filter' ? 'content_filter' : undefined),
    failed: finish && !['stop', 'length', 'content_filter'].includes(finish) ? finish : undefined,
  };
}

/** Text of one content part, tolerating the shapes proxies emit ({text}, {text:{value}}, {value}, {json}). */
export function partText(part: Json): string {
  if (typeof part.text === 'string') return part.text;
  const nested = str(obj(part.text).value);
  if (nested !== undefined) return nested;
  if (typeof part.value === 'string') return part.value;
  if (typeof part.content === 'string') return part.content;
  if (part.json !== undefined && part.json !== null)
    return typeof part.json === 'string' ? part.json : JSON.stringify(part.json);
  return '';
}

const ANSWER_PARTS = new Set(['text', 'output_text', 'json']);

function responses(raw: unknown): ModelReply {
  const record = obj(raw);
  const status = str(record.status);
  const incomplete = str(obj(record.incomplete_details).reason);
  let text: string;
  let refused: string | undefined;
  let itemFailure: string | undefined;
  let itemIncomplete = false;
  {
    const texts: string[] = [];
    for (const item of arr(record.output)) {
      const entry = obj(item);
      // Reasoning items carry summaries, not the answer.
      if (entry.type !== undefined && entry.type !== 'message') continue;
      if (entry.role !== undefined && entry.role !== 'assistant') continue;
      const itemStatus = str(entry.status);
      if (itemStatus === 'incomplete') itemIncomplete = true;
      else if (itemStatus && itemStatus !== 'completed') itemFailure = itemStatus;
      if (typeof entry.content === 'string') texts.push(entry.content);
      for (const part of arr(entry.content)) {
        const p = obj(part);
        if (p.type === 'refusal') refused = str(p.refusal) ?? 'refusal';
        else if (p.type === undefined || ANSWER_PARTS.has(String(p.type))) texts.push(partText(p));
      }
      // Some gateways put the text straight on the message item.
      if (!arr(entry.content).length && typeof entry.text === 'string') texts.push(entry.text);
    }
    text = texts.join('');
  }
  if (!text.trim()) text = str(record.output_text) ?? '';
  if (!text.trim() && !refused && !arr(record.output).length && status === undefined)
    throw new ModelParseError('envelope', 'no output');
  return {
    text,
    finish: incomplete ?? status,
    truncated: status === 'incomplete' || itemIncomplete,
    refused,
    failed: itemFailure ?? (status && !['completed', 'incomplete'].includes(status) ? status : undefined),
  };
}

function anthropic(raw: unknown): ModelReply {
  const record = obj(raw);
  if (!Array.isArray(record.content)) throw new ModelParseError('envelope', 'no content');
  const finish = str(record.stop_reason);
  const text = arr(record.content)
    .map(block => {
      const b = obj(block);
      return b.type === 'text' ? (str(b.text) ?? '') : '';
    })
    .join('');
  return {
    text,
    finish,
    truncated: record.stop_reason === null || ['max_tokens', 'model_context_window_exceeded'].includes(finish ?? ''),
    refused: finish === 'refusal' ? 'refusal' : undefined,
    failed:
      finish &&
      !['end_turn', 'stop_sequence', 'max_tokens', 'model_context_window_exceeded', 'refusal'].includes(finish)
        ? finish
        : undefined,
  };
}

const GOOGLE_BLOCKS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE', 'OTHER']);
function google(raw: unknown): ModelReply {
  const record = obj(raw);
  const block = str(obj(record.promptFeedback).blockReason);
  if (block && block !== 'BLOCK_REASON_UNSPECIFIED')
    return { text: '', truncated: false, refused: `prompt ${block}`, finish: block };
  const candidates = arr(record.candidates);
  if (!candidates.length) {
    throw new ModelParseError('envelope', 'no candidates');
  }
  const candidate = obj(
    candidates.find(value => obj(value).index === 0) ?? candidates.find(value => obj(value).index === undefined),
  );
  if (!Object.keys(candidate).length) throw new ModelParseError('envelope', 'no selected candidate');
  const finish = str(candidate.finishReason);
  const text = arr(obj(candidate.content).parts)
    .map(part => {
      const p = obj(part);
      return p.thought === true ? '' : (str(p.text) ?? '');
    })
    .join('');
  return {
    text,
    finish,
    truncated: finish === 'MAX_TOKENS',
    refused: finish && GOOGLE_BLOCKS.has(finish) ? finish : undefined,
    failed: finish && finish !== 'STOP' && finish !== 'MAX_TOKENS' && !GOOGLE_BLOCKS.has(finish) ? finish : undefined,
  };
}

function ollama(raw: unknown): ModelReply {
  const record = obj(raw);
  const message = obj(record.message);
  if (typeof message.content !== 'string') throw new ModelParseError('envelope', 'no message');
  const finish = str(record.done_reason);
  return { text: message.content, finish, truncated: finish === 'length' };
}

export function readModelReply(adapter: ModelConfig['adapter'], raw: unknown): ModelReply {
  const record = obj(raw);
  if (record.error != null || record.type === 'error')
    return {
      text: '',
      truncated: false,
      failed: providerFailureCode(record.error),
    };
  switch (adapter) {
    case 'openai-responses':
      return responses(raw);
    case 'anthropic':
      return anthropic(raw);
    case 'google-generative-ai':
      return google(raw);
    case 'ollama':
      return ollama(raw);
    default:
      // openai-compatible and lm-studio
      return chatCompletions(raw);
  }
}

/** The answer text, or a ModelParseError that says why there is none. */
export function extractAssistantText(adapter: ModelConfig['adapter'], raw: unknown): string {
  return completedReplyText(readModelReply(adapter, raw));
}

/** Never parse usable-looking partial JSON before the provider outcome. */
export function completedReplyText(reply: ModelReply): string {
  // Some gateways label an incomplete snapshot response.completed. Keep rejecting it,
  // but preserve the actionable budget stop instead of hiding it behind the label mismatch.
  const budgetStop =
    reply.truncated && ['max_output_tokens', 'length', 'max_tokens', 'MAX_TOKENS'].includes(reply.finish ?? '');
  if (budgetStop && !reply.refused && (!reply.failed || reply.failed === 'contradictory-completion'))
    throw new ModelParseError('incomplete', `finish=${reply.finish}`, 'output-limit');
  if (reply.failed) throw new ModelParseError('provider', `finish=${reply.failed}`);
  if (reply.refused) throw new ModelParseError('refused', `${reply.refused}; finish=${reply.finish ?? '?'}`);
  if (reply.truncated) throw new ModelParseError('incomplete', `finish=${reply.finish ?? '?'}`);
  if (reply.text.trim()) return reply.text;
  throw new ModelParseError('empty', `finish=${reply.finish ?? '?'}`);
}

/** Top-level shape of a reply (keys and part types only, never values) for the debug trail. */
export function replyShape(raw: unknown): string {
  const record = obj(raw);
  const keys = Object.keys(record).slice(0, 8).join(',');
  const choice = obj(arr(record.choices)[0]);
  if (Object.keys(choice).length) return `{${keys}} message:{${Object.keys(obj(choice.message)).join(',')}}`;
  if (Array.isArray(record.output))
    return `{${keys}} status=${String(record.status ?? '?')} output=[${arr(record.output)
      .map(item => {
        const entry = obj(item);
        const parts = Array.isArray(entry.content)
          ? arr(entry.content)
              .map(part => {
                const p = obj(part);
                return `${String(p.type ?? '?')}{${Object.keys(p).join(',')}}len=${partText(p).length}`;
              })
              .join(';')
          : typeof entry.content;
        return `${String(entry.type ?? '?')}{${Object.keys(entry).join(',')}}(${parts})`;
      })
      .join(' + ')}]`;
  if (Array.isArray(record.content))
    return `{${keys}} content=[${arr(record.content)
      .map(item => String(obj(item).type ?? '?'))
      .join('+')}]`;
  return `{${keys}}`;
}
