import { z } from 'zod';
import type { AiPrivacy } from './ai-payload';
import type { TreeSnapshot } from './node-reference';

export const PREFERENCE_CHARACTER_LIMIT = 3000;
export const PREFERENCE_ENTRY_LIMIT = 10;
// Zod and HTML count UTF-16 units; the aggregate Unicode budget is checked by preferenceFits.
export const PREFERENCE_TEXT_CODE_UNITS = PREFERENCE_CHARACTER_LIMIT * 2;
export const preferenceScopeSchema = z.enum(['search', 'organize', 'save', 'import', 'rename']);
export type PreferenceScope = z.infer<typeof preferenceScopeSchema>;
export const personalPreferenceSchema = z.strictObject({
  id: z.string().min(1).max(256),
  text: z.string().trim().min(1).max(PREFERENCE_TEXT_CODE_UNITS),
  source: z.enum(['choice', 'feedback', 'manual', 'ai']),
  status: z.enum(['active', 'pending']),
  enabled: z.boolean(),
  scopes: z.array(preferenceScopeSchema).min(1).max(5),
  learnedFrom: z.string().max(256).optional(),
  updatedAt: z.number().int().nonnegative(),
  // Evidence is local-only. Re-resolve it before sending any remembered text.
  evidence: z
    .array(
      z.strictObject({
        id: z.string(),
        title: z.string(),
        url: z.string().optional(),
        parentId: z.string().optional(),
      }),
    )
    .max(500),
});
export type PersonalPreference = z.infer<typeof personalPreferenceSchema>;
export const personalizationSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  revision: z.string(),
  entries: z.array(personalPreferenceSchema).max(500),
});
export type Personalization = z.infer<typeof personalizationSchema>;
export const emptyPersonalization = (): Personalization => ({ version: 1, enabled: true, revision: '', entries: [] });
/** Count Unicode characters, including the newline between separate rules. */
export const preferenceCharacters = (entries: { text: string }[]) =>
  Array.from(entries.map(e => e.text).join('\n')).length;
export const preferenceFits = (entries: { text: string }[]) =>
  entries.length <= PREFERENCE_ENTRY_LIMIT && preferenceCharacters(entries) <= PREFERENCE_CHARACTER_LIMIT;

/** Excluded, deleted or changed evidence cannot leak through a remembered example or an AI summary. */
export function preferenceUsable(entry: PersonalPreference, tree: TreeSnapshot, privacy: AiPrivacy) {
  if (!privacy.fullUrl && /[?#]/.test(entry.text)) return false;
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  const excluded = new Set(
    privacy.excludedFolders.filter(ref => ref.installationId === tree.installationId).map(ref => ref.nativeId),
  );
  return entry.evidence.every(evidence => {
    let node = nodes.get(evidence.id);
    if (
      !node ||
      node.title !== evidence.title ||
      node.url !== evidence.url ||
      (evidence.parentId !== undefined && evidence.parentId !== node.parentId)
    )
      return false;
    const seen = new Set<string>();
    while (node) {
      if (excluded.has(node.ref.nativeId) || seen.has(node.ref.nativeId)) return false;
      seen.add(node.ref.nativeId);
      if (node.parentId === undefined) return true;
      node = nodes.get(node.parentId);
      if (!node) return false;
    }
    return false;
  });
}

export function preferenceHints(
  memory: Personalization,
  tree: TreeSnapshot,
  privacy: AiPrivacy,
  scope: PreferenceScope,
  evidenceIds?: ReadonlySet<string>,
) {
  if (!memory.enabled) return [];
  let remaining = PREFERENCE_CHARACTER_LIMIT;
  return [...memory.entries]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter(entry => {
      if (
        !entry.enabled ||
        entry.status !== 'active' ||
        !entry.scopes.includes(scope) ||
        (evidenceIds && entry.evidence.some(evidence => !evidenceIds.has(evidence.id))) ||
        !preferenceUsable(entry, tree, privacy)
      )
        return false;
      const length = Array.from(entry.text).length;
      if (length > remaining) return false;
      remaining -= length + 1;
      return true;
    })
    .slice(0, PREFERENCE_ENTRY_LIMIT)
    .map(entry => ({ id: entry.id, text: entry.text, kind: entry.source }));
}

export function preferenceEvidence(tree: TreeSnapshot, ids: string[]) {
  return [...new Set(ids)].map(id => {
    const node = tree.nodes.find(value => value.ref.nativeId === id);
    if (!node) throw Error('stale-context');
    return { id, title: node.title, ...(node.url === undefined ? {} : { url: node.url }) };
  });
}

export function preferencePathEvidence(tree: TreeSnapshot, folderIds: (string | undefined)[]) {
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  const ids = new Set<string>();
  for (let id of folderIds) {
    while (id && !ids.has(id)) {
      const node = nodes.get(id);
      if (!node) break;
      ids.add(id);
      id = node.parentId;
    }
  }
  return preferenceEvidence(tree, [...ids]);
}
