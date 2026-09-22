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
import type { TreeSnapshot } from '../domain/node-reference';
import { modelOutputJsonSchema, parseModelOutput, type ModelOutputContext } from '../schemas/model-output';
import { z } from 'zod';
export { parseModelEndpoint } from '../domain/model-route';
export type ModelResult =
  | { status: 'completed'; output: ReturnType<typeof parseModelOutput> }
  | { status: 'failed' | 'cancelled'; reason: string };
interface ModelBoundary {
  fetch: typeof fetch;
  contains: (request: { origins: string[] }) => Promise<boolean>;
}
/** Shared final adapter envelope: local planning and fetch measure identical bytes. */
export function modelRequestBody(
  config: ModelConfig,
  task: AiRequest['task'],
  payload: string,
  policy: ClassificationPolicy = DEFAULT_CLASSIFICATION_POLICY,
): string {
  const schema = modelOutputJsonSchema(task);
  return JSON.stringify({
    model: config.model,
    stream: false,
    messages: [
      {
        role: 'system',
        content: `${modelSystemPrompt(task, classificationPolicySchema.parse(policy))} Output schema: ${JSON.stringify(schema)}`,
      },
      { role: 'user', content: payload },
    ],
    ...(config.adapter === 'ollama'
      ? { format: schema }
      : config.adapter === 'lm-studio'
        ? { response_format: { type: 'json_schema', json_schema: { name: 'bookmark_proposal', strict: true, schema } } }
        : { response_format: { type: 'json_object' } }),
  });
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
    this.unsubscribe = authority.subscribe(() => this.cancel());
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
  async run(input: {
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
      const current = await this.authority.read();
      const stamp = JSON.stringify(current);
      if (
        JSON.stringify(current.config) !== JSON.stringify(frozen.config) ||
        current.key !== frozen.key ||
        JSON.stringify(current.privacy) !== JSON.stringify(frozen.privacy) ||
        JSON.stringify(current.tree) !== JSON.stringify(frozen.tree)
      )
        return { status: 'failed', reason: 'stale-context' };
      const fresh = async () => stamp === JSON.stringify(await this.authority.read());
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
          headers: {
            'Content-Type': 'application/json',
            ...(frozen.key ? { Authorization: `Bearer ${frozen.key}` } : {}),
          },
          body,
          signal: controller.signal,
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        }),
      ]);
      if (timedOut) return { status: 'failed', reason: 'timeout' };
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
      try {
        const text =
          frozen.config.adapter === 'ollama'
            ? z.object({ message: z.object({ content: z.string() }) }).parse(raw).message.content
            : z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) }).parse(raw)
                .choices[0]!.message.content;
        return { status: 'completed', output: parseModelOutput(JSON.parse(text), context) };
      } catch {
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
