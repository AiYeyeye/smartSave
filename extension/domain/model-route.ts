import { z } from 'zod';

export const modelAdapterSchema = z.enum([
  'openai-compatible',
  'openai-responses',
  'anthropic',
  'google-generative-ai',
  'ollama',
  'lm-studio',
]);
export type ModelAdapter = z.infer<typeof modelAdapterSchema>;
export const maxOutputTokensSchema = z.number().int().positive();

/** How hard a reasoning model may think. 'default' sends nothing and leaves the model's own default. */
export const REASONING_EFFORTS = ['low', 'none', 'medium', 'high', 'default'] as const;
export const reasoningEffortSchema = z.enum(REASONING_EFFORTS);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';
export const modelConfigSchema = z.strictObject({
  adapter: modelAdapterSchema,
  baseUrl: z.string().min(1),
  model: z.string().trim().min(1),
  timeoutMs: z.number().int().positive().max(2147483647),
  streaming: z.boolean().optional(),
  fastMode: z.boolean().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  maxOutputTokens: maxOutputTokensSchema.optional(),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

/** Application output budget, shared by request generation and user-facing diagnostics. */
export function modelOutputTokenLimit(
  config: Pick<ModelConfig, 'adapter' | 'model' | 'maxOutputTokens'>,
): number | undefined {
  if (!['openai-compatible', 'openai-responses', 'anthropic', 'google-generative-ai'].includes(config.adapter))
    return undefined;
  if (config.maxOutputTokens !== undefined) return config.maxOutputTokens;
  // Optional on Chat, Responses and Gemini: let the selected model choose its supported default.
  if (config.adapter !== 'anthropic') return undefined;
  // Messages requires max_tokens. Known Claude limits, otherwise a conservative compatible fallback.
  if (/^claude-(?:(?:opus|sonnet|haiku)-5-5|fable-5-1)(?:-|$)/.test(config.model)) return 128000;
  if (/^claude-(?:sonnet-4(?:-5)?|haiku-4-5)(?:-|$)/.test(config.model)) return 64000;
  if (/^claude-opus-4(?:-1)?(?:-|$)/.test(config.model)) return 32000;
  return 4096;
}

export type ModelEndpointKind = 'chat' | 'models';

/** Resolve at use time; never inject defaults into persisted settings/freshness identities. */
export function modelStreaming(config: Pick<ModelConfig, 'adapter' | 'streaming'>): boolean {
  if (config.adapter === 'ollama') return false;
  return (
    config.streaming ??
    ['openai-compatible', 'openai-responses', 'anthropic', 'google-generative-ai'].includes(config.adapter)
  );
}

function parseBase(baseUrl: string) {
  const base = new URL(baseUrl);
  const loopback =
    base.hostname === 'localhost' || base.hostname === '[::1]' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(base.hostname);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))
  )
    throw Error();
  const path = base.pathname.replace(/\/+$/, '');
  return { base, path, origin: base.origin, permission: `${base.protocol}//${base.hostname}/*` };
}

/**
 * Bases that already include an API version (…/v1, …/v3, …/v4, …/openai) only gain the resource path.
 * Other OpenAI-compatible bases still receive `/v1/…` so `/v1` is never duplicated when already present.
 */
export function pathAlreadyVersioned(path: string): boolean {
  return /\/v\d+$/i.test(path) || /\/openai$/i.test(path);
}

/** Shared join: a base already ending in a version segment only gains the resource path once. */
export function modelResourceSuffix(
  adapter: ModelAdapter,
  path: string,
  kind: ModelEndpointKind,
  model?: string,
): string {
  if (adapter === 'ollama') return kind === 'chat' ? '/api/chat' : '/api/tags';
  if (adapter === 'anthropic') {
    if (kind === 'chat') return path.endsWith('/v1') || /\/v\d+$/i.test(path) ? '/messages' : '/v1/messages';
    return path.endsWith('/v1') || /\/v\d+$/i.test(path) ? '/models' : '/v1/models';
  }
  if (adapter === 'google-generative-ai') {
    // Native Generative Language API: bare host gets /v1beta; model id is in the generateContent path.
    if (kind === 'models') return path ? '/models' : '/v1beta/models';
    const modelId = (model ?? '').trim().replace(/^models\//, '');
    if (!modelId) throw Error();
    const encoded = encodeURIComponent(modelId);
    return path ? `/models/${encoded}:generateContent` : `/v1beta/models/${encoded}:generateContent`;
  }
  if (adapter === 'openai-responses') {
    if (pathAlreadyVersioned(path)) return kind === 'chat' ? '/responses' : '/models';
    return kind === 'chat' ? '/v1/responses' : '/v1/models';
  }
  // openai-compatible + lm-studio
  if (pathAlreadyVersioned(path)) return kind === 'chat' ? '/chat/completions' : '/models';
  return kind === 'chat' ? '/v1/chat/completions' : '/v1/models';
}

export function parseModelEndpoint(input: ModelConfig, kind: ModelEndpointKind = 'chat') {
  try {
    const config = modelConfigSchema.parse(input);
    const { base, path, origin, permission } = parseBase(config.baseUrl);
    const suffix = modelResourceSuffix(config.adapter, path, kind, config.model);
    const resource =
      config.adapter === 'google-generative-ai' && kind === 'chat' && modelStreaming(config)
        ? suffix.replace(':generateContent', ':streamGenerateContent?alt=sse')
        : suffix;
    return {
      identity: JSON.stringify([config.adapter, base.origin, path]),
      url: `${origin}${path}${resource}`,
      origin,
      permission,
    };
  } catch {
    throw Error('invalid-endpoint');
  }
}

/** List/discovery uses the same base validation and /v1 join rules as chat; model id is not required. */
export function parseModelListEndpoint(input: Pick<ModelConfig, 'adapter' | 'baseUrl'>) {
  try {
    const adapter = modelAdapterSchema.parse(input.adapter);
    const { base, path, origin, permission } = parseBase(input.baseUrl);
    const suffix = modelResourceSuffix(adapter, path, 'models');
    return {
      identity: JSON.stringify([adapter, base.origin, path]),
      url: `${origin}${path}${suffix}`,
      origin,
      permission,
    };
  } catch {
    throw Error('invalid-endpoint');
  }
}
