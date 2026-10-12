import { parseModelEndpoint, type ModelConfig } from '../domain/model-route';
import type { ModelAuthority } from './model-authority';
import { readModelResponse, MODEL_BYTE_LIMITS } from './model-byte-limits';
import { serializeAiPayload, type AiPrivacy, type AiRequest } from '../domain/ai-payload';
import {
  classificationPolicySchema,
  DEFAULT_CLASSIFICATION_POLICY,
  type ClassificationPolicy,
} from '../domain/classification-policy';
import { modelSystemPrompt } from '../domain/model-prompts';
import { dependencyDigest, settingsIdentity } from '../domain/context-dependencies';
import type { TreeSnapshot } from '../domain/node-reference';
import {
  modelOutputJsonSchema,
  outputSchema,
  parseModelOutput,
  type ModelOutputContext,
} from '../schemas/model-output';
import { z } from 'zod';
import { traceModel } from '../domain/debug-log';
export { parseModelEndpoint, parseModelListEndpoint } from '../domain/model-route';
export type ModelResult =
  | { status: 'completed'; output: ReturnType<typeof parseModelOutput> }
  | { status: 'failed' | 'cancelled'; reason: string };
interface ModelBoundary {
  fetch: typeof fetch;
  contains: (request: { origins: string[] }) => Promise<boolean>;
}
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MAX_TOKENS = 4096;

function requestHeaders(adapter: ModelConfig['adapter'], key: string): Record<string, string> {
  if (adapter === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      ...(key ? { 'x-api-key': key } : {}),
    };
  }
  if (adapter === 'google-generative-ai') {
    return {
      'Content-Type': 'application/json',
      ...(key ? { 'x-goog-api-key': key } : {}),
    };
  }
  // openai-compatible, openai-responses, ollama, lm-studio
  return {
    'Content-Type': 'application/json',
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
}

/** Shared final adapter envelope: local planning and fetch measure identical bytes. */
export function modelRequestBody(
  config: ModelConfig,
  task: AiRequest['task'],
  payload: string,
  policy: ClassificationPolicy = DEFAULT_CLASSIFICATION_POLICY,
): string {
  const schema = modelOutputJsonSchema(task);
  const system = `${modelSystemPrompt(task, classificationPolicySchema.parse(policy))} Output schema: ${JSON.stringify(schema)}`;
  if (config.adapter === 'anthropic') {
    // Native Messages API: system is top-level; no chat/completions response_format; JSON via schema in system.
    return JSON.stringify({
      model: config.model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      stream: false,
      system,
      messages: [{ role: 'user', content: payload }],
    });
  }
  if (config.adapter === 'openai-responses') {
    // OpenAI Responses: instructions + input (not messages); POST …/responses.
    return JSON.stringify({
      model: config.model,
      stream: false,
      instructions: system,
      input: payload,
      text: { format: { type: 'json_object' } },
    });
  }
  if (config.adapter === 'google-generative-ai') {
    // Google Generative AI: contents + systemInstruction; model is in the URL path.
    return JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: payload }] }],
      generationConfig: { responseMimeType: 'application/json' },
    });
  }
  return JSON.stringify({
    model: config.model,
    stream: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: payload },
    ],
    ...(config.adapter === 'ollama'
      ? { format: schema }
      : config.adapter === 'lm-studio'
        ? { response_format: { type: 'json_schema', json_schema: { name: 'bookmark_proposal', strict: true, schema } } }
        : { response_format: { type: 'json_object' } }),
  });
}

function extractAssistantText(adapter: ModelConfig['adapter'], raw: unknown): string {
  if (adapter === 'ollama') {
    return z.object({ message: z.object({ content: z.string() }) }).parse(raw).message.content;
  }
  if (adapter === 'anthropic') {
    const blocks = z
      .object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })).min(1) })
      .parse(raw).content;
    const text = blocks
      .filter(block => block.type === 'text' && block.text)
      .map(block => block.text!)
      .join('');
    if (!text) throw Error('schema');
    return text;
  }
  if (adapter === 'openai-responses') {
    const parsed = z
      .object({
        output_text: z.string().optional(),
        output: z
          .array(
            z.object({
              type: z.string().optional(),
              content: z.array(z.object({ type: z.string().optional(), text: z.string().optional() })).optional(),
            }),
          )
          .optional(),
      })
      .parse(raw);
    if (parsed.output_text?.trim()) return parsed.output_text;
    const text = (parsed.output ?? [])
      .flatMap(item => item.content ?? [])
      .filter(part => (part.type === 'output_text' || part.type === 'text') && part.text)
      .map(part => part.text!)
      .join('');
    if (!text) throw Error('schema');
    return text;
  }
  if (adapter === 'google-generative-ai') {
    const parts = z
      .object({
        candidates: z
          .array(
            z.object({
              content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }).optional(),
            }),
          )
          .min(1),
      })
      .parse(raw).candidates[0]!.content?.parts;
    const text = (parts ?? []).map(part => part.text ?? '').join('');
    if (!text) throw Error('schema');
    return text;
  }
  // OpenAI-compatible proxies differ: content may be a string, an array of text parts, or null (reasoning-only).
  const content = z
    .object({
      choices: z
        .array(
          z.object({
            message: z.object({
              content: z
                .union([z.string(), z.array(z.object({ type: z.string().optional(), text: z.string().optional() }))])
                .nullable()
                .optional(),
            }),
          }),
        )
        .min(1),
    })
    .parse(raw).choices[0]!.message.content;
  const text = Array.isArray(content) ? content.map(part => part.text ?? '').join('') : (content ?? '');
  if (!text.trim()) throw new ModelParseError('empty');
  return text;
}

/** Where parsing a model reply failed; recorded in the opt-in debug trail only. */
export class ModelParseError extends Error {
  constructor(
    readonly stage: 'envelope' | 'empty' | 'json' | 'validate',
    readonly issue?: string,
  ) {
    super(stage);
  }
}

/**
 * Pulls the JSON object out of an assistant reply. Models and proxies often wrap it in ```json fences,
 * prepend a sentence, or include <think> blocks even when asked for bare JSON.
 */
export function extractJsonObject(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* try the tolerant forms below */
  }
  const fence = cleaned.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]!.trim());
    } catch {
      /* fall through */
    }
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  throw new ModelParseError('json');
}

const ID_KEYS = new Set(['id', 'parentId', 'itemId', 'folderId', 'sourceId', 'targetId']);
const ID_ARRAYS = new Set(['rankedIds', 'urlPath', 'titlePath']);
/** Commentary keys models add despite instructions; harmless, so dropped before the strict schema check. */
const COMMENTARY_KEYS = new Set(['reason', 'reasoning', 'rationale', 'confidence', 'explanation', 'note', 'notes']);

/**
 * Normalizes cosmetic deviations before strict validation: numeric ids become strings (ids are numeric
 * in Chrome, so models often drop the quotes), commentary keys are dropped, and empty optional arrays are
 * filled in. Anything else unexpected (e.g. a url key) still fails the strict schema.
 */
export function normalizeModelJson(value: unknown, task: string): unknown {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (COMMENTARY_KEYS.has(key)) continue;
      if (ID_KEYS.has(key) && typeof child === 'number') out[key] = String(child);
      else if (ID_ARRAYS.has(key) && Array.isArray(child))
        out[key] = child.map(item => (typeof item === 'number' ? String(item) : item));
      else out[key] = visit(child);
    }
    return out;
  };
  const normalized = visit(value);
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    const record = normalized as Record<string, unknown>;
    if ((task === 'save' || task === 'import-classify' || task === 'organize') && record.newFolders === undefined)
      record.newFolders = [];
    if (task === 'organize' && record.merges === undefined) record.merges = [];
    if (task === 'organize' && record.moves === undefined) record.moves = [];
  }
  return normalized;
}

function zodIssue(task: string, value: unknown): string {
  const result = outputSchema(task).safeParse(value);
  if (result.success) return 'ids-or-structure-rejected';
  const first = result.error.issues[0];
  return first ? `${first.path.join('.') || '(root)'}: ${first.code}` : 'schema';
}

export class ModelTransport {
  private generation = 0;
  private active?: AbortController;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly boundary: ModelBoundary,
    private readonly authority: ModelAuthority,
    private readonly limits = MODEL_BYTE_LIMITS,
  ) {
    // Tree changes are judged per request against its dependency scope in run(); settings/permission changes cancel outright.
    this.unsubscribe = authority.subscribe(change => {
      if (change !== 'tree') this.cancel();
    });
  }
  dispose() {
    this.cancel();
    this.unsubscribe();
  }
  cancel() {
    this.generation++;
    this.active?.abort();
    this.active = undefined;
  }
  fits(input: {
    config: ModelConfig;
    tree: TreeSnapshot;
    privacy: AiPrivacy;
    request: AiRequest;
    policy?: ClassificationPolicy;
  }): boolean {
    return (
      new TextEncoder().encode(
        modelRequestBody(
          input.config,
          input.request.task,
          serializeAiPayload(input.tree, input.privacy, input.request),
          input.policy,
        ),
      ).byteLength <= this.limits.requestBytes
    );
  }
  private lastHttpStatus?: number;
  async run(input: {
    config: ModelConfig;
    key: string;
    tree: TreeSnapshot;
    privacy: AiPrivacy;
    request: AiRequest;
    policy?: ClassificationPolicy;
  }): Promise<ModelResult> {
    const started = Date.now();
    let host = '';
    try {
      host = new URL(input.config.baseUrl).host;
    } catch {
      /* invalid base URL is reported by the call itself */
    }
    const route = { task: input.request.task, adapter: input.config.adapter, model: input.config.model, host };
    traceModel('call-start', { ...route, hasKey: input.key.length > 0 });
    this.lastHttpStatus = undefined;
    const result = await this.runInner(input);
    traceModel('call-end', {
      ...route,
      status: result.status,
      reason: result.status === 'completed' ? undefined : result.reason,
      httpStatus: this.lastHttpStatus,
      ms: Date.now() - started,
    });
    return result;
  }
  private async runInner(input: {
    config: ModelConfig;
    key: string;
    tree: TreeSnapshot;
    privacy: AiPrivacy;
    request: AiRequest;
    policy?: ClassificationPolicy;
  }): Promise<ModelResult> {
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.active = controller;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const frozen = structuredClone(input);
      // Freshness is scoped to what this request depends on: unrelated bookmark changes never invalidate it.
      const dependencies = dependencyDigest(frozen.tree, frozen.request);
      const settings = settingsIdentity(frozen);
      const same = (current: Awaited<ReturnType<ModelAuthority['read']>>) =>
        current.tree.installationId === frozen.tree.installationId &&
        dependencyDigest(current.tree, frozen.request) === dependencies &&
        settingsIdentity(current) === settings &&
        current.key === frozen.key;
      if (!same(await this.authority.read())) return { status: 'failed', reason: 'stale-context' };
      const fresh = async () => same(await this.authority.read());
      const route = parseModelEndpoint(frozen.config);
      const payload = serializeAiPayload(frozen.tree, frozen.privacy, frozen.request);
      const policy = frozen.policy ?? DEFAULT_CLASSIFICATION_POLICY;
      // The output validator receives the same policy as the prompt plus the target/scope root; search has no root.
      const context: ModelOutputContext = {
        ...JSON.parse(payload),
        policy,
        ...(frozen.request.task === 'search'
          ? {}
          : { rootId: frozen.request.task === 'organize' ? frozen.request.rootId : frozen.request.targetId }),
      };
      if (!(await this.boundary.contains({ origins: [route.permission] })))
        return { status: 'failed', reason: 'permission' };
      if (!(await fresh())) return { status: 'failed', reason: 'stale-context' };
      if (generation !== this.generation) return { status: 'cancelled', reason: 'cancelled' };
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, frozen.config.timeoutMs);
      const body = modelRequestBody(frozen.config, frozen.request.task, payload, policy);
      if (new TextEncoder().encode(body).byteLength > this.limits.requestBytes)
        return { status: 'failed', reason: 'payload-too-large' };
      const cancelled = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
      });
      const response = await Promise.race([
        cancelled,
        this.boundary.fetch(route.url, {
          method: 'POST',
          headers: requestHeaders(frozen.config.adapter, frozen.key),
          body,
          signal: controller.signal,
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        }),
      ]);
      if (timedOut) return { status: 'failed', reason: 'timeout' };
      this.lastHttpStatus = response.status;
      if (generation !== this.generation) return { status: 'cancelled', reason: 'cancelled' };
      if (response.redirected || (response.url && response.url !== route.url))
        return { status: 'failed', reason: 'redirect' };
      if (!response.ok)
        return {
          status: 'failed',
          reason: [401, 403, 429].includes(response.status) ? `http-${response.status}` : 'http-error',
        };
      let raw: unknown;
      try {
        raw = await Promise.race([
          cancelled,
          readModelResponse(response, this.limits.responseBytes, controller.signal),
        ]);
      } catch (error) {
        if (error instanceof Error && error.message === 'response-too-large')
          return { status: 'failed', reason: 'response-too-large' };
        return timedOut
          ? { status: 'failed', reason: 'timeout' }
          : controller.signal.aborted
            ? { status: 'cancelled', reason: 'cancelled' }
            : { status: 'failed', reason: 'schema' };
      }
      if (timedOut) return { status: 'failed', reason: 'timeout' };
      if (generation !== this.generation || controller.signal.aborted)
        return { status: 'cancelled', reason: 'cancelled' };
      if (!(await this.boundary.contains({ origins: [route.permission] })))
        return { status: 'failed', reason: 'permission' };
      if (generation !== this.generation) return { status: 'cancelled', reason: 'cancelled' };
      if (!(await fresh())) return { status: 'failed', reason: 'stale-context' };
      if (generation !== this.generation) return { status: 'cancelled', reason: 'cancelled' };
      let text = '';
      try {
        try {
          text = extractAssistantText(frozen.config.adapter, raw);
        } catch (error) {
          throw error instanceof ModelParseError ? error : new ModelParseError('envelope');
        }
        const value = normalizeModelJson(extractJsonObject(text), frozen.request.task);
        try {
          return { status: 'completed', output: parseModelOutput(value, context) };
        } catch {
          throw new ModelParseError('validate', zodIssue(frozen.request.task, value));
        }
      } catch (error) {
        const parse = error instanceof ModelParseError ? error : new ModelParseError('json');
        traceModel('parse-failed', {
          task: frozen.request.task,
          stage: parse.stage,
          issue: parse.issue,
          chars: text.length,
          // Opt-in local trail only: the start of the reply is the fastest way to see what the model sent back.
          head: text ? text.slice(0, 160) : rawShape(raw),
        });
        return { status: 'failed', reason: 'schema' };
      }
    } catch {
      return timedOut
        ? { status: 'failed', reason: 'timeout' }
        : generation !== this.generation
          ? { status: 'cancelled', reason: 'cancelled' }
          : { status: 'failed', reason: 'connection-or-configuration' };
    } finally {
      clearTimeout(timer);
      if (generation === this.generation) this.active = undefined;
    }
  }
}

/** Top-level shape of an unparseable envelope (keys only, no values). */
function rawShape(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return typeof raw;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, 8).join(',');
  const choice = Array.isArray(record.choices) ? (record.choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  return message ? `{${keys}} message:{${Object.keys(message).join(',')}}` : `{${keys}}`;
}
