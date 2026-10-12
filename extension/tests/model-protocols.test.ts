import { describe, expect, it } from 'vitest';
import { extractAssistantText, readModelReply } from '../adapters/model-replies';
import { modelRequestBody } from '../adapters/model-transport';
import { parseModelEndpoint, parseModelListEndpoint, type ModelConfig } from '../domain/model-route';

const ANSWER = '{"rankedIds":["a"]}';
const config = (adapter: ModelConfig['adapter'], baseUrl: string, model = 'm'): ModelConfig => ({
  adapter,
  baseUrl,
  model,
  timeoutMs: 1000,
});

describe('request side: endpoint, JSON mode and output budget per protocol', () => {
  it('OpenAI Chat Completions: /v1/chat/completions, messages[], response_format json_object', () => {
    const c = config('openai-compatible', 'https://api.openai.com/v1');
    expect(parseModelEndpoint(c).url).toBe('https://api.openai.com/v1/chat/completions');
    expect(parseModelListEndpoint(c).url).toBe('https://api.openai.com/v1/models');
    const body = JSON.parse(modelRequestBody(c, 'search', '{}'));
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
  it('OpenAI Responses: /v1/responses, instructions + input, text.format json_object, max_output_tokens', () => {
    const c = config('openai-responses', 'https://api.openai.com/v1');
    expect(parseModelEndpoint(c).url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(modelRequestBody(c, 'search', '{}'));
    expect(body).toMatchObject({ text: { format: { type: 'json_object' } }, input: '{}' });
    expect(body.instructions).toContain('JSON');
    expect(body.max_output_tokens).toBeGreaterThanOrEqual(8000);
    expect(body.messages).toBeUndefined();
  });
  it('Anthropic Messages: /v1/messages, top-level system, max_tokens, no response_format', () => {
    const c = config('anthropic', 'https://api.anthropic.com');
    expect(parseModelEndpoint(c).url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(modelRequestBody(c, 'search', '{}'));
    expect(body.system).toContain('JSON');
    expect(body.max_tokens).toBeGreaterThanOrEqual(8192);
    expect(body.response_format).toBeUndefined();
  });
  it('Google Generative AI: model in the URL path, systemInstruction, responseMimeType application/json', () => {
    const c = config('google-generative-ai', 'https://generativelanguage.googleapis.com', 'gemini-2.5-flash');
    expect(parseModelEndpoint(c).url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    const body = JSON.parse(modelRequestBody(c, 'search', '{}'));
    expect(body.generationConfig).toEqual({ responseMimeType: 'application/json' });
    expect(body.systemInstruction.parts[0].text).toContain('JSON');
    expect(body.model).toBeUndefined();
  });
});

describe('reply side: where the answer text lives per protocol', () => {
  it('Chat Completions: string content, part arrays, refusal and length', () => {
    expect(extractAssistantText('openai-compatible', { choices: [{ message: { content: ANSWER } }] })).toBe(ANSWER);
    expect(
      extractAssistantText('openai-compatible', {
        choices: [{ message: { content: [{ type: 'text', text: ANSWER }] } }],
      }),
    ).toBe(ANSWER);
    expect(() =>
      extractAssistantText('openai-compatible', {
        choices: [{ message: { content: null, refusal: 'I cannot help' }, finish_reason: 'stop' }],
      }),
    ).toThrow('refused');
    expect(() =>
      extractAssistantText('openai-compatible', {
        choices: [{ message: { content: '', reasoning_content: '…' }, finish_reason: 'length' }],
      }),
    ).toThrow('incomplete');
    expect(
      readModelReply('openai-compatible', { choices: [{ message: { content: '{"a' }, finish_reason: 'length' }] }),
    ).toMatchObject({ truncated: true });
  });

  it('Responses: raw output[] without output_text, reasoning items skipped, refusal parts, incomplete', () => {
    const raw = {
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking about folders' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ANSWER, annotations: [] }] },
      ],
    };
    expect(extractAssistantText('openai-responses', raw)).toBe(ANSWER);
    expect(extractAssistantText('openai-responses', { output_text: ANSWER, output: [] })).toBe(ANSWER);
    expect(() =>
      extractAssistantText('openai-responses', {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
      }),
    ).toThrow('refused');
    expect(() =>
      extractAssistantText('openai-responses', {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'reasoning', summary: [] }],
      }),
    ).toThrow('incomplete');
  });

  it('Anthropic: text blocks only (thinking skipped), max_tokens and refusal stop reasons', () => {
    const raw = {
      type: 'message',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'x' },
        { type: 'text', text: ANSWER },
      ],
      stop_reason: 'end_turn',
    };
    expect(extractAssistantText('anthropic', raw)).toBe(ANSWER);
    expect(
      readModelReply('anthropic', { content: [{ type: 'text', text: '{"rank' }], stop_reason: 'max_tokens' }),
    ).toMatchObject({ truncated: true });
    expect(() => extractAssistantText('anthropic', { content: [], stop_reason: 'refusal' })).toThrow('refused');
  });

  it('Google: parts text without thought parts, MAX_TOKENS, safety finish and prompt blocks', () => {
    const raw = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'plan…', thought: true }, { text: ANSWER }] },
          finishReason: 'STOP',
        },
      ],
    };
    expect(extractAssistantText('google-generative-ai', raw)).toBe(ANSWER);
    expect(() =>
      extractAssistantText('google-generative-ai', {
        candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
      }),
    ).toThrow('refused');
    expect(() =>
      extractAssistantText('google-generative-ai', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }),
    ).toThrow('refused');
    expect(() =>
      extractAssistantText('google-generative-ai', {
        candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
      }),
    ).toThrow('incomplete');
  });
});
