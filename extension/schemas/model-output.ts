import { z } from 'zod';
import { historyQuerySchema } from '../domain/history-search';
import { AI_SEARCH_RESULTS, AI_SEARCH_TERMS, AI_SEARCH_TERM_CHARS } from '../domain/search-limits';
import { bookmarkKeywordsSchema } from '../domain/bookmark-keywords';
import {
  preferenceCharacters,
  PREFERENCE_CHARACTER_LIMIT,
  PREFERENCE_TEXT_CODE_UNITS,
} from '../domain/personalization';
const id = z.string().min(1);
// urlPath null is an explicit refusal: no field of this shape holds a URL. It must not be paired with a title path.
const mapping = z.strictObject({ urlPath: z.array(id).min(1).nullable(), titlePath: z.array(id).min(1).nullable() });
const search = z.strictObject({ rankedIds: z.array(id) });
const searchBatch = z.strictObject({
  matchedIds: z.array(id),
  unmatchedIds: z.array(id),
  uncertainIds: z.array(id),
});
export type SearchBatchOutput = z.infer<typeof searchBatch>;
const searchExpansion = z.strictObject({
  terms: z.array(z.string().trim().min(1).max(AI_SEARCH_TERM_CHARS)).min(1).max(AI_SEARCH_TERMS),
});
const searchPlan = z.strictObject({
  folderIds: z.array(id),
  terms: z.array(z.string().trim().min(1).max(AI_SEARCH_TERM_CHARS)).max(AI_SEARCH_TERMS),
});
export type SearchPlanOutput = z.infer<typeof searchPlan>;
const folder = z.strictObject({ id, parentId: id, title: z.string().min(1) });
const assignments = z.strictObject({
  assignments: z.array(
    z.strictObject({
      itemId: id,
      folderId: id,
      keywords: bookmarkKeywordsSchema.optional(),
      suggestedTitle: z.string().trim().min(1).max(200).optional(),
    }),
  ),
  newFolders: z.array(folder),
});
const rename = z.strictObject({
  suggestions: z.array(
    z.strictObject({
      itemId: id,
      title: z.string(),
      decision: z.enum(['rename', 'keep', 'uncertain']),
      reason: z.string().trim().max(500),
    }),
  ),
});
export type RenameOutput = z.infer<typeof rename>;
const importAssignments = z.strictObject({
  assignments: z.array(z.strictObject({ itemId: id, folderId: id, title: z.string().min(1).optional() })),
  newFolders: z.array(folder),
});
const organize = z.strictObject({
  topics: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(200),
        itemIds: z.array(id).min(1),
        reason: z.string().max(500).optional(),
      }),
    )
    .optional(),
  uncertainIds: z.array(id).optional(),
  categorySuggestions: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(200),
        itemIds: z.array(id).min(1),
        reason: z.string().max(500).optional(),
      }),
    )
    .optional(),
  unchangedIds: z
    .array(id)
    .optional()
    .describe(
      'In the folders stage, optional existing folder IDs with no direct action; not exhaustive. In the bookmarks stage, every input item must occur exactly once in moves or unchangedIds, unless input.omittedItemsUnchanged=true: then omitted items are kept locally and unchangedIds may be omitted.',
    ),
  moves: z.array(z.strictObject({ itemId: id, folderId: id, reason: z.string().max(500).optional() })),
  newFolders: z.array(folder.extend({ reason: z.string().max(500).optional() })),
  merges: z.array(z.strictObject({ sourceId: id, targetId: id, reason: z.string().max(500).optional() })),
  renames: z
    .array(
      z.strictObject({
        folderId: id,
        title: z.string().trim().min(1).max(200),
        reason: z.string().max(500).optional(),
      }),
    )
    .optional(),
  removeFolders: z.array(z.strictObject({ folderId: id, reason: z.string().max(500).optional() })).optional(),
});
export { organize as organizeOutputSchema };
export type OrganizeOutput = z.infer<typeof organize>;
const preferenceSummary = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(PREFERENCE_TEXT_CODE_UNITS),
        exampleIds: z.array(z.string().min(1)).min(1).max(30),
      }),
    )
    .max(10),
});
export interface ModelOutputContext {
  examples?: { id: string; text: string }[];
  characterLimit?: number;
  ruleLimit?: number;
  latestExampleIds?: string[];
  task: string;
  items: { id: string; title: string; url?: string }[];
  folders: { id: string; path?: string[]; ancestorIds?: string[] }[];
  fields?: { path: string[] }[];
  policy?: { maxNewDepth: number; allowRename: boolean };
  rootId?: string;
  stage?: 'analysis' | 'folders' | 'bookmarks';
  contentFirst?: boolean;
  omittedItemsUnchanged?: boolean;
}
export function outputSchema(task: string) {
  if (task === 'rename') return rename;
  if (task === 'preference-summary') return preferenceSummary;
  if (task === 'search-batch') return searchBatch;
  if (task === 'search-plan') return searchPlan;
  if (task === 'history-query') return historyQuerySchema;
  if (task === 'history-rank') return search.extend({ rankedIds: z.array(id).max(AI_SEARCH_RESULTS) });
  if (task === 'search-expand') return searchExpansion;
  return task === 'import-classify'
    ? importAssignments
    : task === 'import-map'
      ? mapping
      : task === 'search'
        ? search
        : task === 'organize'
          ? organize
          : assignments;
}
export function modelOutputJsonSchema(task: string) {
  return z.toJSONSchema(outputSchema(task));
}
/** Safe diagnostic labels only; never retain model values, titles, URLs or credentials. */
export class ModelOutputValidationError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
  ) {
    super('invalid-output');
    this.name = 'ModelOutputValidationError';
  }
}
function reject(code: string, path: string): never {
  throw new ModelOutputValidationError(code, path);
}
export function parseModelOutput(
  value: unknown,
  context: ModelOutputContext,
): z.infer<ReturnType<typeof outputSchema>> | SearchPlanOutput {
  try {
    if (context.task === 'search-plan') {
      const result = searchPlan.parse(value);
      const offered = new Set(context.folders.map(folder => folder.id));
      if (new Set(result.folderIds).size !== result.folderIds.length) reject('duplicate-id', 'folderIds');
      if (result.folderIds.some(id => !offered.has(id))) reject('unknown-folder', 'folderIds');
      if (result.folderIds.length !== offered.size) reject('missing-folders', 'folderIds');
      return result;
    }
    const result = outputSchema(context.task).parse(value);
    if ('suggestions' in result) {
      const ids = new Set(context.items.map(item => item.id));
      const seen = new Set<string>();
      for (const entry of result.suggestions) {
        if (!ids.has(entry.itemId) || seen.has(entry.itemId)) reject('invalid-rename-id', 'suggestions');
        seen.add(entry.itemId);
        if (entry.decision === 'rename') {
          entry.title = entry.title.trim();
          if (!entry.title || entry.title.length > 200) reject('invalid-rename-title', 'suggestions');
        }
        if (entry.decision !== 'rename' && entry.title !== context.items.find(item => item.id === entry.itemId)?.title)
          reject('unchanged-rename-title', 'suggestions');
      }
      if (seen.size !== ids.size) reject('incomplete-rename-coverage', 'suggestions');
      return result;
    }
    if ('rules' in result) {
      const offered = new Set(context.examples?.map(example => example.id));
      if (
        result.rules.some(
          rule =>
            rule.exampleIds.some(id => !offered.has(id)) || new Set(rule.exampleIds).size !== rule.exampleIds.length,
        )
      )
        reject('unknown-example', 'rules');
      if (
        preferenceCharacters(result.rules) > (context.characterLimit ?? PREFERENCE_CHARACTER_LIMIT) ||
        result.rules.length > (context.ruleLimit ?? 10)
      )
        reject('preference-capacity', 'rules');
      if (context.latestExampleIds?.some(id => !result.rules.some(rule => rule.exampleIds.includes(id))))
        reject('missing-preference', 'rules');
      return result;
    }
    if ('terms' in result) return result;
    if ('urlPath' in result) {
      const paths = new Set(context.fields?.map(f => JSON.stringify(f.path)));
      if (result.urlPath === null) {
        if (result.titlePath !== null) reject('title-without-url', 'titlePath');
        return result;
      }
      if (!paths.has(JSON.stringify(result.urlPath))) reject('unknown-field-path', 'urlPath');
      if (result.titlePath !== null && !paths.has(JSON.stringify(result.titlePath)))
        reject('unknown-field-path', 'titlePath');
      return result;
    }
    const unique = (ids: string[], path: string) => {
      if (new Set(ids).size !== ids.length) reject('duplicate-id', path);
    };
    const items = new Set(context.items.map(i => i.id));
    const folders = new Set(context.folders.map(f => f.id));
    if ('matchedIds' in result) {
      const accounted = [...result.matchedIds, ...result.unmatchedIds, ...result.uncertainIds];
      unique(accounted, 'search-coverage');
      if (accounted.some(id => !items.has(id))) reject('unknown-item', 'search-coverage');
      if (accounted.length !== items.size) reject('missing-items', 'search-coverage');
      return result;
    }
    if ('merges' in result && context.stage === 'analysis') {
      for (const field of [
        'moves',
        'newFolders',
        'merges',
        'renames',
        'removeFolders',
        'unchangedIds',
        'categorySuggestions',
      ] as const)
        if (result[field]?.length) reject('actions-in-analysis', field);
      const accounted = [...(result.topics ?? []).flatMap(topic => topic.itemIds), ...(result.uncertainIds ?? [])];
      unique(accounted, 'topics+uncertainIds');
      if (accounted.some(id => !items.has(id))) reject('unknown-item', 'topics+uncertainIds');
      if (accounted.length !== items.size) reject('missing-items', 'topics+uncertainIds');
      return result;
    }
    if ('rankedIds' in result) {
      unique(result.rankedIds, 'rankedIds');
      result.rankedIds.forEach((id, index) => {
        if (!items.has(id)) reject('unknown-item', `rankedIds.${index}`);
      });
      return result;
    }
    unique(
      result.newFolders.map(f => f.id),
      'newFolders.id',
    );
    const parents = new Map(result.newFolders.map(f => [f.id, f.parentId]));
    for (const [index, f] of result.newFolders.entries()) {
      if (folders.has(f.id) || items.has(f.id)) reject('existing-id', `newFolders.${index}.id`);
      let parent = f.parentId;
      const seen = new Set([f.id]);
      while (!folders.has(parent)) {
        if (seen.has(parent)) reject('folder-parent-cycle', `newFolders.${index}.parentId`);
        seen.add(parent);
        const next = parents.get(parent);
        if (!next) reject('unknown-parent', `newFolders.${index}.parentId`);
        parent = next;
      }
    }
    if (context.policy && context.rootId) {
      // Depth counts from the target/scope root (root = 0, its direct children = 1). Only new chains are capped; reusing a deeper existing folder stays allowed.
      const rootId = context.rootId;
      const max = context.policy.maxNewDepth;
      const known = new Map(context.folders.map(f => [f.id, f]));
      const depth = (id: string, path: string) => {
        if (id === rootId) return 0;
        const index = known.get(id)?.ancestorIds?.indexOf(rootId) ?? -1;
        if (index < 0) reject('parent-outside-root', path);
        return index + 1;
      };
      for (const [index, f] of result.newFolders.entries()) {
        let parent = f.parentId;
        let length = 1;
        while (parents.has(parent)) {
          parent = parents.get(parent)!;
          length++;
        }
        const path = `newFolders.${index}.parentId`;
        if (depth(parent, path) + length > max) reject('max-new-depth', path);
      }
    }
    const targets = new Set([...folders, ...parents.keys()]);
    const descendant = (source: string, target: string) => {
      let current = target;
      const seen = new Set<string>();
      while (parents.has(current)) {
        if (current === source || seen.has(current)) return true;
        seen.add(current);
        current = parents.get(current)!;
      }
      return current === source || context.folders.find(f => f.id === current)?.ancestorIds?.includes(source) === true;
    };
    const actions = 'assignments' in result ? result.assignments : result.moves;
    const actionPath = 'assignments' in result ? 'assignments' : 'moves';
    unique(
      actions.map(a => a.itemId),
      `${actionPath}.itemId`,
    );
    actions.forEach((action, index) => {
      if (!items.has(action.itemId)) reject('unknown-item', `${actionPath}.${index}.itemId`);
      if (!targets.has(action.folderId)) reject('unknown-target', `${actionPath}.${index}.folderId`);
      if (descendant(action.itemId, action.folderId))
        reject('target-is-self-or-descendant', `${actionPath}.${index}.folderId`);
    });
    if ('assignments' in result && actions.length !== items.size) reject('missing-items', 'assignments');
    if ('merges' in result) {
      if (result.topics?.length) reject('topics-outside-analysis', 'topics');
      if (!context.contentFirst && (result.uncertainIds?.length || result.categorySuggestions?.length))
        reject('unexpected-content-result', 'uncertainIds');
      if (context.stage === 'bookmarks') {
        for (const field of ['newFolders', 'merges', 'renames', 'removeFolders'] as const)
          if (result[field]?.length) reject('taxonomy-change-in-bookmark-stage', field);
        const accounted = [
          ...result.moves.map(m => m.itemId),
          ...(result.unchangedIds ?? []),
          ...(result.uncertainIds ?? []),
        ];
        unique(accounted, 'moves+unchangedIds');
        if (accounted.some(id => !items.has(id))) reject('unknown-item', 'unchangedIds');
        const uncertain = new Set(result.uncertainIds ?? []);
        const suggested = (result.categorySuggestions ?? []).flatMap(suggestion => suggestion.itemIds);
        unique(suggested, 'categorySuggestions.itemIds');
        if (suggested.some(id => !uncertain.has(id))) reject('suggestion-without-uncertainty', 'categorySuggestions');
        if (context.omittedItemsUnchanged === true && !context.contentFirst) {
          const mentioned = new Set(accounted);
          result.unchangedIds = [...(result.unchangedIds ?? []), ...[...items].filter(id => !mentioned.has(id))];
        } else if (accounted.length !== items.size) reject('missing-items', 'moves+unchangedIds');
      }
      if (context.stage === 'folders') {
        if (result.uncertainIds?.length || result.categorySuggestions?.length)
          reject('bookmark-results-in-folders', 'uncertainIds');
        // Informational no-ops are allowed by the shared output schema. Check
        // their identity and consistency before discarding them, never actions.
        const unchanged = result.unchangedIds ?? [];
        unique(unchanged, 'unchangedIds');
        const changed = new Set([
          ...result.moves.map(m => m.itemId),
          ...result.merges.map(m => m.sourceId),
          ...(result.renames ?? []).map(r => r.folderId),
          ...(result.removeFolders ?? []).map(r => r.folderId),
        ]);
        unchanged.forEach((id, index) => {
          if (!folders.has(id)) reject('unknown-folder', `unchangedIds.${index}`);
          if (changed.has(id)) reject('unchanged-folder-has-action', `unchangedIds.${index}`);
        });
        delete result.unchangedIds;
      }
      const renames = result.renames ?? [];
      const removals = result.removeFolders ?? [];
      unique(
        renames.map(r => r.folderId),
        'renames.folderId',
      );
      unique(
        removals.map(r => r.folderId),
        'removeFolders.folderId',
      );
      unique(
        result.merges.map(m => m.sourceId),
        'merges.sourceId',
      );
      for (const [field, entries] of [
        ['renames', renames],
        ['removeFolders', removals],
      ] as const)
        entries.forEach((entry, index) => {
          if (!folders.has(entry.folderId)) reject('unknown-folder', `${field}.${index}.folderId`);
        });
      const removed = new Set([...removals.map(r => r.folderId), ...result.merges.map(m => m.sourceId)]);
      renames.forEach((entry, index) => {
        if (removed.has(entry.folderId)) reject('rename-removed-folder', `renames.${index}.folderId`);
      });
      result.moves.forEach((entry, index) => {
        if (removed.has(entry.itemId)) reject('move-removed-folder', `moves.${index}.itemId`);
      });
      if (context.policy?.allowRename === false && result.renames) result.renames = [];
      // Both action kinds write the same identity; reject overlap before Map can erase an edge.
      unique([...result.moves.map(m => m.itemId), ...result.merges.map(m => m.sourceId)], 'moves+merges');
      for (const [index, m] of result.merges.entries()) {
        if (!folders.has(m.sourceId)) reject('unknown-merge-source', `merges.${index}.sourceId`);
        if (!targets.has(m.targetId)) reject('unknown-merge-target', `merges.${index}.targetId`);
        if (descendant(m.sourceId, m.targetId)) reject('target-is-self-or-descendant', `merges.${index}.targetId`);
      }
      const edges = new Map([
        ...result.moves.map(m => [m.itemId, m.folderId] as const),
        ...result.merges.map(m => [m.sourceId, m.targetId] as const),
        ...parents,
      ]);
      for (const start of edges.keys()) {
        const seen = new Set<string>();
        let cursor: string | undefined = start;
        while (cursor !== undefined) {
          if (seen.has(cursor)) reject('action-cycle', 'moves+merges+newFolders');
          seen.add(cursor);
          cursor = edges.get(cursor);
        }
      }
      // Merge already removes its source after moving all children. Canonicalize
      // only that redundant cleanup, after validating every original action.
      // A separate removal must not survive deselection of its owning merge.
      if (result.removeFolders) {
        const merged = new Set(result.merges.map(m => m.sourceId));
        result.removeFolders = removals.filter(r => !merged.has(r.folderId));
      }
    }
    if (context.policy?.allowRename === false && 'assignments' in result) {
      // Renaming is opt-in: drop suggestions for items that already carry a title, keep the ones for untitled items instead of rejecting the batch.
      const titled = new Set(context.items.filter(i => i.title.trim()).map(i => i.id));
      for (const a of result.assignments) if ('title' in a && titled.has(a.itemId)) delete a.title;
    }
    return result;
  } catch (error) {
    if (error instanceof ModelOutputValidationError) throw error;
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      reject(first?.code ?? 'schema', first?.path.join('.') || '(root)');
    }
    reject('validation-exception', '(root)');
  }
}
