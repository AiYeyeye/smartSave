import {
  modelRequestBody,
  type ModelTransport,
  type ModelResult,
  type ModelProgress,
} from '../adapters/model-transport';
import { MODEL_BYTE_LIMITS } from '../adapters/model-byte-limits';
import { cancellable } from '../domain/cancellable';
import { serializeAiPayload } from '../domain/ai-payload';
import { organizePolicy } from '../domain/classification-policy';
import { completeOrganizeRepair } from '../domain/organize-partial-repair';
import { parseModelOutput } from '../schemas/model-output';
import type { StagedRun } from '../domain/organize-state';
import type { OrganizeRequest } from '../domain/organize-batches';

export const MODEL_WAIT_MS = 180_000;
export type OrganizeModel = Pick<ModelTransport, 'run' | 'cancel' | 'dispose'> & {
  fork?: () => Pick<ModelTransport, 'run' | 'cancel' | 'dispose'>;
};

export function organizeRequestSize(run: StagedRun, request: OrganizeRequest) {
  return new TextEncoder().encode(
    modelRequestBody(
      run.context.config,
      'organize',
      serializeAiPayload(run.context.tree, run.context.privacy, request),
      organizePolicy(run.options),
    ),
  ).byteLength;
}

/** Executes one read-only request. Ordering, persistence, state transitions and native writes belong to callers. */
export async function runOrganizeBatch({
  run,
  ids,
  signal,
  model: parentModel,
  repairOnce,
  diagnosticRunId,
  onProgress,
}: {
  run: StagedRun;
  ids: string[];
  signal: AbortSignal;
  model: OrganizeModel;
  repairOnce: boolean;
  diagnosticRunId?: string;
  onProgress: (update: ModelProgress, context: { bookmarkCount: number; timeoutMs: number }) => void;
}): Promise<ModelResult> {
  const repair = repairOnce && run.repair?.ids === ids ? run.repair.candidate : undefined;
  if (repair) run.repair = undefined; // Consume explicit one-shot consent before any await/fetch.
  const request: OrganizeRequest = { ...run.request, itemIds: repair?.itemIds ?? ids };
  if (organizeRequestSize(run, request) > MODEL_BYTE_LIMITS.requestBytes) throw Error('bookmark-context-too-large');
  const timeoutMs = Math.max(run.context.config.timeoutMs, MODEL_WAIT_MS);
  const model = parentModel.fork?.() ?? parentModel;
  try {
    const result = await cancellable(
      model.run({
        diagnosticRunId,
        ...run.context,
        request,
        ...(!repair
          ? { organizeRepair: { knownIds: run.folderOutput?.newFolders.map(folder => folder.id) ?? [] } }
          : {}),
        signal,
        timeoutMs,
        policy: organizePolicy(run.options),
        onProgress: update => onProgress(update, { bookmarkCount: request.itemIds.length, timeoutMs }),
      }),
      signal,
    );
    if (result.status !== 'completed') return repair ? { status: 'failed', reason: 'partial-repair-failed' } : result;
    const context = {
      ...JSON.parse(serializeAiPayload(run.context.tree, run.context.privacy, { ...request, itemIds: ids })),
      rootId: request.rootId,
    };
    const output = repair
      ? completeOrganizeRepair(repair, result.output, context)
      : parseModelOutput(result.output, context);
    return { status: 'completed', output };
  } finally {
    if (model !== parentModel) model.dispose();
  }
}
