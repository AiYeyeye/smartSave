import { cancellable } from '../domain/cancellable';
import { HISTORY_READ_LIMIT, safeHistoryUrl, type HistoryRange, type HistoryRecord } from '../domain/history-search';

export interface HistoryBoundary {
  contains(): Promise<boolean>;
  request(): Promise<boolean>;
  remove(): Promise<boolean>;
  search(query: {
    text: string;
    startTime: number;
    endTime: number;
    maxResults: number;
  }): Promise<chrome.history.HistoryItem[]>;
  visits(url: string): Promise<chrome.history.VisitItem[]>;
  subscribe(listener: () => void): () => void;
}
export function browserHistoryBoundary(): HistoryBoundary | undefined {
  if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return undefined;
  return {
    contains: () => chrome.permissions.contains({ permissions: ['history'] }),
    request: () => chrome.permissions.request({ permissions: ['history'] }),
    remove: () => chrome.permissions.remove({ permissions: ['history'] }),
    search: query => chrome.history.search(query),
    visits: url => chrome.history.getVisits({ url }),
    subscribe(listener) {
      let removal: typeof chrome.history.onVisitRemoved | undefined;
      const attach = () => {
        if (removal || !chrome.history?.onVisitRemoved) return;
        removal = chrome.history.onVisitRemoved;
        removal.addListener(listener);
      };
      const permissions = (value: chrome.permissions.Permissions) => {
        if (value.permissions?.includes('history')) {
          attach();
          listener();
        }
      };
      chrome.permissions.onRemoved.addListener(permissions);
      chrome.permissions.onAdded?.addListener(permissions);
      attach();
      // No visitation listener: this feature queries on demand, it does not monitor browsing.
      return () => {
        chrome.permissions.onRemoved.removeListener(permissions);
        chrome.permissions.onAdded?.removeListener(permissions);
        removal?.removeListener(listener);
      };
    },
  };
}
export class HistoryReader {
  revision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly stop: () => void;
  constructor(readonly boundary: HistoryBoundary) {
    this.stop = boundary.subscribe(() => {
      this.revision++;
      for (const listener of this.listeners) listener();
    });
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose() {
    this.stop();
    this.listeners.clear();
  }
  async check(revision: number, signal: AbortSignal) {
    if (revision !== this.revision) throw Error('history-changed');
    if (!(await cancellable(this.boundary.contains(), signal))) throw Error('history-permission');
    if (revision !== this.revision) throw Error('history-changed');
  }
  async read(range: HistoryRange, terms: string[], signal: AbortSignal, limit = HISTORY_READ_LIMIT) {
    const revision = this.revision;
    await this.check(revision, signal);
    if (
      !Number.isFinite(range.startTime) ||
      !Number.isFinite(range.endTime) ||
      range.startTime < 0 ||
      range.startTime >= range.endTime
    )
      throw Error('invalid-date');
    const found = new Map<string, chrome.history.HistoryItem>();
    let limited = false;
    // Include a recent local corpus for pinyin and fuzzy matching; query terms also reach older native records.
    for (const text of [...new Set(['', ...terms.filter(Boolean)])].slice(0, 13)) {
      const items = await cancellable(this.boundary.search({ text, ...range, maxResults: limit }), signal);
      await this.check(revision, signal);
      limited ||= items.length >= limit;
      for (const item of items) if (item.url && safeHistoryUrl(item.url)) found.set(item.url, item);
    }
    const records: HistoryRecord[] = [];
    const items = [...found.values()];
    // Resolve old visits for URLs subsequently revisited outside the requested time window.
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(6, items.length) }, async () => {
        while (cursor < items.length) {
          const item = items[cursor++]!;
          let at = item.lastVisitTime ?? 0;
          if (at < range.startTime || at >= range.endTime) {
            const visits = await cancellable(this.boundary.visits(item.url!), signal);
            at = visits.reduce((latest, visit) => {
              const time = visit.visitTime ?? 0;
              return time >= range.startTime && time < range.endTime ? Math.max(latest, time) : latest;
            }, 0);
          }
          if (at && at >= range.startTime && at < range.endTime)
            records.push({ id: item.id, title: item.title ?? '', url: item.url!, lastVisitTime: at });
        }
      }),
    );
    await this.check(revision, signal);
    records.sort((a, b) => b.lastVisitTime - a.lastVisitTime || a.url.localeCompare(b.url));
    return { records, limited, revision };
  }
  async exists(record: HistoryRecord, signal: AbortSignal) {
    const revision = this.revision;
    await this.check(revision, signal);
    const visits = await cancellable(this.boundary.visits(record.url), signal);
    await this.check(revision, signal);
    return visits.some(visit => visit.id === record.id && visit.visitTime === record.lastVisitTime);
  }
}
