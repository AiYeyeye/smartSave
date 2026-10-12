import { z } from 'zod';
import { parseModelListEndpoint, type ModelConfig } from '../domain/model-route';
import { curatedModelsForPreset } from '../domain/model-presets';
import { readModelResponse, MODEL_BYTE_LIMITS } from './model-byte-limits';
import { traceModel } from '../domain/debug-log';

export type ListModelsResult =
  { status: 'completed'; models: string[]; source: 'remote' | 'curated' } | { status: 'failed'; reason: string };

const openAiListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});
const ollamaListSchema = z.object({
  models: z.array(z.object({ name: z.string().min(1) })),
});
const anthropicListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

const googleListSchema = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1),
      displayName: z.string().optional(),
      supportedGenerationMethods: z.array(z.string()).optional(),
    }),
  ),
});

function authHeaders(adapter: ModelConfig['adapter'], key: string): Record<string, string> {
  if (adapter === 'anthropic') {
    return {
      ...(key ? { 'x-api-key': key } : {}),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }
  if (adapter === 'google-generative-ai') {
    return key ? { 'x-goog-api-key': key } : {};
  }
  // openai-compatible, openai-responses, lm-studio, ollama
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function parseIds(adapter: ModelConfig['adapter'], raw: unknown): string[] {
  if (adapter === 'ollama') return ollamaListSchema.parse(raw).models.map(m => m.name);
  if (adapter === 'anthropic') return anthropicListSchema.parse(raw).data.map(m => m.id);
  if (adapter === 'google-generative-ai') {
    // The list also contains embedding / TTS models; only generateContent models can classify bookmarks.
    return googleListSchema
      .parse(raw)
      .models.filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''));
  }
  return openAiListSchema.parse(raw).data.map(m => m.id);
}

/** Discover model IDs without requiring a selected model or bookmark tree. */
export async function listModels(input: Parameters<typeof listModelsInner>[0]): Promise<ListModelsResult> {
  const started = Date.now();
  let host = '';
  try {
    host = new URL(input.baseUrl).host;
  } catch {
    /* reported below */
  }
  traceModel('list-start', { adapter: input.adapter, host, hasKey: input.key.length > 0 });
  const result = await listModelsInner(input);
  traceModel('list-end', {
    adapter: input.adapter,
    host,
    status: result.status,
    reason: result.status === 'failed' ? result.reason : undefined,
    models: result.status === 'completed' ? result.models.length : undefined,
    ms: Date.now() - started,
  });
  return result;
}

async function listModelsInner(input: {
  adapter: ModelConfig['adapter'];
  baseUrl: string;
  timeoutMs: number;
  key: string;
  fetch: typeof fetch;
  contains: (request: { origins: string[] }) => Promise<boolean>;
  signal?: AbortSignal;
  /** When Anthropic list fails for non-auth reasons, return these curated IDs instead of failing. */
  curatedFallback?: readonly string[];
  presetId?: string;
}): Promise<ListModelsResult> {
  let route;
  try {
    route = parseModelListEndpoint({ adapter: input.adapter, baseUrl: input.baseUrl });
  } catch {
    return { status: 'failed', reason: 'invalid-endpoint' };
  }
  if (!(await input.contains({ origins: [route.permission] }))) return { status: 'failed', reason: 'permission' };

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  try {
    // Anthropic pages 20 models by default and Google 50; ask for one large page so nothing is cut off.
    const listUrl =
      input.adapter === 'anthropic'
        ? `${route.url}?limit=1000`
        : input.adapter === 'google-generative-ai'
          ? `${route.url}?pageSize=1000`
          : route.url;
    const response = await input.fetch(listUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...authHeaders(input.adapter, input.key),
      },
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (timedOut) return { status: 'failed', reason: 'timeout' };
    if (response.redirected || (response.url && response.url !== listUrl))
      return { status: 'failed', reason: 'redirect' };
    if (!response.ok) {
      const reason = [401, 403, 429].includes(response.status) ? `http-${response.status}` : 'http-error';
      if (
        (input.adapter === 'anthropic' || input.adapter === 'google-generative-ai') &&
        reason === 'http-error' &&
        (input.curatedFallback?.length || curatedModelsForPreset(input.presetId ?? '').length)
      ) {
        const fallbackPreset = input.adapter === 'google-generative-ai' ? 'gemini' : 'claude';
        const models = [...(input.curatedFallback ?? curatedModelsForPreset(input.presetId ?? fallbackPreset))];
        return { status: 'completed', models, source: 'curated' };
      }
      return { status: 'failed', reason };
    }
    const raw = await readModelResponse(response, MODEL_BYTE_LIMITS.responseBytes, controller.signal);
    const models = [...new Set(parseIds(input.adapter, raw))].sort();
    return { status: 'completed', models, source: 'remote' };
  } catch (error) {
    if (timedOut) return { status: 'failed', reason: 'timeout' };
    if (controller.signal.aborted) return { status: 'failed', reason: 'cancelled' };
    if (error instanceof Error && error.message === 'response-too-large')
      return { status: 'failed', reason: 'response-too-large' };
    if (input.adapter === 'anthropic' || input.adapter === 'google-generative-ai') {
      const fallbackPreset = input.adapter === 'google-generative-ai' ? 'gemini' : 'claude';
      const models = [...(input.curatedFallback ?? curatedModelsForPreset(input.presetId ?? fallbackPreset))];
      if (models.length) return { status: 'completed', models, source: 'curated' };
    }
    // Schema/parse failures mean the endpoint is not a supported list API.
    if (error instanceof z.ZodError) return { status: 'failed', reason: 'list-unsupported' };
    return { status: 'failed', reason: 'connection-or-configuration' };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
  }
}
