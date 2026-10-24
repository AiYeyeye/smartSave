import { z } from 'zod';
import { AI_SEARCH_CANDIDATES, AI_SEARCH_TERMS, AI_SEARCH_TERM_CHARS } from './search-limits';

export type SearchSource = 'bookmarks' | 'history';
export interface HistoryRecord {
  id: string;
  title: string;
  url: string;
  lastVisitTime: number;
}
export interface HistoryRange {
  startTime: number;
  endTime: number;
}
export type HistoryPeriod = '7' | '30' | 'custom' | 'all';
export const HISTORY_READ_LIMIT = 5000;
export const HISTORY_DISPLAY_PAGE = 50;
export function localDate(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function dateTime(value: string, end = false): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('invalid-date');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year!, month! - 1, day!);
  if (localDate(date.getTime()) !== value) throw Error('invalid-date');
  if (end) date.setDate(date.getDate() + 1);
  return date.getTime();
}
export function historyRange(period: HistoryPeriod, start: string, end: string, now = Date.now()): HistoryRange {
  const endTime = period === 'custom' ? Math.min(now + 1, dateTime(end, true)) : now + 1;
  const startTime = period === 'custom' ? dateTime(start) : period === 'all' ? 0 : now - Number(period) * 86400000;
  if (!Number.isFinite(startTime) || startTime < 0 || startTime >= endTime) throw Error('invalid-date');
  return { startTime, endTime };
}
const date = z.string().refine(value => {
  try {
    dateTime(value);
    return true;
  } catch {
    return false;
  }
});
const domain = z
  .string()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/);
export const historyQuerySchema = z
  .strictObject({
    terms: z.array(z.string().trim().min(1).max(AI_SEARCH_TERM_CHARS)).min(1).max(AI_SEARCH_TERMS),
    startDate: date.nullable(),
    endDate: date.nullable(),
    domains: z.array(domain).max(8),
  })
  .refine(value => !value.startDate || !value.endDate || value.startDate <= value.endDate);
export type HistoryQueryPlan = z.infer<typeof historyQuerySchema>;
export type HistoryAiRequest =
  | { task: 'history-query'; query: string; today: string; range: HistoryRange; folderIds: [] }
  | { task: 'history-rank'; query: string; items: HistoryRecord[]; folderIds: [] };
export function inferredRange(range: HistoryRange, plan: HistoryQueryPlan): HistoryRange {
  const startTime = Math.max(range.startTime, plan.startDate ? dateTime(plan.startDate) : 0);
  const endTime = Math.min(range.endTime, plan.endDate ? dateTime(plan.endDate, true) : Infinity);
  if (startTime >= endTime) throw Error('empty-range');
  return { startTime, endTime };
}
export function historyDomainMatches(url: string, domains: string[]): boolean {
  if (!domains.length) return true;
  const host = new URL(url).hostname;
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}
export function safeHistoryUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
export function serializeHistory(request: HistoryAiRequest): string {
  if (request.task === 'history-query')
    return JSON.stringify({ ...request, items: [], folders: [], folderIds: undefined });
  if (
    request.items.length > AI_SEARCH_CANDIDATES ||
    new Set(request.items.map(item => item.id)).size !== request.items.length
  )
    throw Error('invalid-history');
  return JSON.stringify({
    task: request.task,
    query: request.query,
    folders: [],
    items: request.items.map(item => {
      const url = new URL(item.url);
      if (!safeHistoryUrl(item.url) || !Number.isFinite(item.lastVisitTime)) throw Error('invalid-history');
      url.search = '';
      url.hash = '';
      return {
        id: item.id,
        title: item.title.slice(0, 300),
        url: url.href,
        visitedAt: new Date(item.lastVisitTime).toISOString(),
      };
    }),
  });
}
