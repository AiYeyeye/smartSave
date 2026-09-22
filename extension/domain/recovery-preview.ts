import type { z } from 'zod';
import type { batchCommandSchema, recoveryConflictSchema } from '../schemas/messages';
/** Shared proposal shape for undo/merge/copy previews; holding no logic keeps undo and placement acyclic. */
export type RecoveryPreview = { command: z.infer<typeof batchCommandSchema>; conflicts: z.infer<typeof recoveryConflictSchema>[] };
