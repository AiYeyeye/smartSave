import { z } from 'zod';

export const modelAdapterSchema = z.enum(['openai-compatible', 'ollama', 'lm-studio', 'anthropic']);
export type ModelAdapter = z.infer<typeof modelAdapterSchema>;

export const modelConfigSchema = z.strictObject({
  adapter: modelAdapterSchema,
  baseUrl: z.string().min(1),
  model: z.string().trim().min(1),
  timeoutMs: z.number().int().positive().max(2147483647),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export type ModelEndpointKind = 'chat' | 'models';

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
export function modelResourceSuffix(adapter: ModelAdapter, path: string, kind: ModelEndpointKind): string {
  if (adapter === 'ollama') return kind === 'chat' ? '/api/chat' : '/api/tags';
  if (adapter === 'anthropic') {
    if (kind === 'chat') return path.endsWith('/v1') || /\/v\d+$/i.test(path) ? '/messages' : '/v1/messages';
    return path.endsWith('/v1') || /\/v\d+$/i.test(path) ? '/models' : '/v1/models';
  }
  // openai-compatible + lm-studio
  if (pathAlreadyVersioned(path)) return kind === 'chat' ? '/chat/completions' : '/models';
  return kind === 'chat' ? '/v1/chat/completions' : '/v1/models';
}

export function parseModelEndpoint(input: ModelConfig, kind: ModelEndpointKind = 'chat') {
  try {
    const config = modelConfigSchema.parse(input);
    const { base, path, origin, permission } = parseBase(config.baseUrl);
    const suffix = modelResourceSuffix(config.adapter, path, kind);
    return {
      identity: JSON.stringify([config.adapter, base.origin, path]),
      url: `${origin}${path}${suffix}`,
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
