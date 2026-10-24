import { z } from 'zod';
import type { OrganizeState, StagedRun } from './organize-state';
import { organizeBookmarkActions } from './organize-generation-checkpoint';
import { organizeCleanup, organizeCompilation, reconcileOrganizeSelection } from './organize-proposal';
import { organizeContentCoverage } from './organize-content';
import type { OrganizeOutput } from '../schemas/model-output';

export const organizeInteractionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('destination'),
    ids: z.array(z.string().min(1)).min(1).max(100),
    targetId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('feedback'),
    ids: z.array(z.string().min(1)).min(1).max(100),
    text: z.string().trim().min(1).max(1000),
  }),
]);
export type OrganizeInteraction = z.infer<typeof organizeInteractionSchema>;

/** Replace only completed item outcomes; canonical exhaustive batches survive restart unchanged. */
export function replaceContentAssignments(
  run: StagedRun,
  state: OrganizeState,
  ids: string[],
  replacement: OrganizeOutput,
) {
  const changed = new Set(ids);
  const batches = (run.finishedBatches ?? []).map(batch => {
    const own = new Set(batch.ids.filter(id => changed.has(id)));
    if (!own.size) return batch;
    const output: OrganizeOutput = {
      ...batch.output,
      moves: [
        ...batch.output.moves.filter(move => !own.has(move.itemId)),
        ...replacement.moves.filter(move => own.has(move.itemId)),
      ],
      unchangedIds: [
        ...(batch.output.unchangedIds ?? []).filter(id => !own.has(id)),
        ...(replacement.unchangedIds ?? []).filter(id => own.has(id)),
      ],
      uncertainIds: [
        ...(batch.output.uncertainIds ?? []).filter(id => !own.has(id)),
        ...(replacement.uncertainIds ?? []).filter(id => own.has(id)),
      ],
      categorySuggestions: (batch.output.categorySuggestions ?? [])
        .map(suggestion => ({ ...suggestion, itemIds: suggestion.itemIds.filter(id => !own.has(id)) }))
        .filter(suggestion => suggestion.itemIds.length),
    };
    return { ...batch, output };
  });
  const dependencies = run.approved!.proposal.actions.map(action => action.id);
  let proposal = {
    ...run.approved!.proposal,
    actions: [
      ...run.approved!.proposal.actions,
      ...batches.flatMap(batch => organizeBookmarkActions(batch.output, run, dependencies)),
    ],
  };
  if (run.content?.phase === 'complete') proposal = organizeCleanup(proposal, run.context.privacy, run.options);
  const targets = Object.fromEntries(
    Object.entries(state.targets).filter(
      ([id]) => !changed.has(id.replace(/^move:/, '')) && proposal.actions.some(action => action.id === id),
    ),
  );
  const selected = reconcileOrganizeSelection(
    proposal,
    [
      ...state.selected.filter(id => proposal.actions.some(action => action.id === id)),
      ...proposal.actions.filter(action => changed.has(action.sourceId)).map(action => action.id),
    ],
    targets,
  );
  if (proposal.actions.length)
    organizeCompilation(
      proposal,
      proposal.actions.map(action => action.id),
      {},
      'interactive-preview',
    );
  if (selected.length) organizeCompilation(proposal, selected, targets, 'interactive-selection');
  run.finishedBatches = batches;
  state.proposal = proposal;
  state.targets = targets;
  state.selected = selected;
  state.pipeline = {
    ...state.pipeline!,
    ...organizeContentCoverage(run),
    finished: batches.map(batch => ({
      count: batch.ids.length,
      actionIds: organizeBookmarkActions(batch.output, run, dependencies).map(action => action.id),
    })),
  };
}

export function reviewContent(run: StagedRun, state: OrganizeState, input: OrganizeInteraction) {
  const edit = organizeInteractionSchema.parse(input);
  const content = run.content;
  const completed = new Set(run.finishedBatches?.flatMap(batch => batch.ids));
  if (
    !content ||
    !run.approved ||
    state.invalid ||
    state.result ||
    !['assignment', 'complete'].includes(content.phase) ||
    new Set(edit.ids).size !== edit.ids.length ||
    edit.ids.some(id => !completed.has(id))
  )
    throw Error('organize-task-conflict');
  if (edit.kind === 'destination') {
    if (!run.approved.destinations.some(folder => folder.id === edit.targetId)) throw Error('invalid-target');
    replaceContentAssignments(run, state, edit.ids, {
      moves: edit.ids
        .filter(id => run.approved!.placements.get(id) !== edit.targetId)
        .map(itemId => ({ itemId, folderId: edit.targetId })),
      unchangedIds: edit.ids.filter(id => run.approved!.placements.get(id) === edit.targetId),
      uncertainIds: [],
      newFolders: [],
      merges: [],
    });
    content.reviewedIds = [...new Set([...(content.reviewedIds ?? []), ...edit.ids])];
  } else {
    if ((content.feedback?.length ?? 0) >= 100) throw Error('organize-feedback-limit');
    content.reviewedIds = (content.reviewedIds ?? []).filter(id => !edit.ids.includes(id));
    content.feedback = [
      ...(content.feedback ?? []),
      { id: crypto.randomUUID(), itemIds: edit.ids, text: edit.text, status: 'pending' },
    ];
    content.phase = 'assignment';
    state.pipeline = {
      ...state.pipeline!,
      stage: 'bookmarks',
      contentPhase: 'assignment',
      status: state.busy ? 'running' : 'paused',
    };
    replaceContentAssignments(run, state, [], { moves: [], newFolders: [], merges: [] });
  }
  state.pipeline = { ...state.pipeline!, ...organizeContentCoverage(run) };
  return edit;
}
