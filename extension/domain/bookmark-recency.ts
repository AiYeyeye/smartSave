/** Native collection time only: never substitute visit, modification or observation time. */
export const RECENT_BOOKMARK_DAYS = 90;
export const EXPANDED_BOOKMARK_DAYS = 360;
export const BOOKMARK_PERIODS = ['auto', 'today', '7', '30', '90', '360', 'all'] as const;
export type BookmarkPeriod = (typeof BOOKMARK_PERIODS)[number];
export interface CollectionRange {
  startTime: number;
  endTime: number;
}
export interface CollectionPlan {
  range?: CollectionRange;
  fallback?: CollectionRange;
}
const DAY = 86_400_000;
export function validCollectionTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
export function inCollectionRange(item: { dateAdded?: number }, range?: CollectionRange): boolean {
  return (
    !range ||
    (validCollectionTime(item.dateAdded) && item.dateAdded >= range.startTime && item.dateAdded < range.endTime)
  );
}
export function newestBookmarks<T extends { id: string; dateAdded?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.dateAdded ?? -1) - (a.dateAdded ?? -1) || a.id.localeCompare(b.id, 'en'));
}
function daysRange(days: number, now: number): CollectionRange {
  return { startTime: Math.max(0, now - days * DAY), endTime: now + 1 };
}
function dayStart(now: number): Date {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date;
}
function amount(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text);
  const words: Record<string, number> = {
    a: 1,
    an: 1,
    one: 1,
    two: 2,
    three: 3,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (Object.hasOwn(words, text)) return words[text];
  const parts = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(text);
  return parts ? (parts[1] ? words[parts[1]]! : 1) * 10 + (parts[2] ? words[parts[2]]! : 0) : undefined;
}
/** Do not turn negated or before/after conditions into an affirmative bounded window. */
function complexTimeCondition(query: string): boolean {
  return /(?:不是|并非|不在|不要|排除|非)\s*(?:最近|近期|今天|昨天|上周|上个?月|过去|近\d)|(?:最近|近期|今天|昨天|上周|上个?月|\d+天|\d{4}[-/]\d{1,2}[-/]\d{1,2})(?:之?前|以?前|之?后|以?后)|\b(?:not|except|excluding)\s+(?:(?:saved|bookmarked|added)\s+)?(?:recently|recent|today|yesterday|last|past)|\b(?:before|after|since|until)\s+(?:last|past|today|yesterday|\d{4}[-/])/i.test(
    query,
  );
}
/** Common explicit calendar/rolling phrases are resolved locally before any model receives candidates. */
export function queryCollectionRange(query: string, now: number): CollectionRange | undefined {
  const text = query.normalize('NFKC').toLowerCase();
  if (complexTimeCondition(text)) return;
  const count = /(?:最近|过去|近)\s*(\d+|[一二两三四五六七八九十]+)\s*(天|周|个?月|年)/.exec(text);
  const english = /\b(?:last|past)\s+(\d+|a|an|one|two|three)\s+(days?|weeks?|months?|years?)\b/.exec(text);
  const match = count ?? english;
  if (match) {
    const n = amount(match[1]!);
    const unit = match[2]!;
    if (n && n <= 3650)
      return daysRange(
        n * (/周|week/.test(unit) ? 7 : /月|month/.test(unit) ? 30 : /年|year/.test(unit) ? 365 : 1),
        now,
      );
  }
  const start = dayStart(now);
  const end = new Date(start);
  if (/昨天|昨日|\byesterday\b/.test(text)) {
    start.setDate(start.getDate() - 1);
    return { startTime: start.getTime(), endTime: end.getTime() };
  }
  if (/今天|今日|\btoday\b/.test(text)) return { startTime: start.getTime(), endTime: now + 1 };
  if (/上周|上星期|\blast week\b/.test(text)) {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    end.setTime(start.getTime());
    start.setDate(start.getDate() - 7);
    return { startTime: start.getTime(), endTime: end.getTime() };
  }
  if (/本周|这周|\bthis week\b/.test(text)) {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    return { startTime: start.getTime(), endTime: now + 1 };
  }
  if (/上个?月|\blast month\b/.test(text)) {
    start.setDate(1);
    end.setTime(start.getTime());
    start.setMonth(start.getMonth() - 1);
    return { startTime: start.getTime(), endTime: end.getTime() };
  }
  if (/本月|这个月|\bthis month\b/.test(text)) {
    start.setDate(1);
    return { startTime: start.getTime(), endTime: now + 1 };
  }
  const dates = [...text.matchAll(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b|(\d{4})年(\d{1,2})月(\d{1,2})日/g)];
  if (dates.length >= 1 && dates.length <= 2) {
    const parsed = dates.map(date => {
      const y = Number(date[1] ?? date[4]),
        m = Number(date[2] ?? date[5]),
        d = Number(date[3] ?? date[6]);
      const value = new Date(y, m - 1, d);
      return value.getFullYear() === y && value.getMonth() === m - 1 && value.getDate() === d ? value : undefined;
    });
    if (parsed.every(date => date !== undefined)) {
      const from = parsed[0]!;
      const to = new Date(parsed.at(-1)!);
      to.setDate(to.getDate() + 1);
      if (from.getTime() < to.getTime()) return { startTime: from.getTime(), endTime: to.getTime() };
    }
  }
}
export function collectionPlan(
  query: string,
  period: BookmarkPeriod,
  recentView: boolean,
  now = Date.now(),
): CollectionPlan {
  const explicit = queryCollectionRange(query, now);
  const selected =
    period === 'today'
      ? { startTime: dayStart(now).getTime(), endTime: now + 1 }
      : period !== 'auto' && period !== 'all'
        ? daysRange(Number(period), now)
        : undefined;
  if (explicit || selected)
    return {
      range:
        explicit && selected
          ? {
              startTime: Math.max(explicit.startTime, selected.startTime),
              endTime: Math.min(explicit.endTime, selected.endTime),
            }
          : (explicit ?? selected),
    };
  // All time is an explicit escape from the implicit recent window, but never overrides an explicit query date.
  if (period === 'all') return {};
  if (complexTimeCondition(query)) return {};
  const recent =
    recentView ||
    /(?:最近|近期|刚刚|刚)(?:.{0,12})(?:收藏|保存|书签)|(?:收藏|保存|书签).{0,8}(?:最近|近期)|\brecent(?:ly)?\s+(?:saved|bookmarked|added|bookmarks)|\b(?:saved|bookmarked|added)\s+recently\b/i.test(
      query,
    );
  return recent
    ? { range: daysRange(RECENT_BOOKMARK_DAYS, now), fallback: daysRange(EXPANDED_BOOKMARK_DAYS, now) }
    : {};
}
