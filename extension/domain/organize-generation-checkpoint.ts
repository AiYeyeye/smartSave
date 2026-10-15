import { serializeAiPayload } from './ai-payload';
import { approvedOrganizeFolders, type OrganizeRequest } from './organize-batches';
import { organizeCheckpointContext, organizeCheckpointSchema, type OrganizeCheckpoint } from './organize-checkpoint';
import { organizeProgressTiming } from './organize-progress';
import {
  organizeCandidates,
  organizeCleanup,
  organizeCompilation,
  organizePrivacy,
  organizeProposal,
  type OrganizeAction,
  type OrganizeProposal,
} from './organize-proposal';
import { parseModelOutput, organizeOutputSchema, type OrganizeOutput } from '../schemas/model-output';
import type { OrganizeState, RunContext, StagedRun } from './organize-state';
import type { ModelAuthority } from '../adapters/model-authority';

export function organizeBookmarkActions(
  output: OrganizeOutput,
  run: StagedRun,
  lockedActionIds: string[],
): OrganizeAction[] {
  const nodes = new Map(run.context.tree.nodes.map(node => [node.ref.nativeId, node]));
  return output.moves
    .filter(move => move.folderId !== run.approved!.placements.get(move.itemId))
    .map(move => ({
      id: `move:${move.itemId}`,
      kind: 'move',
      sourceId: move.itemId,
      targetId: move.folderId,
      title: nodes.get(move.itemId)!.title,
      children: [],
      reason: move.reason || '按已确认分类归入更合适的目录。',
      dependsOn: lockedActionIds,
    }));
}

/** Capture synchronously before hashing; no key/config/lease is projected into the returned record. */
export async function exportOrganizeGeneration(
  stateValue: OrganizeState,
  runValue: StagedRun,
  id: string,
  revision: number,
) {
  runValue.batchIds ??= new Map();
  for (const ids of [...(runValue.finishedBatches?.map(batch => batch.ids) ?? []), ...runValue.queue])
    if (!runValue.batchIds.has(ids)) runValue.batchIds.set(ids, crypto.randomUUID());
  const run = structuredClone(runValue),
    state = structuredClone(stateValue);
  if (!state.pipeline) throw Error('organize-checkpoint-unavailable');
  const folderSelection = state.pipeline.stage === 'folders' ? state : run.folderReview;
  const options = run.options;
  const baseline = run.checkpointBaseline ?? run.context.tree;
  const value: OrganizeCheckpoint = {
    schemaVersion: 1,
    id,
    revision,
    updatedAt: Date.now(),
    installationId: baseline.installationId,
    root: baseline.nodes.find(node => node.ref.nativeId === run.request.rootId)!.ref,
    baseline,
    ...(await organizeCheckpointContext({ ...run.context, tree: baseline }, run.request.rootId)),
    requiresCredential: !!run.context.key,
    preference: run.preference,
    options: {
      batchSize: options.batchSize ?? 100,
      ...(options.cleanupEmpty === undefined ? {} : { cleanupEmpty: options.cleanupEmpty }),
      ...(options.allowRename === undefined ? {} : { allowRename: options.allowRename }),
      ...(options.unfiledOnly === undefined ? {} : { unfiledOnly: options.unfiledOnly }),
      ...(options.protectedFolderIds === undefined ? {} : { protectedFolderIds: options.protectedFolderIds }),
      ...(options.rejectedSignatures === undefined ? {} : { rejectedSignatures: options.rejectedSignatures }),
    },
    stage: state.pipeline.stage,
    status: state.invalid ? 'invalid' : state.pipeline.status,
    ...(run.folderOutput && folderSelection
      ? {
          folderPlan: {
            output: run.folderOutput,
            selected: folderSelection.selected,
            targets: folderSelection.targets,
          },
        }
      : {}),
    bookmarkIds: run.bookmarkIds,
    batches: [
      ...(run.finishedBatches ?? []).map(batch => ({
        id: run.batchIds!.get(batch.ids)!,
        itemIds: batch.ids,
        status: 'merged' as const,
        output: batch.output,
      })),
      ...run.queue.map(ids => {
        const result = run.acceptedBatches?.get(ids);
        return {
          id: run.batchIds!.get(ids)!,
          itemIds: ids,
          status: result?.status === 'completed' ? ('accepted' as const) : ('pending' as const),
          ...(result?.status === 'completed' ? { output: organizeOutputSchema.parse(result.output) } : {}),
        };
      }),
    ],
    selection: run.folderOutput ? { selected: state.selected, targets: state.targets } : { selected: [], targets: {} },
    elapsedMs: organizeProgressTiming(state.pipeline).elapsedMs,
  };
  return organizeCheckpointSchema.parse(value);
}

function validateSelection(
  proposal: OrganizeProposal,
  selection: { selected: string[]; targets: Record<string, string> },
) {
  const ids = new Set(proposal.actions.map(action => action.id));
  if (
    selection.selected.some(id => !ids.has(id)) ||
    Object.entries(selection.targets).some(([id, target]) => !ids.has(id) || !proposal.targetIds.includes(target))
  )
    throw Error('invalid-organize-checkpoint');
  if (selection.selected.length)
    organizeCompilation(proposal, selection.selected, selection.targets, 'restored-review');
}

/** Rebuild suggestions with fresh epochs/observations, after independently matching semantic context. */
export async function restoreOrganizeGeneration(input: unknown, current: Awaited<ReturnType<ModelAuthority['read']>>) {
  const value = organizeCheckpointSchema.parse(input);
  const rootId = value.root.nativeId;
  if (!current.config) throw Error('model-unconfigured');
  if (value.requiresCredential && !current.key) throw Error('organize-credential-required');
  const digests = await organizeCheckpointContext(current, rootId);
  if (
    value.installationId !== current.tree.installationId ||
    value.scopeDigest !== digests.scopeDigest ||
    value.settingsDigest !== digests.settingsDigest ||
    value.settingsRevision !== digests.settingsRevision
  )
    throw Error('stale-context');
  const context: RunContext = { ...current, config: current.config };
  const options = { ...value.options, staged: true };
  const candidates = organizeCandidates(
    current.tree,
    rootId,
    organizePrivacy(current.tree, current.privacy, options.protectedFolderIds),
  );
  const nodes = new Map(current.tree.nodes.map(node => [node.ref.nativeId, node]));
  const bookmarkIds = candidates.items
    .map(item => item.id)
    .filter(
      id => nodes.get(id)?.ref.kind === 'bookmark' && (!options.unfiledOnly || nodes.get(id)?.parentId === rootId),
    );
  if (bookmarkIds.length !== value.bookmarkIds.length || bookmarkIds.some(id => !value.bookmarkIds.includes(id)))
    throw Error('stale-context');
  const request: OrganizeRequest = {
    task: 'organize',
    stage: 'folders',
    rootId,
    preference: value.preference,
    itemIds: options.unfiledOnly
      ? []
      : candidates.items.filter(item => nodes.get(item.id)?.ref.kind === 'folder').map(item => item.id),
    folderIds: candidates.folders.map(folder => folder.id),
    sampleLimit: 2,
  };
  const run: StagedRun = {
    context,
    checkpointBaseline: value.baseline,
    preference: value.preference,
    options,
    request,
    bookmarkIds: value.bookmarkIds,
    queue: [],
    batchIds: new Map(),
    finishedBatches: [],
    acceptedBatches: new Map(),
  };
  let proposal: OrganizeProposal | undefined;
  const finished: { count: number; actionIds: string[] }[] = [];
  let completed = 0,
    analyzed = 0;
  let lockedActionIds: string[] = [];
  if (value.folderPlan) {
    const output = parseModelOutput(value.folderPlan.output, {
      ...JSON.parse(serializeAiPayload(current.tree, current.privacy, request)),
      rootId,
    });
    if (!('moves' in output)) throw Error('invalid-organize-checkpoint');
    if (
      options.unfiledOnly &&
      (output.moves.length ||
        output.newFolders.length ||
        output.merges.length ||
        output.renames?.length ||
        output.removeFolders?.length)
    )
      throw Error('invalid-organize-checkpoint');
    run.folderOutput = output;
    proposal = organizeProposal(current.tree, rootId, output, current.privacy, options);
    validateSelection(proposal, value.folderPlan);
    run.folderReview = { proposal, selected: value.folderPlan.selected, targets: value.folderPlan.targets };
  }
  if (value.stage !== 'folders') {
    run.approved = approvedOrganizeFolders(proposal!, value.folderPlan!.selected, value.folderPlan!.targets);
    lockedActionIds = run.approved.proposal.actions.map(action => action.id);
    proposal = run.approved.proposal;
    run.request = {
      ...request,
      stage: 'bookmarks',
      sampleLimit: undefined,
      omittedItemsUnchanged: true,
      destinations: run.approved.destinations,
      placements: Object.fromEntries(bookmarkIds.map(id => [id, run.approved!.placements.get(id)!])),
    };
    for (const batch of value.batches) {
      const ids = [...batch.itemIds];
      run.batchIds!.set(ids, batch.id);
      if (!batch.output) {
        run.queue.push(ids);
        continue;
      }
      const output = parseModelOutput(batch.output, {
        ...JSON.parse(serializeAiPayload(current.tree, current.privacy, { ...run.request, itemIds: ids })),
        rootId,
      });
      if (!('moves' in output)) throw Error('invalid-organize-checkpoint');
      analyzed += ids.length;
      if (batch.status === 'accepted') {
        run.queue.push(ids);
        run.acceptedBatches!.set(ids, { status: 'completed', output });
      } else {
        const actions = organizeBookmarkActions(output, run, lockedActionIds);
        proposal = { ...proposal!, actions: [...proposal!.actions, ...actions] };
        completed += ids.length;
        run.finishedBatches!.push({ ids, output });
        finished.push({ count: ids.length, actionIds: actions.map(action => action.id) });
      }
    }
    if (value.stage === 'complete') proposal = organizeCleanup(proposal!, current.privacy, options);
    if (lockedActionIds.some(id => !value.selection.selected.includes(id))) throw Error('invalid-organize-checkpoint');
  }
  if (proposal) {
    // Check every reconstructed action, including suggestions currently deselected in the UI.
    if (proposal.actions.length)
      organizeCompilation(
        proposal,
        proposal.actions.map(action => action.id),
        {},
        'restored-all',
      );
    validateSelection(proposal, value.selection);
  } else if (value.selection.selected.length || Object.keys(value.selection.targets).length)
    throw Error('invalid-organize-checkpoint');
  const state: OrganizeState = {
    tree: { status: 'ready', snapshot: structuredClone(current.tree) },
    scopeId: rootId,
    proposal,
    selected: value.selection.selected,
    targets: value.selection.targets,
    busy: false,
    invalid: value.status === 'invalid',
    duplicates: [],
    choices: {},
    message:
      value.stage === 'complete'
        ? '已恢复完成的整理建议，请核对后确认执行。'
        : value.stage === 'folders'
          ? '已恢复目录方案；未完成的生成需要手动重新开始。'
          : '已恢复整理进度，继续时只分析未完成批次。',
    pipeline: {
      stage: value.stage,
      status: value.status === 'running' ? 'paused' : value.status,
      total: bookmarkIds.length,
      batchSize: options.batchSize,
      folderCount: request.folderIds.length,
      completed,
      analyzed,
      finished,
      lockedActionIds,
      batchCount: value.batches.length,
      elapsedMs: value.elapsedMs,
    },
  };
  return { run, state };
}
