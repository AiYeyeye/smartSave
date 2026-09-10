import { z } from 'zod';
import type { SavePage } from '../background/save-entrypoints';
export interface ExtractionBoundary {
  get(tabId: number): Promise<{ url?: string }>;
  inject(tabId: number): Promise<{ frameId: number; documentId?: string }[]>;
  message(tabId: number, message: unknown, documentId: string): Promise<unknown>;
}
export async function extractSaveBody(page: SavePage, current: () => SavePage | undefined, boundary: ExtractionBoundary): Promise<string> {
  const valid = () => { if (current()?.token !== page.token) throw Error('stale-page'); };
  valid();
  const tab = await boundary.get(page.tabId); valid();
  if (tab.url !== page.url) throw Error('stale-page');
  let documentId: string | undefined;
  try {
    const results = await boundary.inject(page.tabId);
    documentId = results.find(result => result.frameId === 0)?.documentId;
    if (!documentId) throw Error('document-unavailable');
    valid();
    const response = await boundary.message(page.tabId, { type: 'zhilan-extract-current-page', url: page.url }, documentId);
    valid();
    return z.object({ status: z.literal('ready'), url: z.literal(page.url), snippet: z.string().refine(text => Array.from(text).length <= 1500) }).parse(response).snippet;
  } finally {
    // Even cancellation while injection awaited removes the dormant listener in that exact document.
    if (documentId) await boundary.message(page.tabId, { type: 'zhilan-cancel-extraction' }, documentId).catch(() => {});
  }
}
