import { expect, it, vi } from 'vitest';
import { extractSaveBody, saveBodySchema, type ExtractionBoundary } from '../panel/extract-save-body';
const page = { tabId: 1, token: 't', url: 'https://page.test/', title: 'Page' };
function boundary(): ExtractionBoundary { return { get: vi.fn(async () => ({ url: page.url })), inject: vi.fn(async () => [{ frameId: 0, documentId: 'document' }]), message: vi.fn(async () => ({ status: 'ready', url: page.url, snippet: '😀'.repeat(1500) })) }; }
it('uses exact injected document and bounded Unicode response without storage writes', async () => {
  const b = boundary(); expect(Array.from(await extractSaveBody(page, () => page, b))).toHaveLength(1500);
  expect(b.message).toHaveBeenCalledWith(1, { type: 'zhilan-extract-current-page', url: page.url }, 'document');
  expect(b.message).toHaveBeenLastCalledWith(1, { type: 'zhilan-cancel-extraction' }, 'document');
});
it('permission denial neither sends extraction message nor retries', async () => {
  const b = boundary(); b.inject = vi.fn(async () => { throw Error('permission denied'); });
  await expect(extractSaveBody(page, () => page, b)).rejects.toThrow(); expect(b.inject).toHaveBeenCalledOnce(); expect(b.message).not.toHaveBeenCalled();
});
it('metadata denial prevents injection', async () => {
  const b = boundary(); b.get = async () => ({});
  await expect(extractSaveBody(page, () => page, b)).rejects.toThrow(); expect(b.inject).not.toHaveBeenCalled();
});
it('close or same-url navigation during injection cancels listener without capturing body', async () => {
  const b = boundary(); let current: typeof page | undefined = page; let resolve!: (result: { frameId: number; documentId: string }[]) => void;
  b.inject = vi.fn(() => new Promise<{ frameId: number; documentId: string }[]>(done => { resolve = done; }));
  const pending = extractSaveBody(page, () => current, b); const rejection = expect(pending).rejects.toThrow('stale-page');
  await vi.waitFor(() => expect(b.inject).toHaveBeenCalled()); current = { ...page, token: 'new-document' }; resolve([{ frameId: 0, documentId: 'old-document' }]); await rejection;
  expect(b.message).toHaveBeenCalledExactlyOnceWith(1, { type: 'zhilan-cancel-extraction' }, 'old-document');
});
it('late response after close and oversized response are rejected, never truncated', async () => {
  const b = boundary(); let current: typeof page | undefined = page;
  b.message = vi.fn(async () => { current = undefined; return { status: 'ready', url: page.url, snippet: 'private' }; });
  await expect(extractSaveBody(page, () => current, b)).rejects.toThrow('stale-page');
  const oversized = boundary(); oversized.message = async () => ({ status: 'ready', url: page.url, snippet: 'a'.repeat(1501) });
  await expect(extractSaveBody(page, () => page, oversized)).rejects.toThrow();
});
it('panel parses the worker reply with the same contract: another page or an oversized body is rejected, 1500 code points pass', () => {
  const schema = saveBodySchema(page.url);
  expect(schema.safeParse({ status: 'ready', url: 'https://other.test/', snippet: 'x' }).success).toBe(false);
  expect(schema.safeParse({ status: 'ready', url: page.url, snippet: 'a'.repeat(1501) }).success).toBe(false);
  expect(schema.safeParse({ status: 'ready', snippet: 'x' }).success).toBe(false);
  expect(schema.safeParse({ status: 'ready', url: page.url, snippet: '😀'.repeat(1500) }).success).toBe(true);
});
