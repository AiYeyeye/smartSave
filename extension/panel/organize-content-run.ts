import { MODEL_BYTE_LIMITS } from '../adapters/model-byte-limits';
import { serializeAiPayload, serializedItemRequestSize } from '../domain/ai-payload';
import { approvedOrganizeFolders, partitionOrganizeItems, type OrganizeRequest } from '../domain/organize-batches';
import { organizeContentCoverage, organizeTopicEvidence } from '../domain/organize-content';
import { replaceContentAssignments } from '../domain/organize-interaction';
import { organizeBookmarkActions } from '../domain/organize-generation-checkpoint';
import {
  organizeCleanup,
  organizeCompilation,
  organizeProposal,
  reconcileOrganizeSelection,
  type OrganizeAction,
  type OrganizeProposal,
} from '../domain/organize-proposal';
import { organizePolicy, PLAN_FEEDBACK } from '../domain/classification-policy';
import type { OrganizeState, StagedRun } from '../domain/organize-state';
import { modelOutputTokenLimit, modelStreaming } from '../domain/model-route';
import { parseModelOutput, type OrganizeOutput } from '../schemas/model-output';
import { runOrganizeBatch, organizeRequestSize, MODEL_WAIT_MS, type OrganizeModel } from './organize-batch-request';

export function contentBatches(run: StagedRun, request: OrganizeRequest) {
  return partitionOrganizeItems(
    run.bookmarkIds,
    serializedItemRequestSize(
      serializeAiPayload(run.context.tree, run.context.privacy, { ...request, itemIds: run.bookmarkIds }),
      organizeRequestSize(run, { ...request, itemIds: [] }),
    ),
    run.options.batchSize,
    MODEL_BYTE_LIMITS.requestBytes,
  );
}

/** Read-only transitions belong to the worker, never a mounted review component. */
export async function runContentOrganize({
  run,
  state,
  model,
  signal,
  diagnosticRunId,
  publish,
  persist,
  check,
  rejected,
}: {
  run: StagedRun;
  state: OrganizeState;
  model: OrganizeModel;
  signal: AbortSignal;
  diagnosticRunId?: string;
  publish: () => void;
  persist: () => Promise<void>;
  check: () => Promise<void>;
  rejected: (proposal: OrganizeProposal, action: OrganizeAction) => boolean;
}) {
  const content = run.content!;
  const alive = () => {
    if (signal.aborted) throw Error('cancelled');
  };
  const save = async () => {
    alive();
    publish();
    await persist();
    alive();
  };
  const base: OrganizeRequest = {
    task: 'organize',
    rootId: run.request.rootId,
    folderIds: run.request.folderIds,
    preference: run.preference,
    itemIds: [],
    contentFirst: true,
    preserveExistingFolders: !!run.options.unfiledOnly,
  };
  const requestOnce = async (request: OrganizeRequest, retryFeedback?: string) => {
    alive();
    await check();
    alive();
    run.request = request;
    if (organizeRequestSize(run, request) > MODEL_BYTE_LIMITS.requestBytes)
      throw Error(request.stage === 'folders' ? 'folder-context-too-large' : 'bookmark-context-too-large');
    const timeoutMs = Math.max(run.context.config.timeoutMs, MODEL_WAIT_MS);
    state.progress = {
      phase: 'waiting',
      streaming: modelStreaming(run.context.config),
      receivedChars: 0,
      preview: [],
      timeoutSeconds: Math.ceil(timeoutMs / 1000),
      bookmarkCount: request.itemIds.length,
      outputTokenLimit: modelOutputTokenLimit(run.context.config),
    };
    publish();
    const result = await runOrganizeBatch({
      run,
      ids: request.itemIds,
      signal,
      model,
      repairOnce: false,
      diagnosticRunId,
      retryFeedback,
      onProgress: (update, context) => {
        if (signal.aborted) return;
        state.progress = {
          phase: update.phase,
          streaming: update.streaming,
          receivedChars: update.receivedChars,
          preview: [],
          timeoutSeconds: Math.ceil(context.timeoutMs / 1000),
          bookmarkCount: context.bookmarkCount,
          outputTokenLimit: modelOutputTokenLimit(run.context.config),
        };
        publish();
      },
    });
    alive();
    await check();
    alive();
    if (result.status !== 'completed') throw Error(result.detail ?? result.reason ?? 'model-failed');
    const output = parseModelOutput(result.output, {
      ...JSON.parse(serializeAiPayload(run.context.tree, run.context.privacy, request)),
      policy: organizePolicy(run.options),
      rootId: request.rootId,
    });
    if (!('moves' in output)) throw Error('invalid-organize-stage');
    if (request.stage === 'bookmarks') {
      const same = output.moves.filter(move => move.folderId === request.placements?.[move.itemId]);
      output.unchangedIds = [...(output.unchangedIds ?? []), ...same.map(move => move.itemId)];
      const unchanged = new Set(output.unchangedIds);
      output.moves = output.moves.filter(move => !unchanged.has(move.itemId));
    }
    return output;
  };
  const requestOutput = async (request: OrganizeRequest, validate?: (output: OrganizeOutput) => void) => {
    let feedback: string | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const output = await requestOnce(request, feedback);
        validate?.(output);
        return output;
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (attempt || !Object.hasOwn(PLAN_FEEDBACK, code)) throw error;
        feedback = PLAN_FEEDBACK[code];
      }
    }
  };
  const splitError = (error: unknown, ids: string[]) =>
    ids.length > 1 &&
    error instanceof Error &&
    ['output-limit', 'payload-too-large', 'response-too-large'].includes(error.message);
  while (content.phase !== 'complete') {
    alive();
    if (content.phase === 'analysis') {
      state.message = '正在逐条分析书签内容，收集完整分类依据…';
      for (let index = 0; index < content.analysis.length; index++) {
        const batch = content.analysis[index]!;
        if (batch.output) continue;
        try {
          batch.output = await requestOutput({ ...base, stage: 'analysis', itemIds: batch.itemIds });
        } catch (error) {
          if (!splitError(error, batch.itemIds)) throw error;
          const half = Math.ceil(batch.itemIds.length / 2);
          content.analysis.splice(
            index,
            1,
            ...[batch.itemIds.slice(0, half), batch.itemIds.slice(half)].map(itemIds => ({
              id: crypto.randomUUID(),
              itemIds,
            })),
          );
          index--;
        }
        state.pipeline = {
          ...state.pipeline!,
          topicCompleted: content.analysis.reduce((count, item) => count + (item.output ? item.itemIds.length : 0), 0),
        };
        await save();
      }
      content.phase = 'planning';
      state.pipeline = { ...state.pipeline!, contentPhase: 'planning' };
      await save();
    } else if (content.phase === 'planning' || content.phase === 'revision') {
      state.message =
        content.phase === 'revision'
          ? '正在根据完整书签分析补充分类，随后重新核对全部书签…'
          : '已分析全部书签，正在汇总主题并生成分类草案…';
      const folders = new Set(
        run.context.tree.nodes
          .filter(node => node.ref.kind === 'folder' && !node.readOnly && node.ref.nativeId !== base.rootId)
          .map(node => node.ref.nativeId),
      );
      const request: OrganizeRequest = {
        ...base,
        stage: 'folders',
        sampleLimit: 0,
        itemIds: run.options.unfiledOnly ? [] : base.folderIds.filter(id => folders.has(id)),
        topicEvidence: organizeTopicEvidence(content.analysis.flatMap(batch => (batch.output ? [batch.output] : []))),
        revisionEvidence: organizeTopicEvidence(
          [{ moves: [], merges: [], newFolders: [], categorySuggestions: content.revisionSuggestions }],
          true,
        ),
      };
      const output: OrganizeOutput = run.bookmarkIds.length
        ? await requestOutput(request, candidate => {
            if (
              run.options.unfiledOnly &&
              (candidate.moves.length ||
                candidate.merges.length ||
                candidate.renames?.length ||
                candidate.removeFolders?.length)
            )
              throw Error('protected-source');
            const proposed = organizeProposal(run.context.tree, base.rootId, candidate, run.context.privacy, {
              ...run.options,
              cleanupEmpty: false,
            });
            if (proposed.actions.length)
              organizeCompilation(
                proposed,
                proposed.actions.map(action => action.id),
                {},
                'content-taxonomy',
              );
          })
        : { moves: [], newFolders: [], merges: [] };
      if (
        run.options.unfiledOnly &&
        (output.moves.length || output.merges.length || output.renames?.length || output.removeFolders?.length)
      )
        throw Error('invalid-organize-plan');
      const proposal = organizeProposal(run.context.tree, base.rootId, output, run.context.privacy, {
        ...run.options,
        cleanupEmpty: false,
      });
      const selected = reconcileOrganizeSelection(
        proposal,
        proposal.actions.filter(action => !rejected(proposal, action)).map(action => action.id),
        {},
      );
      const approved = approvedOrganizeFolders(proposal, selected, {});
      const assignment: OrganizeRequest = {
        ...base,
        stage: 'bookmarks',
        destinations: approved.destinations,
        placements: Object.fromEntries(run.bookmarkIds.map(id => [id, approved.placements.get(id)!])),
      };
      // Build the next queue before replacing any durable state. A failed sizing check leaves planning resumable.
      const queue = contentBatches(run, assignment);
      run.folderOutput = output;
      run.folderReview = { proposal, selected, targets: {} };
      run.approved = approved;
      run.request = assignment;
      run.queue = queue;
      run.finishedBatches = [];
      run.batchIds = new Map(queue.map(ids => [ids, crypto.randomUUID()]));
      run.acceptedBatches = new Map();
      state.proposal = approved.proposal;
      state.selected = approved.proposal.actions.map(action => action.id);
      state.targets = {};
      content.phase = 'assignment';
      state.pipeline = {
        ...state.pipeline!,
        stage: 'bookmarks',
        contentPhase: 'assignment',
        completed: 0,
        analyzed: 0,
        finished: [],
        batchCount: queue.length,
        lockedActionIds: [...state.selected],
        uncertainIds: [],
        unchangedIds: [],
      };
      await save();
    } else {
      state.message = '正在按分类草案逐条核对书签，检查是否需要补充类别…';
      while (run.queue.length || content.feedback?.some(job => job.status === 'pending')) {
        const feedback = content.feedback?.find(job => job.status === 'pending');
        if (feedback) {
          const ownedIds = () =>
            feedback.itemIds.filter(
              id =>
                !content.reviewedIds?.includes(id) &&
                [...(content.feedback ?? [])].reverse().find(job => job.itemIds.includes(id))?.id === feedback.id,
            );
          const ids = ownedIds();
          if (ids.length) {
            const output = await requestOutput({
              ...base,
              stage: 'bookmarks',
              itemIds: ids,
              destinations: run.approved!.destinations,
              placements: Object.fromEntries(run.bookmarkIds.map(id => [id, run.approved!.placements.get(id)!])),
              userFeedback: feedback.text,
            });
            replaceContentAssignments(run, state, ownedIds(), output);
          }
          feedback.status = 'done';
          state.pipeline = { ...state.pipeline!, ...organizeContentCoverage(run) };
          await save();
          continue;
        }
        const ids = run.queue[0]!;
        let output: OrganizeOutput;
        try {
          output = await requestOutput({
            ...base,
            stage: 'bookmarks',
            itemIds: ids,
            destinations: run.approved!.destinations,
            placements: Object.fromEntries(run.bookmarkIds.map(id => [id, run.approved!.placements.get(id)!])),
          });
        } catch (error) {
          if (!splitError(error, ids)) throw error;
          const half = Math.ceil(ids.length / 2);
          run.queue.splice(0, 1, ids.slice(0, half), ids.slice(half));
          state.pipeline = { ...state.pipeline!, batchCount: state.pipeline!.batchCount + 1 };
          await save();
          continue;
        }
        const dependencies = run.approved!.proposal.actions.map(action => action.id);
        const actions = organizeBookmarkActions(output, run, dependencies);
        const proposal = { ...state.proposal!, actions: [...state.proposal!.actions, ...actions] };
        if (proposal.actions.length)
          organizeCompilation(
            proposal,
            proposal.actions.map(action => action.id),
            {},
            'content-preview',
          );
        state.proposal = proposal;
        state.selected = reconcileOrganizeSelection(
          proposal,
          [...state.selected, ...actions.filter(action => !rejected(proposal, action)).map(action => action.id)],
          state.targets,
        );
        run.finishedBatches ??= [];
        run.finishedBatches.push({ ids, output });
        run.queue.shift();
        state.pipeline = {
          ...state.pipeline!,
          completed: state.pipeline!.completed + ids.length,
          analyzed: state.pipeline!.completed + ids.length,
          finished: [...state.pipeline!.finished, { count: ids.length, actionIds: actions.map(action => action.id) }],
          ...organizeContentCoverage(run),
        };
        await save();
      }
      const suggestions = (run.finishedBatches ?? []).flatMap(batch => batch.output.categorySuggestions ?? []);
      if (
        suggestions.length &&
        content.taxonomyRevision === 0 &&
        !content.reviewedIds?.length &&
        !content.feedback?.length
      ) {
        content.revisionSuggestions = suggestions;
        content.taxonomyRevision = 1;
        content.phase = 'revision';
        // Every prior assignment belongs to the old draft. Invalidate all of them in this one checkpoint transition.
        run.folderOutput = undefined;
        run.folderReview = undefined;
        run.approved = undefined;
        run.finishedBatches = [];
        run.acceptedBatches?.clear();
        run.batchIds?.clear();
        state.proposal = undefined;
        state.selected = [];
        state.targets = {};
        state.pipeline = {
          ...state.pipeline!,
          stage: 'folders',
          contentPhase: 'revision',
          taxonomyRevision: 1,
          completed: 0,
          analyzed: 0,
          finished: [],
          batchCount: 0,
          lockedActionIds: [],
          uncertainIds: [],
          unchangedIds: [],
        };
        await save();
        continue;
      }
      await check();
      alive();
      if (content.feedback?.some(job => job.status === 'pending')) continue;
      const oldActions = new Set(state.proposal!.actions.map(action => action.id));
      const proposal = organizeCleanup(state.proposal!, run.context.privacy, run.options);
      state.proposal = proposal;
      state.selected = reconcileOrganizeSelection(
        proposal,
        [
          ...state.selected,
          ...proposal.actions
            .filter(action => !oldActions.has(action.id) && !rejected(proposal, action))
            .map(action => action.id),
        ],
        state.targets,
      );
      content.phase = 'complete';
      state.pipeline = {
        ...state.pipeline!,
        stage: 'complete',
        contentPhase: 'complete',
        status: 'review',
        lockedActionIds: [],
        ...organizeContentCoverage(run),
      };
      state.message = '全部书签已核对。请查看完整方案和待确认书签，再确认执行。';
      await save();
    }
  }
}
