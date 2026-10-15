import { listModels, type ListModelsResult } from './model-discovery';
import { ModelTransport } from './model-transport';
import { parseModelEndpoint, type ModelAdapter } from '../domain/model-route';
import { apiModeToAdapter, curatedModelsForVendor, type ApiMode } from '../domain/ai-providers';
import type { TreeSnapshot } from '../domain/node-reference';
import type { SettingsStore } from '../persistence/settings';
import type { ModelAuthority } from './model-authority';
import type { AiPrivacy } from '../domain/ai-payload';

export type ConnectionDraft = {
  mode: ApiMode;
  adapter?: ModelAdapter;
  baseUrl: string;
  key: string;
  timeoutMs?: number;
  vendorId?: string;
  model?: string;
  streaming?: boolean;
  fastMode?: boolean;
  maxOutputTokens?: number;
};

function draftConfig(draft: ConnectionDraft) {
  const adapter = draft.adapter ?? apiModeToAdapter(draft.mode);
  const baseUrl = draft.baseUrl.trim();
  if (!baseUrl) throw Error('invalid-endpoint');
  const timeoutMs = draft.timeoutMs ?? 60000;
  const model = draft.model?.trim() || 'pending';
  const config = {
    adapter,
    baseUrl,
    model,
    timeoutMs,
    ...(draft.streaming === undefined ? {} : { streaming: draft.streaming }),
    ...(draft.fastMode === undefined ? {} : { fastMode: draft.fastMode }),
    ...(draft.maxOutputTokens === undefined ? {} : { maxOutputTokens: draft.maxOutputTokens }),
  };
  parseModelEndpoint(config);
  return config;
}

export async function requestHostPermission(draft: ConnectionDraft): Promise<boolean> {
  const config = draftConfig(draft);
  const permission = parseModelEndpoint(config).permission;
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) return false;
  return chrome.permissions.request({ origins: [permission] });
}

export async function discoverModels(
  draft: ConnectionDraft,
  opts?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<ListModelsResult> {
  const config = draftConfig(draft);
  const contains =
    typeof chrome !== 'undefined' && chrome.permissions?.contains
      ? (request: { origins: string[] }) => chrome.permissions.contains(request)
      : async () => false;
  return listModels({
    adapter: config.adapter,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    key: draft.key,
    fetch: opts?.fetch ?? globalThis.fetch.bind(globalThis),
    contains,
    signal: opts?.signal,
    presetId: draft.vendorId,
    curatedFallback: draft.vendorId ? curatedModelsForVendor(draft.vendorId) : undefined,
  });
}

export type TestConnectionResult = { status: 'completed'; via: 'synthetic' } | { status: 'failed'; reason: string };

/**
 * Current draft only. A list endpoint cannot prove generation or classification capability.
 */
export async function testConnection(input: {
  draft: ConnectionDraft;
  privacy?: AiPrivacy;
  signal?: AbortSignal;
  settings?: SettingsStore;
  fetch?: typeof fetch;
  contains?: (request: { origins: string[] }) => Promise<boolean>;
}): Promise<TestConnectionResult> {
  let transport: ModelTransport | undefined;
  let stop = () => {};
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(Error('aborted'));
  });
  void aborted.catch(() => {});
  controller.signal.addEventListener('abort', rejectAbort!, { once: true });
  if (controller.signal.aborted) rejectAbort!();
  try {
    const draft = structuredClone(input.draft);
    if (!draft.baseUrl.trim()) return { status: 'failed', reason: 'invalid-endpoint' };
    if (!draft.model?.trim()) return { status: 'failed', reason: 'model-required' };
    if (input.signal?.aborted) return { status: 'failed', reason: 'cancelled' };
    const config = draftConfig(draft);
    const deadline = Date.now() + config.timeoutMs;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    let invalidated = false;
    const listeners = new Set<Parameters<ModelAuthority['subscribe']>[0]>();
    const changed = () => {
      invalidated = true;
      controller.abort();
      for (const listener of listeners) listener('settings');
    };
    const stopSettings = input.settings?.subscribe(changed);
    const permissions = typeof chrome !== 'undefined' ? chrome.permissions?.onRemoved : undefined;
    permissions?.addListener(changed);
    stop = () => {
      stopSettings?.();
      permissions?.removeListener(changed);
    };
    const savedPrivacy = input.settings
      ? (await Promise.race([input.settings.snapshot(), aborted])).privacy
      : undefined;
    const privacy = structuredClone(
      input.privacy ?? savedPrivacy ?? { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
    );
    if (Date.now() >= deadline) {
      timedOut = true;
      controller.abort();
    }
    if (controller.signal.aborted || invalidated)
      return { status: 'failed', reason: timedOut ? 'timeout' : 'cancelled' };
    config.timeoutMs = Math.max(1, deadline - Date.now());
    // Preparation is bounded above; transport now owns request/SSE inactivity.
    clearTimeout(timer);
    const tree = syntheticConnectionTree();
    const snapshot = {
      version: 1 as const,
      revision: 'test',
      sessionRevision: 0,
      config,
      key: draft.key,
      privacy,
      tree,
    };
    transport = new ModelTransport(
      {
        fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
        contains:
          input.contains ??
          (async request => typeof chrome !== 'undefined' && !!(await chrome.permissions?.contains(request))),
      },
      {
        read: async () => {
          if (invalidated) throw Error('stale-context');
          return structuredClone(snapshot);
        },
        subscribe: listener => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    );
    const result = await transport.run({
      config,
      key: draft.key,
      privacy,
      tree,
      signal: controller.signal,
      request: {
        task: 'save',
        targetId: 'test-root',
        item: { source: 'bookmark', id: 'test-bookmark' },
        folderIds: ['test-docs', 'test-other'],
      },
    });
    if (result.status === 'completed') return { status: 'completed', via: 'synthetic' };
    return { status: 'failed', reason: timedOut ? 'timeout' : result.reason };
  } catch {
    return {
      status: 'failed',
      reason: timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'connection-or-configuration',
    };
  } finally {
    transport?.dispose();
    stop();
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort!);
  }
}

export function syntheticConnectionTree(): TreeSnapshot {
  const installationId = 'synthetic-connection-test';
  const node = (
    nativeId: string,
    title: string,
    kind: 'bookmark' | 'folder',
    parentId?: string,
    childrenIds: string[] = [],
  ) => ({
    ref: { installationId, nativeId, kind },
    title,
    parentId,
    index: 0,
    childrenIds,
    readOnly: false,
    childrenWritable: kind === 'folder',
    observedRevision: 1,
    ...(kind === 'bookmark' ? { url: 'https://example.org/documentation' } : {}),
  });
  return {
    installationId,
    epoch: 'test',
    observedRevision: 1,
    roots: ['test-root'],
    nodes: [
      node('test-root', 'Connection test', 'folder', undefined, ['test-docs', 'test-other', 'test-bookmark']),
      node('test-docs', 'Documentation', 'folder', 'test-root'),
      node('test-other', 'Other', 'folder', 'test-root'),
      node('test-bookmark', 'Example documentation', 'bookmark', 'test-root'),
    ],
  };
}

export function modelsToCatalog(ids: string[]): { id: string; ctx: string }[] {
  return ids.map(id => ({ id, ctx: '发现' }));
}
