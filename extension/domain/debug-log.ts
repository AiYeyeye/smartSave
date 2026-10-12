/**
 * Debug trail for AI calls and background classify/save paths.
 *
 * Off by default. When the user enables「Debug 日志」in settings, events are kept in a bounded ring
 * buffer in chrome.storage.local so the settings page can show the call trail. Detail values must
 * never contain API keys, request/response bodies or page text — only routing facts, sizes, statuses
 * and timings.
 */
export type DebugDetail = Record<string, string | number | boolean | undefined | null>;
export type DebugLog = (event: string, detail?: DebugDetail) => void;

export type DebugEntry = { t: number; src: string; event: string; detail?: DebugDetail };

export const DEBUG_SETTINGS_KEY = 'debugSettings';
export const DEBUG_TRAIL_KEY = 'debugTrail';
export const DEBUG_TRAIL_LIMIT = 400;

type LocalArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

function localArea(): LocalArea | undefined {
  return typeof chrome !== 'undefined' && chrome.storage?.local
    ? (chrome.storage.local as unknown as LocalArea)
    : undefined;
}

let enabled: boolean | undefined;
let watching = false;
const queue: DebugEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function watchSetting() {
  if (watching || typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
  watching = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, DEBUG_SETTINGS_KEY)) return;
    const next = changes[DEBUG_SETTINGS_KEY]?.newValue as { enabled?: unknown } | undefined;
    enabled = next?.enabled === true;
  });
}

async function isEnabled(storage: LocalArea): Promise<boolean> {
  watchSetting();
  if (enabled !== undefined) return enabled;
  try {
    const data = await storage.get(DEBUG_SETTINGS_KEY);
    const value = data[DEBUG_SETTINGS_KEY] as { enabled?: unknown } | undefined;
    enabled = value?.enabled === true;
  } catch {
    enabled = false;
  }
  return enabled;
}

function withLock<T>(operation: () => Promise<T>): Promise<T> {
  if (globalThis.navigator?.locks) return navigator.locks.request('zhilan-debug-trail', operation);
  return operation();
}

async function flush(storage: LocalArea) {
  flushTimer = undefined;
  const batch = queue.splice(0, queue.length);
  if (!batch.length) return;
  try {
    await withLock(async () => {
      const data = await storage.get(DEBUG_TRAIL_KEY);
      const current = Array.isArray(data[DEBUG_TRAIL_KEY]) ? (data[DEBUG_TRAIL_KEY] as DebugEntry[]) : [];
      const next = [...current, ...batch].slice(-DEBUG_TRAIL_LIMIT);
      await storage.set({ [DEBUG_TRAIL_KEY]: next });
    });
  } catch {
    /* debug trail is best-effort */
  }
}

function sanitize(detail?: DebugDetail): DebugDetail | undefined {
  if (!detail) return undefined;
  const out: DebugDetail = {};
  for (const [key, value] of Object.entries(detail)) {
    if (/key|token|secret|authorization|password/i.test(key)) continue;
    out[key] = typeof value === 'string' && value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  return out;
}

/** Records an event when the user enabled the debug trail; a no-op (aside from the cached flag read) otherwise. */
export function createDebugLog(src = 'worker'): DebugLog {
  return (event, detail) => {
    const storage = localArea();
    if (!storage) return;
    void isEnabled(storage).then(on => {
      if (!on) return;
      const entry: DebugEntry = { t: Date.now(), src, event, ...(detail ? { detail: sanitize(detail) } : {}) };
      try {
        console.debug(`[zhilan:${src}:${event}]`, entry.detail ?? '');
      } catch {
        /* console may be unavailable */
      }
      queue.push(entry);
      flushTimer ??= setTimeout(() => void flush(storage), 250);
    });
  };
}

export const noopDebugLog: DebugLog = () => {};

/** Shared trail for model transport calls made from any extension page or the worker. */
export const traceModel: DebugLog = createDebugLog('model');

export async function readDebugSettings(storage: LocalArea | undefined = localArea()): Promise<{ enabled: boolean }> {
  if (!storage) return { enabled: false };
  try {
    const data = await storage.get(DEBUG_SETTINGS_KEY);
    const value = data[DEBUG_SETTINGS_KEY] as { enabled?: unknown } | undefined;
    return { enabled: value?.enabled === true };
  } catch {
    return { enabled: false };
  }
}

export async function writeDebugSettings(next: { enabled: boolean }, storage: LocalArea | undefined = localArea()) {
  if (!storage) return;
  enabled = next.enabled;
  await storage.set({ [DEBUG_SETTINGS_KEY]: { enabled: next.enabled } });
}

export async function readDebugTrail(storage: LocalArea | undefined = localArea()): Promise<DebugEntry[]> {
  if (!storage) return [];
  try {
    const data = await storage.get(DEBUG_TRAIL_KEY);
    return Array.isArray(data[DEBUG_TRAIL_KEY]) ? (data[DEBUG_TRAIL_KEY] as DebugEntry[]) : [];
  } catch {
    return [];
  }
}

export async function clearDebugTrail(storage: LocalArea | undefined = localArea()) {
  if (!storage) return;
  queue.length = 0;
  await withLock(() => storage.set({ [DEBUG_TRAIL_KEY]: [] }));
}

/** Test hook: reset module caches between cases. */
export function resetDebugLogForTests() {
  enabled = undefined;
  queue.length = 0;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = undefined;
}
