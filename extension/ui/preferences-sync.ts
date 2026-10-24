import { APPEARANCE_KEY, LANGUAGE_KEY, validPreference, type Preference, type PreferenceValue } from './preferences';

// Separate allowlisted fields avoid cross-device mode/accent edits overwriting each other.
export const SYNC_PREFERENCE_KEYS = {
  language: 'zhilan.preference.language.v1',
  mode: 'zhilan.preference.mode.v1',
  accent: 'zhilan.preference.accent.v1',
} as const;
const fields = Object.keys(SYNC_PREFERENCE_KEYS) as Preference[];
type Changes = Record<string, chrome.storage.StorageChange>;
type SyncArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
};
type Events = Pick<typeof chrome.storage.onChanged, 'addListener' | 'removeListener'>;
let languageWrites: Promise<unknown> = Promise.resolve();
function mirrorLanguage(value: unknown) {
  if (!validPreference('language', value) || typeof chrome === 'undefined' || !chrome.storage?.local?.set) return;
  languageWrites = languageWrites.catch(() => {}).then(() => chrome.storage.local.set({ [LANGUAGE_KEY]: value })).catch(() => {});
}

function decode<K extends Preference>(field: K, raw: unknown): PreferenceValue<K> | undefined {
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length !== 2) return;
  if (!('version' in raw) || raw.version !== 1 || !('value' in raw)) return;
  return validPreference(field, raw.value) ? raw.value : undefined;
}

function localValue(field: Preference): unknown {
  try {
    if (field === 'language') return localStorage.getItem(LANGUAGE_KEY);
    const raw: unknown = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? 'null');
    return raw && typeof raw === 'object' && field in raw ? raw[field as keyof typeof raw] : undefined;
  } catch {
    return undefined;
  }
}

/** One mounted App owner. Remote preferences never touch settings, model/task owners or native bookmarks. */
export function createPreferenceSync(area: SyncArea, events: Events) {
  let disposed = false;
  const revisions = { language: 0, mode: 0, accent: 0 };
  const pending = new Map<Preference, string>();
  const writing = new Set<Preference>();
  const initialLocal: Partial<Record<Preference, unknown>> = {};
  for (const field of fields) {
    try {
      initialLocal[field] = localValue(field);
    } catch {
      // Malformed or unavailable local values must never be migrated.
    }
  }

  async function drain(field: Preference) {
    if (writing.has(field)) return;
    writing.add(field);
    try {
      while (!disposed && pending.has(field)) {
        const value = pending.get(field)!;
        pending.delete(field);
        try {
          await area.set({ [SYNC_PREFERENCE_KEYS[field]]: { version: 1, value } });
        } catch {
          // Local persistence already succeeded. No automatic retry loop on quota/offline errors.
        }
      }
    } finally {
      writing.delete(field);
    }
  }

  function publish<K extends Preference>(field: K, value: PreferenceValue<K>) {
    if (disposed || !validPreference(field, value)) return;
    revisions[field]++;
    pending.set(field, value);
    void drain(field);
  }

  function apply(field: Preference, value: unknown) {
    if (disposed || !validPreference(field, value)) return;
    try {
      if (localValue(field) === value) return;
      const key = field === 'language' ? LANGUAGE_KEY : APPEARANCE_KEY;
      const appearance: Partial<Record<'mode' | 'accent', string>> = {};
      for (const part of ['mode', 'accent'] as const) {
        const existing = localValue(part);
        if (validPreference(part, existing)) appearance[part] = existing;
      }
      const next = field === 'language' ? value : JSON.stringify({ ...appearance, [field]: value });
      localStorage.setItem(key, next);
      if (field === 'language') mirrorLanguage(value);
      // The browser's storage event reaches other documents, not the document making this write.
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: next }));
    } catch {
      // Keep the working local/in-memory choice when browser storage is unavailable.
    }
  }

  const changed = (changes: Changes, areaName: string) => {
    if (disposed || areaName !== 'sync') return;
    for (const field of fields) {
      if (!Object.hasOwn(changes, SYNC_PREFERENCE_KEYS[field])) continue;
      revisions[field]++;
      if (writing.has(field) || pending.has(field)) continue;
      // Removed, future-version and invalid values leave the local choice alone; never echo them.
      apply(field, decode(field, changes[SYNC_PREFERENCE_KEYS[field]]?.newValue));
    }
  };
  events.addListener(changed);
  const initial = { ...revisions };
  void area.get(Object.values(SYNC_PREFERENCE_KEYS)).then(
    values => {
      if (disposed) return;
      for (const field of fields) {
        if (revisions[field] !== initial[field]) continue;
        const raw: unknown = values[SYNC_PREFERENCE_KEYS[field]];
        if (raw !== undefined) {
          apply(field, decode(field, raw));
          continue;
        }
        try {
          const value = initialLocal[field];
          // Migrate explicit local choices only. Opening a fresh profile never uploads defaults.
          if (validPreference(field, value)) publish(field, value);
        } catch {
          // A malformed legacy/local cache is not sync data.
        }
      }
    },
    () => {},
  );
  return {
    publish,
    dispose() {
      disposed = true;
      pending.clear();
      events.removeListener(changed);
    },
  };
}

let active: ReturnType<typeof createPreferenceSync> | undefined;
export function startPreferenceSync() {
  mirrorLanguage(localValue('language') === 'en' ? 'en' : 'zh-CN');
  if (typeof chrome === 'undefined' || !chrome.storage?.sync || !chrome.storage?.onChanged) return;
  const owner = createPreferenceSync(chrome.storage.sync, chrome.storage.onChanged);
  active = owner;
  return () => {
    if (active === owner) active = undefined;
    owner.dispose();
  };
}
export function synchronizePreference<K extends Preference>(field: K, value: PreferenceValue<K>) {
  if (field === 'language') mirrorLanguage(value);
  active?.publish(field, value);
}
