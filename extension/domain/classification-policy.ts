import { z } from 'zod';
/** User-owned classification knobs: how deep a new folder chain may grow below the target/scope root, and whether titles that already exist may be rewritten. */
export const classificationPolicySchema = z.strictObject({
  maxNewDepth: z.literal([1, 2, 3, 4]),
  allowRename: z.boolean(),
});
export type ClassificationPolicy = z.infer<typeof classificationPolicySchema>;
export const DEFAULT_CLASSIFICATION_POLICY: ClassificationPolicy = { maxNewDepth: 3, allowRename: false };
