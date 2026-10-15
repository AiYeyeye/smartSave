import type { OrganizeMemory } from '../persistence/organize-memory';
export type OrganizeMemoryEditor = (
  change: (value: OrganizeMemory) => OrganizeMemory,
  invalidate?: boolean,
) => Promise<void>;
