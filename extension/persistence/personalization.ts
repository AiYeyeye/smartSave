import { cancellable } from '../domain/cancellable';
import {
  emptyPersonalization,
  personalizationSchema,
  preferenceFits,
  type Personalization,
  type PersonalPreference,
} from '../domain/personalization';

type Storage = {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
};
export const LEARNING_QUEUE_KEY = 'correctionLearning.v1';
function boundedView(value: Personalization) {
  if (preferenceFits(value.entries)) return value;
  const entries: PersonalPreference[] = [];
  for (const entry of [...value.entries].sort((a, b) => b.updatedAt - a.updatedAt))
    if (preferenceFits([...entries, entry])) entries.push(entry);
  return { ...value, entries };
}
export class PersonalizationStore {
  private transient = new Map<string, Personalization>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private storage?: Storage) {}
  key(installationId: string) {
    return `personalization.v1.${encodeURIComponent(installationId)}`;
  }
  async load(installationId: string): Promise<Personalization> {
    if (!this.storage) return structuredClone(this.transient.get(installationId) ?? emptyPersonalization());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Error('personalization-unavailable')), 10_000);
    try {
      await cancellable(this.storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }), controller.signal);
      const data = await cancellable(this.storage.get(this.key(installationId)), controller.signal);
      return data[this.key(installationId)] === undefined
        ? emptyPersonalization()
        : boundedView(personalizationSchema.parse(data[this.key(installationId)]));
    } finally {
      clearTimeout(timer);
    }
  }
  update(installationId: string, change: (value: Personalization) => Personalization) {
    const write = async () => {
      const changed = change(await this.load(installationId));
      const value = personalizationSchema.parse({
        ...changed,
        revision: crypto.randomUUID(),
      });
      if (!preferenceFits(value.entries)) throw Error('preference-capacity');
      if (this.storage) {
        const data = await this.storage.get(this.key(installationId));
        const old =
          data[this.key(installationId)] === undefined
            ? undefined
            : personalizationSchema.parse(data[this.key(installationId)]);
        // Preserve oversized legacy content before replacing it. It is not part of the effective profile.
        await this.storage.set({
          ...(old && !preferenceFits(old.entries) ? { [`${this.key(installationId)}.migration`]: old } : {}),
          [this.key(installationId)]: value,
        });
      } else this.transient.set(installationId, value);
      return value;
    };
    const pending = this.pending
      .catch(() => {})
      .then(() => (globalThis.navigator?.locks ? navigator.locks.request(this.key(installationId), write) : write()));
    this.pending = pending;
    return pending;
  }
  remember(installationId: string, entry: PersonalPreference) {
    return this.rememberMany(installationId, [entry]);
  }
  rememberMany(installationId: string, added: PersonalPreference[]) {
    return this.update(installationId, memory => {
      if (!memory.enabled) return memory;
      const entries = [...memory.entries.filter(item => !added.some(entry => entry.id === item.id)), ...added];
      return { ...memory, entries };
    });
  }
  async migrate(installationId: string) {
    if (!this.storage) return undefined;
    const key = this.key(installationId);
    const data = await this.storage.get(key);
    const old = data[key] === undefined ? undefined : personalizationSchema.parse(data[key]);
    if (!old || preferenceFits(old.entries)) return undefined;
    await this.update(installationId, value => value);
    return old;
  }
}
export const browserPersonalizationStore = () =>
  new PersonalizationStore(
    typeof chrome !== 'undefined' && typeof chrome.storage?.local?.setAccessLevel === 'function'
      ? chrome.storage.local
      : undefined,
  );
