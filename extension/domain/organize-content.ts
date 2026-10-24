import { z } from 'zod';
import { organizeOutputSchema, type OrganizeOutput } from '../schemas/model-output';
import type { StagedRun } from './organize-state';

const ids = z.array(z.string().min(1));
export const organizeContentSchema = z.strictObject({
  phase: z.enum(['analysis', 'planning', 'assignment', 'revision', 'complete']),
  taxonomyRevision: z.literal([0, 1]),
  reviewedIds: ids.optional(),
  feedback: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        itemIds: ids.min(1).max(100),
        text: z.string().trim().min(1).max(1000),
        status: z.enum(['pending', 'done']),
      }),
    )
    .max(100)
    .optional(),
  analysis: z.array(
    z.strictObject({
      id: z.string().min(1),
      itemIds: ids.min(1),
      output: organizeOutputSchema.optional(),
    }),
  ),
  revisionSuggestions: organizeOutputSchema.shape.categorySuggestions,
});
export type OrganizeContent = z.infer<typeof organizeContentSchema>;

/** Every group survives aggregation; counts come from validated IDs, never the model. */
export function organizeTopicEvidence(outputs: OrganizeOutput[], revisions = false) {
  return outputs
    .flatMap(output => (revisions ? output.categorySuggestions : output.topics) ?? [])
    .map(topic => ({ title: topic.title, count: topic.itemIds.length, reason: topic.reason }));
}

export function organizeContentCoverage(run: StagedRun) {
  const outputs = (run.finishedBatches ?? []).map(batch => batch.output);
  return {
    taxonomyRevision: run.content?.taxonomyRevision,
    completedIds: (run.finishedBatches ?? []).flatMap(batch => batch.ids),
    bookmarkTargets: Object.fromEntries(
      (run.finishedBatches ?? []).flatMap(batch =>
        batch.ids.map(id => [
          id,
          batch.output.moves.find(move => move.itemId === id)?.folderId ?? run.approved?.placements.get(id) ?? '',
        ]),
      ),
    ),
    reviewedIds: run.content?.reviewedIds ?? [],
    reclassifyingIds: [
      ...new Set(run.content?.feedback?.filter(job => job.status === 'pending').flatMap(job => job.itemIds) ?? []),
    ],
    uncertainIds: outputs.flatMap(output => output.uncertainIds ?? []),
    unchangedIds: outputs.flatMap(output => output.unchangedIds ?? []),
  };
}
