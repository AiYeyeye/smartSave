import { listModels, type ListModelsResult } from './model-discovery';
import { ModelTransport } from './model-transport';
import { parseModelEndpoint } from '../domain/model-route';
import { apiModeToAdapter, curatedModelsForVendor, type ApiMode } from '../domain/ai-providers';
import type { TreeSnapshot } from '../domain/node-reference';
import type { AiPrivacy } from '../domain/ai-payload';

export type ConnectionDraft = {
  mode: ApiMode;
  baseUrl: string;
  key: string;
  timeoutMs?: number;
  vendorId?: string;
  model?: string;
};

function draftConfig(draft: ConnectionDraft) {
  const adapter = apiModeToAdapter(draft.mode);
  const baseUrl = draft.baseUrl.trim();
  if (!baseUrl) throw Error('invalid-endpoint');
  const timeoutMs = draft.timeoutMs ?? 60000;
  const model = draft.model?.trim() || 'pending';
  const config = { adapter, baseUrl, model, timeoutMs };
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

export type TestConnectionResult =
  | { status: 'completed'; via: 'list' | 'synthetic' }
  | { status: 'failed'; reason: string };

/**
 * Prefer a synthetic ModelTransport search when a tree + transport are available;
 * otherwise fall back to listModels (proves auth + endpoint without faking success).
 */
export async function testConnection(input: {
  draft: ConnectionDraft;
  transport?: ModelTransport;
  tree?: TreeSnapshot;
  privacy?: AiPrivacy;
  signal?: AbortSignal;
}): Promise<TestConnectionResult> {
  const draft = input.draft;
  if (!draft.baseUrl.trim()) return { status: 'failed', reason: 'invalid-endpoint' };

  if (input.transport && input.tree && input.privacy && draft.model?.trim()) {
    try {
      const config = draftConfig(draft);
      const result = await input.transport.run({
        config,
        key: draft.key,
        privacy: input.privacy,
        tree: input.tree,
        request: {
          task: 'search',
          query: 'Synthetic connection test: return an empty rankedIds array.',
          itemIds: [],
          folderIds: [],
        },
      });
      if (result.status === 'completed') return { status: 'completed', via: 'synthetic' };
      return { status: 'failed', reason: result.reason };
    } catch {
      return { status: 'failed', reason: 'connection-or-configuration' };
    }
  }

  const listed = await discoverModels(draft, { signal: input.signal });
  if (listed.status === 'completed') return { status: 'completed', via: 'list' };
  return { status: 'failed', reason: listed.reason };
}

export function modelsToCatalog(ids: string[]): { id: string; ctx: string }[] {
  return ids.map(id => ({ id, ctx: '发现' }));
}
