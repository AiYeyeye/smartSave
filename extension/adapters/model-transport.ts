import { modelOutputTokenLimit, modelStreaming, parseModelEndpoint, type ModelConfig } from '../domain/model-route';
import type { ModelAuthority } from './model-authority';
import { readModelText, MODEL_BYTE_LIMITS, ModelResponseReadError, type ModelBodyObserver } from './model-byte-limits';
import { compactAiPayload, serializeAiPayload, type AiPrivacy, type AiRequest } from '../domain/ai-payload';
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
  ModelOutputValidationError,
  parseModelOutput,
  type ModelOutputContext,
} from '../schemas/model-output';
import { modelBodyDiagnostics, modelDiagnosticLog } from './model-diagnostics';
import { completedReplyText, isJsonModeInputError, ModelParseError, replyShape } from './model-replies';
import { readWireReply, type ModelStreamProgress } from './model-stream';
import type { ModelTiming } from '../domain/save-performance';
import { modelThinkingPlan, rejectsThinkingParameter } from '../domain/model-thinking';
import {
  chatOutputTokenField,
  officialModelProvider,
  supportsApiJsonMode,
  supportsStreamUsage,
} from '../domain/model-provider';
import { abortableDelay } from '../domain/cancellable';
import { anthropicPromptContent } from '../domain/model-cache';
import { analyzeOrganizeRepair, type OrganizeRepair } from '../domain/organize-partial-repair';
import { tokenUsageAccumulator, type TokenUsageRecord, type TokenPurpose } from '../domain/token-usage';
import { recordTokenUsage } from '../persistence/token-usage';
import { browserPersonalizationStore } from '../persistence/personalization';
import { preferenceUpdatePlan } from '../domain/preference-update';
import { searchScope } from '../domain/search-scope';
import {
  emptyPersonalization,
  preferenceHints,
  preferenceUsable,
  type PreferenceScope,
} from '../domain/personalization';
export type ModelProgress = ModelStreamProgress & {
  phase: 'waiting' | 'receiving' | 'validating';
  retry?: { attempt: number; delaySeconds: number; httpStatus: number };
};
export { parseModelEndpoint, parseModelListEndpoint } from '../domain/model-route';
export type ModelResult =
  | { status: 'completed'; output: ReturnType<typeof parseModelOutput> }
  | { status: 'repairable'; reason: 'partial-invalid-targets'; repair: OrganizeRepair; detail?: never }
  | { status: 'failed' | 'cancelled'; reason: string; detail?: 'output-limit' };
interface ModelBoundary {
  fetch: typeof fetch;
  contains: (request: { origins: string[] }) => Promise<boolean>;
}
const ANTHROPIC_VERSION = '2023-06-01';
let modelCallSequence = 0;
const unsupportedThinking = new Map<string, number>();

function requestHeaders(adapter: ModelConfig['adapter'], key: string): Record<string, string> {
  if (adapter === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      // Requests from extension pages / workers carry an Origin; Anthropic requires this opt-in for them.
      'anthropic-dangerous-direct-browser-access': 'true',
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
  /** Ask for JSON through the API's own switch; off for the one retry after an empty reply. */
  jsonMode = true,
  includeUsage = true,
): string {
  payload = compactAiPayload(payload);
  jsonMode = jsonMode && supportsApiJsonMode(config);
  const thinking = modelThinkingPlan(config);
  const schema = modelOutputJsonSchema(task);
  const system = `${modelSystemPrompt(task, classificationPolicySchema.parse(policy))} Output schema: ${JSON.stringify(schema)}`;
  if (config.adapter === 'anthropic') {
    // Native Messages API: system is top-level; no chat/completions response_format; JSON via schema in system.
    return JSON.stringify({
      model: config.model,
      max_tokens: modelOutputTokenLimit(config),
      stream: modelStreaming(config),
      system,
      messages: [{ role: 'user', content: anthropicPromptContent(config, payload) }],
    });
  }
  if (config.adapter === 'openai-responses') {
    // OpenAI Responses: instructions + input (not messages); POST …/responses.
    return JSON.stringify({
      model: config.model,
      stream: modelStreaming(config),
      instructions: system,
      // Some compatible services check input messages only, excluding instructions,
      // for JSON mode. Keep the trusted format instruction separate from user data.
      input: [
        { role: 'developer', content: 'Return only one JSON object matching the output schema in the instructions.' },
        { role: 'user', content: payload },
      ],
      // An explicit ceiling includes reasoning tokens; otherwise use the selected service's default.
      max_output_tokens: modelOutputTokenLimit(config),
      ...thinking?.top,
      ...(jsonMode ? { text: { format: { type: 'json_object' } } } : {}),
    });
  }
  if (config.adapter === 'google-generative-ai') {
    // Google Generative AI: contents + systemInstruction; model is in the URL path.
    return JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: payload }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: modelOutputTokenLimit(config),
        ...thinking?.generation,
      },
    });
  }
  return JSON.stringify({
    model: config.model,
    stream: modelStreaming(config),
    ...(includeUsage &&
    supportsStreamUsage(config) &&
    ['openai-compatible', 'lm-studio'].includes(config.adapter) &&
    modelStreaming(config)
      ? { stream_options: { include_usage: true } }
      : {}),
    ...(config.adapter === 'openai-compatible'
      ? { [chatOutputTokenField(config)]: modelOutputTokenLimit(config) }
      : {}),
    ...thinking?.top,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: payload },
    ],
    ...(config.adapter === 'ollama'
      ? { format: schema }
      : config.adapter === 'lm-studio'
        ? { response_format: { type: 'json_schema', json_schema: { name: 'bookmark_proposal', strict: true, schema } } }
        : jsonMode
          ? { response_format: { type: 'json_object' } }
          : {}),
  });
}

export { extractAssistantText, ModelParseError } from './model-replies';

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
const ID_ARRAYS = new Set([
  'folderIds',
  'rankedIds',
  'matchedIds',
  'unmatchedIds',
  'unchangedIds',
  'uncertainIds',
  'itemIds',
  'urlPath',
  'titlePath',
]);
/** Commentary keys models add despite instructions; harmless, so dropped before the strict schema check. */
const COMMENTARY_KEYS = new Set(['reason', 'reasoning', 'rationale', 'confidence', 'explanation', 'note', 'notes']);

/**
 * Normalizes cosmetic deviations before strict validation: numeric ids become strings (ids are numeric
 * in Chrome, so models often drop the quotes), commentary keys are dropped, and empty optional arrays are
 * filled in. Anything else unexpected (e.g. a url key) still fails the strict schema.
 */
export function normalizeModelJson(value: unknown, task: string): unknown {
  // Some models put answer values inside the JSON Schema's properties wrapper.
  // Accept only this exact envelope with actual action arrays, never a schema
  // definition, mixed root fields or an arbitrary nested object. The unwrapped
  // answer still passes every strict schema, ID, conflict and authority check.
  if (task === 'organize' && value && typeof value === 'object' && !Array.isArray(value)) {
    const envelope = value as Record<string, unknown>;
    const answer = envelope.properties;
    if (
      Object.keys(envelope).length === 3 &&
      envelope.$schema === 'https://json-schema.org/draft/2020-12/schema' &&
      envelope.type === 'object' &&
      answer &&
      typeof answer === 'object' &&
      !Array.isArray(answer) &&
      ['moves', 'newFolders', 'merges'].every(key => Array.isArray((answer as Record<string, unknown>)[key]))
    )
      value = answer;
  }
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (
        COMMENTARY_KEYS.has(key) &&
        !(['organize', 'rename'].includes(task ?? '') && key === 'reason' && node !== value)
      )
        continue;
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

function parseReason(error: ModelParseError): string {
  return ['empty', 'refused', 'incomplete'].includes(error.stage)
    ? error.stage
    : error.stage === 'provider'
      ? error.issue === 'finish=json-mode-input-required'
        ? 'json-mode-input-required'
        : 'provider-error'
      : 'schema';
}

export class ModelTransport {
  private generation = 0;
  private active?: AbortController;
  private cancelTrace?: (source: string) => void;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly boundary: ModelBoundary,
    private readonly authority: ModelAuthority,
    private readonly limits = MODEL_BYTE_LIMITS,
    private readonly usageRecorder: (record: TokenUsageRecord) => Promise<void> = recordTokenUsage,
  ) {
    // Tree changes are judged per request against its dependency scope in run(); settings/permission changes cancel outright.
    this.unsubscribe = authority.subscribe(change => {
      if (change !== 'tree') this.cancel(change === 'permissions' ? 'permissions-changed' : 'settings-changed');
    });
  }
  dispose() {
    this.cancel('disposed');
    this.unsubscribe();
  }
  /** Independent cancellation/stream owner sharing the same permission and freshness authority. */
  fork() {
    return new ModelTransport(this.boundary, this.authority, this.limits, this.usageRecorder);
  }
  cancel(source: 'caller' | 'disposed' | 'superseded' | 'permissions-changed' | 'settings-changed' = 'caller') {
    if (this.active && !this.active.signal.aborted) this.cancelTrace?.(source);
    this.generation++;
    this.active?.abort();
    this.active = undefined;
    this.cancelTrace = undefined;
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
    signal?: AbortSignal;
    /** Request/JSON budget, then inactivity budget for actual SSE; does not alter saved settings. */
    timeoutMs?: number;
    onProgress?: (progress: ModelProgress) => void;
    /** Numeric phase measurements, independent of debug logging and UI observers. */
    onTiming?: (timing: ModelTiming) => void;
    /** Diagnostic correlation only; never included in the provider request. */
    diagnosticRunId?: string;
    /** Synthetic connection generation shares task=save but is accounted separately. */
    usagePurpose?: TokenPurpose;
    /** Organizer-only opt-in. Never persisted or sent to the provider; does not initiate another request. */
    organizeRepair?: { knownIds: string[] };
  }): Promise<ModelResult> {
    this.cancel('superseded');
    const privateHistory =
      input.request.task.startsWith('history-') ||
      (input.request.task === 'save' && input.request.item.source === 'history');
    const generation = this.generation;
    const controller = new AbortController();
    this.active = controller;
    const started = Date.now();
    const timeoutMs = input.timeoutMs ?? input.config.timeoutMs;
    let deadline = started + timeoutMs;
    let timeoutPhase: 'request' | 'stream-idle' | 'validation' = 'request';
    let lastActivityAt: number | undefined;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let httpStatus: number | undefined;
    let attempt = 0;
    let firstTokenAt: number | undefined;
    let responseAt: number | undefined;
    let actualStreaming: boolean | undefined;
    let host = '';
    try {
      host = new URL(input.config.baseUrl).host;
    } catch {
      /* reported below */
    }
    const callId = globalThis.crypto?.randomUUID?.() ?? `${started}-${++modelCallSequence}`;
    const metadata = {
      callId,
      task: input.request.task,
      adapter: input.config.adapter,
      model: input.config.model,
      host,
      runId: input.diagnosticRunId,
    };
    const log = modelDiagnosticLog(metadata, input.key);
    this.cancelTrace = source => log('cancel-requested', { source, ms: Date.now() - started });
    const abort = () => {
      if (!controller.signal.aborted) log('cancel-requested', { source: 'input-signal', ms: Date.now() - started });
      controller.abort();
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(Error('aborted'));
    });
    // Attach a handler even if cancellation precedes the first awaited boundary.
    void cancelled.catch(() => {});
    controller.signal.addEventListener('abort', rejectAbort!, { once: true });
    if (controller.signal.aborted) rejectAbort!();
    const check = () => {
      if (timedOut) throw Error('timeout');
      if (controller.signal.aborted || generation !== this.generation) throw Error('aborted');
      if (Date.now() >= deadline) {
        timedOut = true;
        log('timeout', {
          phase: timeoutPhase,
          ms: Date.now() - started,
          idleMs: lastActivityAt === undefined ? undefined : Date.now() - lastActivityAt,
        });
        controller.abort();
      }
      if (timedOut) throw Error('timeout');
      if (controller.signal.aborted || generation !== this.generation) throw Error('aborted');
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          if (Date.now() < deadline) {
            arm();
            return;
          }
          try {
            check();
          } catch {
            /* Abort is handled by the operation race. */
          }
        },
        Math.max(1, deadline - Date.now()),
      );
    };
    const renew = (phase: typeof timeoutPhase) => {
      check(); // Late events cannot revive an already expired or cancelled call.
      timeoutPhase = phase;
      lastActivityAt = Date.now();
      deadline = lastActivityAt + timeoutMs;
      arm();
    };
    const checked = async <T>(promise: Promise<T>): Promise<T> => {
      check();
      const value = await Promise.race([promise, cancelled]);
      check();
      return value;
    };
    let result: ModelResult;
    const usageWrites: Promise<unknown>[] = [];
    log('call-start', { hasCredential: input.key.length > 0, timeoutMs });
    let lastProgressAt = 0;
    let lastProgressChars = 0;
    let lastProgressPhase: ModelProgress['phase'] | undefined;
    let lastStreamLogAt: number | undefined;
    let progressUpdates = 0;
    let suppressedUpdates = 0;
    const progress = (update: ModelProgress) => {
      if (controller.signal.aborted || generation !== this.generation) return;
      if (update.streaming && update.receivedChars > 0 && firstTokenAt === undefined) firstTokenAt = Date.now();
      progressUpdates++;
      if (
        update.phase === 'receiving' &&
        update.streaming &&
        (lastStreamLogAt === undefined || Date.now() - lastStreamLogAt >= 20_000)
      ) {
        lastStreamLogAt = Date.now();
        log('stream-progress', {
          ms: Date.now() - started,
          answerChars: update.receivedChars,
          progressUpdates,
          suppressedUpdates,
        });
      }
      if (!input.onProgress) return;
      // Thought/metadata chunks with zero answer characters must not bypass UI throttling.
      // Still deliver the first receiving notification, first answer and terminal validation immediately.
      if (
        update.phase === 'receiving' &&
        lastProgressPhase === 'receiving' &&
        !(lastProgressChars === 0 && update.receivedChars > 0) &&
        Date.now() - lastProgressAt < 150
      ) {
        suppressedUpdates++;
        return;
      }
      lastProgressAt = Date.now();
      lastProgressChars = update.receivedChars;
      lastProgressPhase = update.phase;
      try {
        input.onProgress({
          ...update,
          text: input.key ? update.text.split(input.key).join('[redacted]') : update.text,
        });
      } catch {
        /* Display observers do not control result validity. */
      }
    };
    try {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw Error('invalid-timeout');
      const { signal: _signal, onProgress: _progress, onTiming: _timing, ...data } = input;
      void _signal;
      void _progress;
      void _timing;
      const frozen = structuredClone(data);
      const route = parseModelEndpoint(frozen.config);
      check();
      arm();
      const dependencies = dependencyDigest(frozen.tree, frozen.request);
      const identity = settingsIdentity(frozen);
      let preferencePlan: ReturnType<typeof preferenceUpdatePlan> | undefined;
      const fresh = async () => {
        check();
        if (frozen.request.task === 'history-query' || frozen.request.task === 'history-rank') {
          if (!this.authority.validateHistory) throw Error('history-authority');
          await checked(this.authority.validateHistory(frozen.request));
        }
        const current = await checked(this.authority.read());
        if (
          current.tree.installationId !== frozen.tree.installationId ||
          dependencyDigest(current.tree, frozen.request) !== dependencies ||
          settingsIdentity(current) !== identity ||
          current.key !== frozen.key
        )
          throw Error('stale-context');
        if (folderScope) {
          const currentScope = searchScope(current.tree, folderScope);
          const currentHints = preferenceHints(
            memory,
            current.tree,
            current.privacy,
            'search',
            new Set([...currentScope.ids, ...currentScope.ancestorIds]),
          );
          if (JSON.stringify(currentHints) !== JSON.stringify(hints)) throw Error('stale-context');
        }
        if (frozen.request.task === 'preference-summary' && frozen.request.update) {
          const latestMemory = await checked(memoryStore.load(frozen.tree.installationId));
          preferenceUpdatePlan(latestMemory, frozen.request.update, current.tree, current.privacy);
          if (preferencePlan?.sources.some(entry => !preferenceUsable(entry, current.tree, current.privacy)))
            throw Error('stale-context');
        }
      };
      const permission = async () => {
        check();
        if (!(await checked(this.boundary.contains({ origins: [route.permission] })))) throw Error('permission');
      };
      const memoryStore = browserPersonalizationStore();
      const memory =
        privateHistory || frozen.usagePurpose === 'connection-test'
          ? emptyPersonalization()
          : await checked(memoryStore.load(frozen.tree.installationId));
      if (frozen.request.task === 'preference-summary') {
        if (frozen.request.update) {
          preferencePlan = preferenceUpdatePlan(memory, frozen.request.update, frozen.tree, frozen.privacy);
          if (JSON.stringify(preferencePlan.examples) !== JSON.stringify(frozen.request.examples))
            throw Error('stale-context');
        } else {
          // Manual summaries may only use currently active, privacy-allowed local examples.
          const examples = frozen.request.examples;
          if (
            !memory.enabled ||
            !examples.length ||
            examples.length > 20 ||
            examples.some(
              example =>
                !memory.entries.some(
                  entry =>
                    entry.id === example.id &&
                    entry.text === example.text &&
                    entry.status === 'active' &&
                    entry.enabled &&
                    preferenceUsable(entry, frozen.tree, frozen.privacy),
                ),
            )
          )
            throw Error('stale-context');
        }
      }
      const scope: PreferenceScope | undefined =
        frozen.request.task === 'rename'
          ? 'rename'
          : frozen.request.task.startsWith('search')
            ? 'search'
            : frozen.request.task === 'organize'
              ? 'organize'
              : frozen.request.task === 'save'
                ? 'save'
                : frozen.request.task === 'import-classify'
                  ? 'import'
                  : undefined;
      const folderScope =
        frozen.request.task === 'search-plan' || frozen.request.task === 'search-batch'
          ? frozen.request.folderScope
          : undefined;
      const scopedEvidence = folderScope ? searchScope(frozen.tree, folderScope) : undefined;
      const hints = scope
        ? preferenceHints(
            memory,
            frozen.tree,
            frozen.privacy,
            scope,
            scopedEvidence ? new Set([...scopedEvidence.ids, ...scopedEvidence.ancestorIds]) : undefined,
          )
        : [];
      const serialized = serializeAiPayload(frozen.tree, frozen.privacy, frozen.request);
      const payload = JSON.stringify({
        ...JSON.parse(serialized),
        ...(hints.length ? { personalPreferences: hints } : {}),
        ...(preferencePlan
          ? {
              characterLimit: preferencePlan.characterLimit,
              ruleLimit: preferencePlan.ruleLimit,
              latestExampleIds: preferencePlan.latestExampleIds,
            }
          : {}),
      });
      const policy = frozen.policy ?? DEFAULT_CLASSIFICATION_POLICY;
      const context: ModelOutputContext = {
        ...JSON.parse(payload),
        policy,
        ...(['search', 'search-batch', 'search-plan', 'search-expand'].includes(frozen.request.task)
          ? {}
          : {
              rootId:
                frozen.request.task === 'organize'
                  ? frozen.request.rootId
                  : 'targetId' in frozen.request
                    ? frozen.request.targetId
                    : undefined,
            }),
      };
      await fresh();
      result = { status: 'failed', reason: 'empty' };
      let jsonMode = supportsApiJsonMode(frozen.config);
      let recoveries = 0;
      const thinkingPlan = modelThinkingPlan(frozen.config);
      const thinkingKey = JSON.stringify([route.identity, frozen.config.model, thinkingPlan?.key]);
      let useThinking = Boolean(thinkingPlan) && (unsupportedThinking.get(thinkingKey) ?? 0) <= Date.now();
      let thinkingFallback = false;
      let includeUsage =
        officialModelProvider(frozen.config.baseUrl) !== 'glm' &&
        ['openai-compatible', 'lm-studio'].includes(frozen.config.adapter) &&
        modelStreaming(frozen.config);
      for (;;) {
        check();
        timeoutPhase = 'request';
        lastActivityAt = undefined;
        attempt++;
        const attemptLog = modelDiagnosticLog({ ...metadata, attempt }, frozen.key);
        await permission();
        await fresh();
        const body = modelRequestBody(
          useThinking ? frozen.config : { ...frozen.config, reasoningEffort: 'default' as const },
          frozen.request.task,
          payload,
          policy,
          jsonMode,
          includeUsage,
        );
        const requestBytes = new TextEncoder().encode(body).byteLength;
        if (requestBytes > this.limits.requestBytes) throw Error('payload-too-large');
        const headers = requestHeaders(frozen.config.adapter, frozen.key);
        progress({ phase: 'waiting', text: '', receivedChars: 0, streaming: modelStreaming(frozen.config) });
        attemptLog('request', {
          method: 'POST',
          url: route.url,
          jsonMode,
          streaming: modelStreaming(frozen.config),
          requestBytes,
          headers: JSON.stringify(headers),
        });
        if (!privateHistory) attemptLog('request-body', () => modelBodyDiagnostics(body, frozen.key));
        check();
        const usage = tokenUsageAccumulator(frozen.config.adapter);
        const attemptAt = Date.now();
        let responseComplete = false;
        try {
          const pendingResponse = this.boundary.fetch(route.url, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
          });
          // A boundary that ignores AbortSignal may still resolve; release its unread body.
          void pendingResponse.then(
            response => {
              if (controller.signal.aborted || generation !== this.generation)
                void response.body?.cancel().catch(() => {});
            },
            () => {},
          );
          const response = await checked(pendingResponse);
          httpStatus = response.status;
          attemptLog('response-headers', {
            httpStatus,
            contentType: privateHistory ? undefined : response.headers.get('content-type'),
            contentLength: response.headers.get('content-length'),
            serverRequestId: privateHistory
              ? undefined
              : (response.headers.get('x-request-id') ?? response.headers.get('request-id')),
            redirected: response.redirected,
          });
          if (response.redirected || (response.url && response.url !== route.url)) {
            void response.body?.cancel().catch(() => {});
            throw Error('redirect');
          }
          const onBody: ModelBodyObserver = (text, receivedBytes, complete) => {
            if (!privateHistory)
              attemptLog('response-body', () => ({
                receivedBytes,
                complete,
                ...modelBodyDiagnostics(text, frozen.key),
              }));
            if (complete && !response.ok) {
              try {
                usage.push(JSON.parse(text));
              } catch {
                /* Error bodies need not be JSON. */
              }
            }
          };
          if (!response.ok) {
            const message = await checked(errorMessage(response, onBody, controller.signal, this.limits.responseBytes));
            responseComplete = true;
            attemptLog('http-error', {
              status: response.status,
              message: privateHistory ? 'history-provider-error' : message,
            });
            if ([400, 422].includes(response.status) && isJsonModeInputError(message)) {
              result = { status: 'failed', reason: 'json-mode-input-required' };
              break;
            }
            // MiniMax 1026 is an input-content rejection, including when its Responses API
            // labels it image_content_policy_violation for a text-only request. Never replay it.
            if (
              officialModelProvider(frozen.config.baseUrl) === 'minimax' &&
              [400, 422].includes(response.status) &&
              /\[1026\]|\b(?:input\s+)?new_sensitive\s*\(1026\)|\b1026\b.*(?:sensitive|涉敏)|(?:sensitive|涉敏).*\b1026\b/i.test(
                message,
              )
            ) {
              result = { status: 'failed', reason: 'refused' };
              break;
            }
            if (
              includeUsage &&
              rejectsThinkingParameter(response.status, message, ['stream_options', 'include_usage'])
            ) {
              includeUsage = false;
              continue;
            }
            if (
              useThinking &&
              !thinkingFallback &&
              thinkingPlan &&
              rejectsThinkingParameter(response.status, message, thinkingPlan.fields)
            ) {
              useThinking = false;
              thinkingFallback = true;
              unsupportedThinking.set(thinkingKey, Date.now() + 24 * 60 * 60 * 1000);
              if (unsupportedThinking.size > 128) unsupportedThinking.delete(unsupportedThinking.keys().next().value!);
              attemptLog('thinking-compatibility-fallback', { scheme: thinkingPlan.key });
              continue;
            }
            if ((response.status === 429 || (response.status >= 500 && response.status <= 599)) && recoveries < 3) {
              const delaySeconds = 2 ** ++recoveries;
              progress({
                phase: 'waiting',
                text: '',
                receivedChars: 0,
                streaming: modelStreaming(frozen.config),
                retry: { attempt: recoveries, delaySeconds, httpStatus: response.status },
              });
              attemptLog('retry-wait', { retry: recoveries, delaySeconds, httpStatus: response.status });
              await checked(abortableDelay(delaySeconds * 1000, controller.signal));
              continue;
            }
            result = {
              status: 'failed',
              reason: [400, 401, 403, 422, 429].includes(response.status) ? `http-${response.status}` : 'http-error',
            };
            break;
          }
          const streaming = /^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '');
          actualStreaming = streaming;
          firstTokenAt = undefined;
          responseAt = undefined;
          if (streaming) renew('stream-idle');
          attemptLog('waiting-policy', { mode: streaming ? 'stream-idle' : 'total', timeoutMs });
          let wire: Awaited<ReturnType<typeof readWireReply>>;
          progress({
            phase: 'receiving',
            text: '',
            receivedChars: 0,
            streaming,
          });
          try {
            wire = await checked(
              readWireReply(
                response,
                frozen.config.adapter,
                this.limits.responseBytes,
                controller.signal,
                onBody,
                input.onProgress || input.onTiming ? update => progress({ ...update, phase: 'receiving' }) : undefined,
                streaming ? () => renew('stream-idle') : undefined,
                raw => usage.push(raw),
              ),
            );
          } catch (error) {
            const readError = error instanceof ModelResponseReadError ? error.cause : error;
            attemptLog('response-read-failed', {
              waitingPhase: timeoutPhase,
              idleMs: lastActivityAt === undefined ? undefined : Date.now() - lastActivityAt,
              aborted: controller.signal.aborted,
              stage: error instanceof ModelResponseReadError ? 'body-read' : 'decode-or-protocol',
              error: privateHistory ? 'history-read-error' : readError instanceof Error ? readError.name : 'unknown',
              message: !privateHistory && readError instanceof Error ? readError.message : undefined,
            });
            throw error instanceof ModelParseError ||
              error instanceof ModelResponseReadError ||
              (error instanceof Error && ['response-too-large', 'aborted'].includes(error.message))
              ? error
              : new ModelParseError('envelope');
          }
          responseAt = Date.now();
          responseComplete = true;
          if (streaming) renew('validation');
          await permission();
          await fresh();
          const reply = wire.reply;
          progress({
            phase: 'validating',
            text: '',
            receivedChars: reply.text.length,
            streaming: wire.events !== undefined,
          });
          attemptLog('reply-extracted', {
            chars: reply.text.length,
            finish: privateHistory ? undefined : reply.finish,
            truncated: reply.truncated,
            refused: Boolean(reply.refused),
            failed: privateHistory ? Boolean(reply.failed) : reply.failed,
            events: wire.events,
          });
          try {
            const text = completedReplyText(reply);
            // SSE body prefixes can consist entirely of thinking. Capture the completed answer
            // independently so long reasoning streams cannot hide a rejected proposal.
            if (!privateHistory) attemptLog('answer-body', () => modelBodyDiagnostics(text, frozen.key));
            const value = normalizeModelJson(extractJsonObject(text), frozen.request.task);
            try {
              const output = parseModelOutput(value, context);
              check();
              attemptLog('output-validated', { status: 'completed' });
              result = { status: 'completed', output };
            } catch (error) {
              if (controller.signal.aborted) throw error;
              const repair =
                frozen.organizeRepair &&
                analyzeOrganizeRepair(value, context, [
                  ...frozen.tree.nodes.map(node => node.ref.nativeId),
                  ...frozen.organizeRepair.knownIds,
                ]);
              if (repair) {
                check();
                result = { status: 'repairable', reason: 'partial-invalid-targets', repair };
                break;
              }
              const issue =
                error instanceof ModelOutputValidationError ? `${error.path}: ${error.code}` : 'validation-exception';
              throw new ModelParseError('validate', issue);
            }
          } catch (error) {
            check();
            const parse = error instanceof ModelParseError ? error : new ModelParseError('json');
            attemptLog('parse-failed', {
              task: frozen.request.task,
              jsonMode,
              stage: parse.stage,
              detail: parse.detail,
              issue: privateHistory ? undefined : parse.issue,
              organizeStage: context.stage,
              inputItems: context.items.length,
              inputFolders: context.folders.length,
              maxNewDepth: context.policy?.maxNewDepth,
              chars: reply.text.length,
              shape: privateHistory ? undefined : wire.raw === undefined ? 'SSE' : replyShape(wire.raw),
            });
            result = {
              status: 'failed',
              reason: parseReason(parse),
              ...(parse.detail ? { detail: parse.detail } : {}),
            };
          }
          if (
            result.status !== 'failed' ||
            result.reason !== 'empty' ||
            !jsonMode ||
            !['openai-compatible', 'openai-responses'].includes(frozen.config.adapter)
          )
            break;
          check();
          log('retry-without-json-mode', { attempt: attempt + 1 });
          jsonMode = false;
        } finally {
          // Start durable accounting immediately, outside the transport deadline and validity path.
          // An actual attempt is recorded even for network errors, cancellation or invalid proposals.
          try {
            usageWrites.push(
              Promise.resolve(
                this.usageRecorder({
                  id: `${callId}:${attempt}`,
                  at: attemptAt,
                  adapter: frozen.config.adapter,
                  model: (frozen.key
                    ? frozen.config.model.split(frozen.key).join('[redacted]')
                    : frozen.config.model
                  ).slice(0, 512),
                  purpose:
                    frozen.usagePurpose ??
                    (frozen.request.task === 'search-batch' || frozen.request.task === 'search-plan'
                      ? 'search'
                      : frozen.request.task),
                  counts: usage.snapshot(),
                  complete: responseComplete,
                }),
              ).catch(() => {}),
            );
          } catch {
            /* Accounting cannot change the model result. */
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      log('request-failed', {
        error: privateHistory ? 'history-request-error' : error instanceof Error ? error.name : 'unknown',
        message: privateHistory ? undefined : message,
        timedOut,
        aborted: controller.signal.aborted,
      });
      result = timedOut
        ? { status: 'failed', reason: 'timeout' }
        : controller.signal.aborted || generation !== this.generation
          ? { status: 'cancelled', reason: 'cancelled' }
          : {
              status: 'failed',
              reason:
                error instanceof ModelParseError
                  ? parseReason(error)
                  : [
                        'network-error',
                        'payload-too-large',
                        'response-too-large',
                        'stale-context',
                        'permission',
                        'redirect',
                      ].includes(message)
                    ? message
                    : 'connection-or-configuration',
            };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectAbort!);
      if (generation === this.generation) {
        this.active = undefined;
        this.cancelTrace = undefined;
      }
    }
    log('call-end', {
      attempts: attempt,
      status: result.status,
      reason: result.status === 'completed' ? undefined : result.reason,
      detail: result.status === 'completed' ? undefined : result.detail,
      httpStatus,
      ms: Date.now() - started,
    });
    try {
      input.onTiming?.({
        ms: Date.now() - started,
        attempts: attempt,
        streaming: actualStreaming,
        responseMs: responseAt === undefined ? undefined : responseAt - started,
        firstTokenMs: firstTokenAt === undefined ? undefined : firstTokenAt - started,
        generationMs: responseAt === undefined || firstTokenAt === undefined ? undefined : responseAt - firstTokenAt,
        validationMs: responseAt === undefined ? undefined : Date.now() - responseAt,
      });
    } catch {
      /* Measurement observers cannot change validation or write eligibility. */
    }
    // Give local persistence a bounded opportunity before a caller closes the document/worker event.
    // Never hold cancellation or a valid result indefinitely on storage/lock availability.
    if (usageWrites.length) {
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(usageWrites),
        new Promise<void>(resolve => {
          flushTimer = setTimeout(resolve, 1000);
        }),
      ]);
      clearTimeout(flushTimer);
    }
    return result;
  }
}

/** Provider error message (e.g. "response_format is not supported") for the debug trail; bounded, never the request. */
export async function errorMessage(
  response: Response,
  onBody?: ModelBodyObserver,
  signal?: AbortSignal,
  limit = MODEL_BYTE_LIMITS.responseBytes,
): Promise<string> {
  try {
    const body = (await readModelText(response, limit, signal, onBody)).slice(0, 2000);
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: unknown; param?: unknown; code?: unknown } | string;
        message?: unknown;
        base_resp?: { status_code?: unknown; status_msg?: unknown };
      };
      const message =
        typeof parsed.error === 'string'
          ? parsed.error
          : typeof parsed.error?.message === 'string'
            ? parsed.error.message
            : typeof parsed.message === 'string'
              ? parsed.message
              : typeof parsed.base_resp?.status_msg === 'string'
                ? parsed.base_resp.status_msg
                : body;
      const code = typeof parsed.error === 'object' ? parsed.error?.code : parsed.base_resp?.status_code;
      const codePrefix = typeof code === 'string' || typeof code === 'number' ? `[${String(code).slice(0, 80)}] ` : '';
      const param =
        typeof parsed.error === 'object' && typeof parsed.error?.param === 'string' ? `${parsed.error.param}: ` : '';
      return `${codePrefix}${param}${message}`.slice(0, 300);
    } catch {
      return body.slice(0, 300);
    }
  } catch {
    return '';
  }
}
