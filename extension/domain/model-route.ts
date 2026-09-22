import { z } from 'zod';
export const modelConfigSchema = z.strictObject({
  adapter: z.enum(['openai-compatible', 'ollama', 'lm-studio']),
  baseUrl: z.string().min(1),
  model: z.string().trim().min(1),
  timeoutMs: z.number().int().positive().max(2147483647),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export function parseModelEndpoint(input: ModelConfig) {
  try {
    const config = modelConfigSchema.parse(input);
    const base = new URL(config.baseUrl);
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
    // A base already ending in /v1 keeps its identity (saved credentials stay bound) and only gains /chat/completions.
    const suffix =
      config.adapter === 'ollama' ? '/api/chat' : path.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions';
    return {
      identity: JSON.stringify([config.adapter, base.origin, path]),
      url: `${base.origin}${path}${suffix}`,
      origin: base.origin,
      permission: `${base.protocol}//${base.hostname}/*`,
    };
  } catch {
    throw Error('invalid-endpoint');
  }
}
