import {
  organizeOutputSchema,
  parseModelOutput,
  type ModelOutputContext,
  type OrganizeOutput,
} from '../schemas/model-output';

export const ORGANIZE_REPAIR_LIMIT = 5;
/** In-memory evidence only. It is neither an accepted batch nor a writable proposal. */
export type OrganizeRepair = { retained: OrganizeOutput; itemIds: string[] };

export function analyzeOrganizeRepair(
  value: unknown,
  context: ModelOutputContext,
  knownIds: Iterable<string>,
): OrganizeRepair | undefined {
  if (context.task !== 'organize' || context.stage !== 'bookmarks' || context.omittedItemsUnchanged !== true) return;
  const parsed = organizeOutputSchema.safeParse(value);
  if (!parsed.success) return;
  const output = parsed.data;
  if (output.newFolders.length || output.merges.length || output.renames?.length || output.removeFolders?.length)
    return;
  const items = new Set(context.items.map(item => item.id));
  const folders = new Set(context.folders.map(folder => folder.id));
  const known = new Set(knownIds);
  const mentioned = [...output.moves.map(move => move.itemId), ...(output.unchangedIds ?? [])];
  if (new Set(mentioned).size !== mentioned.length || mentioned.some(id => !items.has(id))) return;
  const invalid = output.moves.filter(move => !folders.has(move.folderId));
  if (!invalid.length || invalid.length > ORGANIZE_REPAIR_LIMIT) return;
  // Existing but unauthorized targets (including bookmarks/removed aliases) are not typos to salvage.
  if (invalid.some(move => known.has(move.folderId) || items.has(move.folderId))) return;
  const itemIds = invalid.map(move => move.itemId);
  const pending = new Set(itemIds);
  try {
    const retained = parseModelOutput(
      { ...output, moves: output.moves.filter(move => !pending.has(move.itemId)) },
      { ...context, items: context.items.filter(item => !pending.has(item.id)) },
    );
    if (!('moves' in retained)) return;
    return { retained, itemIds };
  } catch {
    return;
  }
}

/** Validate the smaller reply, preserve retained rows, then revalidate the original complete batch. */
export function completeOrganizeRepair(repair: OrganizeRepair, value: unknown, context: ModelOutputContext) {
  const pending = new Set(repair.itemIds);
  if (
    !pending.size ||
    pending.size > ORGANIZE_REPAIR_LIMIT ||
    pending.size !== repair.itemIds.length ||
    context.task !== 'organize' ||
    context.stage !== 'bookmarks' ||
    repair.itemIds.some(id => !context.items.some(item => item.id === id))
  )
    throw Error('invalid-output');
  const repaired = parseModelOutput(value, { ...context, items: context.items.filter(item => pending.has(item.id)) });
  const retained = parseModelOutput(repair.retained, {
    ...context,
    items: context.items.filter(item => !pending.has(item.id)),
  });
  if (!('moves' in repaired) || !('moves' in retained)) throw Error('invalid-output');
  return parseModelOutput(
    {
      ...retained,
      moves: [...retained.moves, ...repaired.moves],
      unchangedIds: [...(retained.unchangedIds ?? []), ...(repaired.unchangedIds ?? [])],
    },
    context,
  );
}
