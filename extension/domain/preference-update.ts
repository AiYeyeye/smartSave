import type { AiPrivacy } from './ai-payload';
import type { TreeSnapshot } from './node-reference';
import {
  personalPreferenceSchema,
  preferenceCharacters,
  preferenceUsable,
  PREFERENCE_CHARACTER_LIMIT,
  PREFERENCE_ENTRY_LIMIT,
  type Personalization,
  type PersonalPreference,
} from './personalization';

export type PreferenceUpdate = { revision: string; additions: PersonalPreference[] };

/** Only explicit additions and currently usable rules enter an update. Local evidence is never serialized. */
export function preferenceUpdatePlan(
  memory: Personalization,
  update: PreferenceUpdate,
  tree: TreeSnapshot,
  privacy: AiPrivacy,
) {
  if (!memory.enabled || memory.revision !== update.revision) throw Error('stale-context');
  const additions = update.additions.map(entry => personalPreferenceSchema.parse(entry));
  if (
    !additions.length ||
    additions.length > 20 ||
    new Set(additions.map(entry => entry.id)).size !== additions.length ||
    additions.some(entry => !entry.enabled || entry.status !== 'active' || !preferenceUsable(entry, tree, privacy))
  )
    throw Error('stale-context');
  const latestEvidence = new Map(additions.flatMap(entry => entry.evidence).map(item => [item.id, item]));
  const previous = memory.entries.filter(entry => !additions.some(added => added.id === entry.id));
  // A new explicit edit can update evidence for that same URL. Keep the rest of a previously
  // compressed rule instead of discarding all its unrelated preferences when one subject changes.
  const refreshed = previous.map(entry => ({
    ...entry,
    evidence: entry.evidence.map(item => {
      const latest = latestEvidence.get(item.id);
      return latest && latest.url === item.url ? latest : item;
    }),
  }));
  const existing = refreshed.filter(
    entry => entry.enabled && entry.status === 'active' && preferenceUsable(entry, tree, privacy),
  );
  const existingIds = new Set(existing.map(entry => entry.id));
  const kept = previous.filter(entry => !existingIds.has(entry.id));
  const characterLimit = PREFERENCE_CHARACTER_LIMIT - preferenceCharacters(kept) - (kept.length ? 1 : 0);
  const ruleLimit = PREFERENCE_ENTRY_LIMIT - kept.length;
  if (characterLimit < 1 || ruleLimit < 1) throw Error('preference-capacity');
  // Separate IDs make superseded examples and repeated subjects unambiguous to the model.
  const sources = [...existing, ...additions].map((entry, index) => ({ ...entry, id: `example-${index}` }));
  return {
    kept,
    sources,
    examples: sources.map(({ id, text }) => ({ id, text })),
    latestExampleIds: sources.slice(existing.length).map(entry => entry.id),
    characterLimit,
    ruleLimit,
  };
}

export function applyPreferenceUpdate(
  plan: ReturnType<typeof preferenceUpdatePlan>,
  rules: { text: string; exampleIds: string[] }[],
  eventId: string,
) {
  if (!rules.length) throw Error('empty');
  return [
    ...plan.kept,
    ...rules.map((rule, index): PersonalPreference => {
      const cited = plan.sources.filter(entry => rule.exampleIds.includes(entry.id));
      if (!cited.length) throw Error('schema');
      return {
        id: `learned:${eventId}:${index}`,
        learnedFrom: eventId,
        text: rule.text,
        source: 'ai',
        status: 'active',
        enabled: true,
        scopes: [...new Set(cited.flatMap(entry => entry.scopes))],
        updatedAt: Date.now(),
        evidence: [...new Map(cited.flatMap(entry => entry.evidence).map(item => [item.id, item])).values()],
      };
    }),
  ];
}
