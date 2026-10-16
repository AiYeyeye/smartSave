import { z } from 'zod';
import { modelAdapterSchema } from '../domain/model-route';
import {
  addUsageSummaries,
  emptyUsageSummary,
  summarizeUsageRecord,
  tokenPurposeSchema,
  tokenUsageRecordSchema,
  usageDay,
  usageSummarySchema,
  type TokenUsageRecord,
  type UsageSummary,
} from '../domain/token-usage';

export const TOKEN_USAGE_KEY = 'tokenUsage.v1';
export const TOKEN_RECENT_LIMIT = 100;
const groupSchema = z.strictObject({
  adapter: modelAdapterSchema,
  model: z.string().min(1).max(512),
  purpose: tokenPurposeSchema,
  summary: usageSummarySchema,
});
const ledgerSchema = z.strictObject({
  version: z.literal(1),
  since: z.number().int().nonnegative(),
  totals: z.array(groupSchema),
  days: z.array(groupSchema.extend({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
  recent: z.array(tokenUsageRecordSchema).max(TOKEN_RECENT_LIMIT),
});
export type TokenUsageLedger = z.infer<typeof ledgerSchema>;
type Area = { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
type Lock = <T>(operation: () => Promise<T>) => Promise<T>;
const browserArea = () => (typeof chrome !== 'undefined' ? chrome.storage?.local : undefined);
const browserLock: Lock = operation =>
  globalThis.navigator?.locks
    ? navigator.locks.request('zhilan-token-usage', operation)
    : Promise.reject(Error('usage-lock-unavailable'));
export const emptyTokenLedger = (): TokenUsageLedger => ({ version: 1, since: 0, totals: [], days: [], recent: [] });
function parseLedger(value: unknown): TokenUsageLedger {
  if (value === undefined) return emptyTokenLedger();
  return ledgerSchema.parse(value);
}
export async function readTokenUsage(area: Pick<Area, 'get'> | undefined = browserArea()) {
  if (!area) throw Error('usage-storage-unavailable');
  return parseLedger((await area.get(TOKEN_USAGE_KEY))[TOKEN_USAGE_KEY]);
}

/** One named cross-context lock. No per-instance queue can safely serialize page + worker writers. */
export async function recordTokenUsage(
  raw: TokenUsageRecord,
  area: Area | undefined = browserArea(),
  lock: Lock = browserLock,
) {
  if (!area) return;
  const record = tokenUsageRecordSchema.parse(raw);
  await lock(async () => {
    const ledger = await readTokenUsage(area);
    if (ledger.recent.some(item => item.id === record.id)) return;
    const summary = summarizeUsageRecord(record);
    const same = (group: z.infer<typeof groupSchema>) =>
      group.adapter === record.adapter && group.model === record.model && group.purpose === record.purpose;
    const total = ledger.totals.find(same);
    if (total) total.summary = addUsageSummaries(total.summary, summary);
    else ledger.totals.push({ adapter: record.adapter, model: record.model, purpose: record.purpose, summary });
    const day = usageDay(record.at);
    const daily = ledger.days.find(group => group.day === day && same(group));
    if (daily) daily.summary = addUsageSummaries(daily.summary, summary);
    else ledger.days.push({ day, adapter: record.adapter, model: record.model, purpose: record.purpose, summary });
    const cutoff = new Date(Math.max(Date.now(), record.at));
    cutoff.setDate(cutoff.getDate() - 30);
    ledger.days = ledger.days.filter(group => group.day >= usageDay(cutoff.getTime()));
    ledger.since = ledger.since ? Math.min(ledger.since, record.at) : record.at;
    ledger.recent = [record, ...ledger.recent].sort((a, b) => b.at - a.at).slice(0, TOKEN_RECENT_LIMIT);
    // Validate sums before persisting: overflow or invalid/future schemas must never reset existing totals.
    await area.set({ [TOKEN_USAGE_KEY]: ledgerSchema.parse(ledger) });
  });
}

export function tokenUsageView(ledger: TokenUsageLedger, period: 'today' | '7' | '30' | 'all', now = Date.now()) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (period === '7' ? 6 : period === '30' ? 29 : 0));
  const day = usageDay(cutoff.getTime());
  const groups = period === 'all' ? ledger.totals : ledger.days.filter(group => group.day >= day);
  const models = new Map<string, { model: string; adapter: string; summary: UsageSummary }>();
  const purposes = new Map<TokenUsageRecord['purpose'], UsageSummary>();
  let summary = emptyUsageSummary();
  for (const group of groups) {
    summary = addUsageSummaries(summary, group.summary);
    const id = JSON.stringify([group.adapter, group.model]);
    const entry = models.get(id) ?? { model: group.model, adapter: group.adapter, summary: emptyUsageSummary() };
    entry.summary = addUsageSummaries(entry.summary, group.summary);
    models.set(id, entry);
    purposes.set(group.purpose, addUsageSummaries(purposes.get(group.purpose) ?? emptyUsageSummary(), group.summary));
  }
  return {
    summary,
    models: [...models.values()].sort((a, b) => b.summary.total - a.summary.total),
    purposes: [...purposes.entries()],
    recent: ledger.recent.filter(record => period === 'all' || usageDay(record.at) >= day),
  };
}

/** Subscribe before reading. A late snapshot must not overwrite a newer storage event. */
export function watchTokenUsage(receive: (ledger: TokenUsageLedger) => void, failed: () => void) {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
    failed();
    return () => {};
  }
  let disposed = false;
  let revision = 0;
  const events = chrome.storage.onChanged;
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (disposed || area !== 'local' || !Object.hasOwn(changes, TOKEN_USAGE_KEY)) return;
    revision++;
    try {
      receive(parseLedger(changes[TOKEN_USAGE_KEY]?.newValue));
    } catch {
      failed();
    }
  };
  events.addListener(changed);
  void readTokenUsage()
    .then(ledger => {
      if (!disposed && revision === 0) receive(ledger);
    })
    .catch(() => {
      if (!disposed && revision === 0) failed();
    });
  return () => {
    disposed = true;
    events.removeListener(changed);
  };
}
