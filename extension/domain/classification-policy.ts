import { z } from 'zod';
/** User-owned classification knobs: how deep a new folder chain may grow below the target/scope root, and whether titles that already exist may be rewritten. */
export const classificationPolicySchema = z.strictObject({
  maxNewDepth: z.literal([1, 2, 3, 4]),
  allowRename: z.boolean(),
  /** Organize only: how many category levels the taxonomy should have (1 = flat, 2 = broad/sub). */
  levels: z.literal([1, 2, 3]).optional(),
  /** One correction round: why the previous answer was rejected locally. Fixed text from PLAN_FEEDBACK only. */
  retryFeedback: z.string().max(600).optional(),
});
export type ClassificationPolicy = z.infer<typeof classificationPolicySchema>;
export const DEFAULT_CLASSIFICATION_POLICY: ClassificationPolicy = { maxNewDepth: 3, allowRename: false };
export type OrganizeLevels = 1 | 2 | 3;
export const DEFAULT_ORGANIZE_LEVELS: OrganizeLevels = 2;
/** Fixed explanations for local plan rejections that the model can usually fix in one more try. */
export const PLAN_FEEDBACK: Record<string, string> = {
  'overlapping-merge':
    'a folder was merged while items inside it were also moved or merged separately. For each folder, either merge it or move its contents, never both.',
  'unsafe-folder-removal':
    'removeFolders listed a folder that still has content or cannot be changed. Only remove folders that are already empty or emptied by this plan.',
  'protected-source':
    'an action moved, merged, renamed or removed the selected root or a read-only folder. Never change those.',
  'privacy-excluded-descendant':
    'an action moved or merged a folder whose contents are not all in the input. Only move or merge folders whose whole contents appear in the input.',
  'protected-folder':
    'an action changed a protected folder or its path. Leave protected folders and their parents unchanged.',
  'invalid-output':
    'the answer broke the output rules: every source and existing target must be a given id, and new folder ids must be declared in newFolders.',
  'invalid-organize-stage': 'the answer did not follow the rules of the current stage field.',
};
/** Organize runs: new folder chains may not grow deeper than the chosen taxonomy levels. */
export function organizePolicy(options: { allowRename?: boolean; levels?: OrganizeLevels }): ClassificationPolicy {
  const levels = options.levels ?? DEFAULT_ORGANIZE_LEVELS;
  return { maxNewDepth: levels, allowRename: options.allowRename ?? true, levels };
}
