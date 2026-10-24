import { afterEach, expect, it, vi } from 'vitest';
import { HistoryReader, type HistoryBoundary } from '../adapters/browser-history';
import { HistoryController, type HistorySearchState } from '../panel/history-controller';
import { ModelTransport } from '../adapters/model-transport';
import {
  dateTime,
  historyRange,
  historyQuerySchema,
  inferredRange,
  serializeHistory,
  type HistoryRecord,
} from '../domain/history-search';
import { SearchDocumentsIndex } from '../domain/search-index';
import { parseModelOutput, modelOutputJsonSchema } from '../schemas/model-output';
import { searchTree } from './fixtures/search-tree';
import type { NodeRef } from '../domain/node-reference';
import * as debugLog from '../domain/debug-log';

const at = new Date(2026, 9, 15, 12).getTime();
const range = { startTime: at - 7 * 86400000, endTime: at + 1 };
const record: HistoryRecord = {
  id: 'history-1',
  title: '重庆大学流程图',
  url: 'https://history.example.test/draw?token=private#secret',
  lastVisitTime: at,
};
function boundary(items: chrome.history.HistoryItem[] = [record]) {
  let allowed = true;
  let notify = () => {};
  const api: HistoryBoundary = {
    contains: vi.fn(async () => allowed),
    request: vi.fn(async () => allowed),
    remove: vi.fn(async () => {
      allowed = false;
      notify();
      return true;
    }),
    search: vi.fn(async () => items),
    visits: vi.fn(async url =>
      items
        .filter(item => item.url === url)
        .map(item => ({
          id: item.id,
          visitId: `visit-${item.id}`,
          visitTime: item.lastVisitTime,
          referringVisitId: '0',
          isLocal: true,
          transition: 'link' as const,
        })),
    ),
    subscribe(listener) {
      notify = listener;
      return () => {
        notify = () => {};
      };
    },
  };
  return {
    api,
    revoke() {
      allowed = false;
      notify();
    },
    changed() {
      notify();
    },
  };
}
function reply(output: unknown) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }),
  );
}
function context() {
  return {
    version: 1 as const,
    revision: 'r',
    sessionRevision: 0,
    tree: searchTree(),
    key: '',
    privacy: { fullUrl: true, bodyEnabled: false, excludedFolders: new Array<NodeRef>() },
    config: {
      adapter: 'openai-compatible' as const,
      baseUrl: 'https://model.example.test/v1',
      model: 'synthetic',
      timeoutMs: 5000,
      streaming: false,
    },
  };
}
function setup(fetcher: typeof fetch, items = [record]) {
  const b = boundary(items);
  const c = context();
  let state!: HistorySearchState;
  const controller = new HistoryController(
    new HistoryReader(b.api),
    next => {
      state = next;
    },
    { read: async () => structuredClone(c), subscribe: () => () => {} },
  );
  controller.attach(
    new ModelTransport(
      { fetch: fetcher, contains: async () => true },
      controller.authority!,
      undefined,
      async () => {},
    ),
  );
  controller.configure('画流程图的工具', range, true);
  return { b, c, controller, state: () => state };
}
afterEach(() => {
  vi.restoreAllMocks();
});

it('validates calendar dates and intersects inferred dates with the user range', () => {
  expect(() => dateTime('2026-02-31')).toThrow();
  expect(historyRange('custom', '2026-10-14', '2026-10-15', at)).toEqual({
    startTime: dateTime('2026-10-14'),
    endTime: at + 1,
  });
  expect(() => historyRange('custom', '2026-10-16', '2026-10-15', at)).toThrow();
  expect(
    inferredRange(range, { terms: ['flowchart'], domains: [], startDate: '2026-10-14', endDate: null }).startTime,
  ).toBe(dateTime('2026-10-14'));
  expect(() =>
    inferredRange(range, { terms: ['flowchart'], domains: [], startDate: '2026-01-01', endDate: '2026-01-02' }),
  ).toThrow('empty-range');
});
it('retains Chinese pinyin and title/domain matching without bookmark identities', () => {
  const index = new SearchDocumentsIndex([{ hit: { ...record, path: '' } }]);
  expect(index.query('cqdx')[0]?.id).toBe(record.id);
  expect(index.query('history.example')[0]?.id).toBe(record.id);
});
it('never reads native history without permission', async () => {
  const b = boundary();
  b.revoke();
  const reader = new HistoryReader(b.api);
  await expect(reader.read(range, [], new AbortController().signal)).rejects.toThrow('history-permission');
  expect(b.api.search).not.toHaveBeenCalled();
  reader.dispose();
});
it('deduplicates URLs, rejects unsafe URLs and resolves visits before a later revisit', async () => {
  const b = boundary([
    record,
    { ...record },
    { id: 'later', url: 'https://older.test/', title: 'Older', lastVisitTime: at + 10000 },
    { id: 'unsafe', url: 'javascript:alert(1)', lastVisitTime: at },
  ]);
  b.api.visits = vi.fn(async () => [
    {
      id: 'later',
      visitId: 'visit',
      visitTime: at - 500,
      referringVisitId: '0',
      isLocal: true,
      transition: 'link' as const,
    },
  ]);
  const reader = new HistoryReader(b.api);
  const result = await reader.read(range, ['Older'], new AbortController().signal);
  expect(result.records.map(item => item.id)).toEqual(['history-1', 'later']);
  expect(result.records[1]?.lastVisitTime).toBe(at - 500);
  expect(b.api.visits).toHaveBeenCalledWith('https://older.test/');
  reader.dispose();
});
it('rejects a delayed native reply after history was deleted', async () => {
  const b = boundary();
  let resolve!: (items: chrome.history.HistoryItem[]) => void;
  b.api.search = vi.fn(
    () =>
      new Promise<chrome.history.HistoryItem[]>(done => {
        resolve = done;
      }),
  );
  const reader = new HistoryReader(b.api);
  const pending = reader.read(range, [], new AbortController().signal);
  await vi.waitFor(() => expect(b.api.search).toHaveBeenCalled());
  b.changed();
  resolve([record]);
  await expect(pending).rejects.toThrow('history-changed');
  reader.dispose();
});
it('explicit consent gates both AI stages; ranking strips URL secrets and validates real IDs', async () => {
  const payloads: { task: string; items: { id: string; url: string }[] }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    payloads.push(payload);
    return reply(
      payload.task === 'history-query'
        ? { terms: ['流程图'], startDate: '2026-10-14', endDate: null, domains: ['example.test'] }
        : { rankedIds: [record.id] },
    );
  });
  const h = setup(fetcher);
  await h.controller.load();
  await h.controller.search();
  expect(fetcher).not.toHaveBeenCalled();
  h.controller.consent(true);
  await h.controller.search();
  expect(payloads).toHaveLength(2);
  expect(payloads[0]?.items).toEqual([]);
  expect(payloads[1]?.items[0]?.url).toBe('https://history.example.test/draw');
  expect(JSON.stringify(payloads)).not.toContain('private');
  expect(h.state().hits[0]?.url).toBe(record.url);
  expect(h.state().aiRange?.startTime).toBe(dateTime('2026-10-14'));
  h.controller.dispose();
});
it('privacy-excluded bookmark URLs cannot enter AI ranking through history', async () => {
  const calls: string[] = [];
  const h = setup(
    vi.fn(async (_url, init) => {
      const p = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      calls.push(p.task);
      return reply({ terms: ['流程图'], startDate: null, endDate: null, domains: [] });
    }),
  );
  h.c.tree.nodes[1]!.url = record.url;
  h.c.privacy.excludedFolders = [h.c.tree.nodes[0]!.ref];
  await h.controller.load();
  h.controller.consent(true);
  await h.controller.search();
  expect(calls).toEqual(['history-query']);
  expect(h.state().error).toBe('history-no-candidates');
  h.controller.dispose();
});
it('permission revocation clears local/AI data and prevents a late answer from landing', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const h = setup(fetcher);
  await h.controller.load();
  h.controller.consent(true);
  const pending = h.controller.search();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  h.b.revoke();
  resolve(reply({ terms: ['流程图'], startDate: null, endDate: null, domains: [] }));
  await pending;
  expect(h.state().hits).toEqual([]);
  expect(h.state().records).toEqual([]);
  expect(h.state().consent).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();
  h.controller.dispose();
});
it('query changes cancel AI without replay and local search remains available', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const h = setup(fetcher);
  await h.controller.load();
  h.controller.consent(true);
  const pending = h.controller.search();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  h.controller.configure('cqdx', range, true);
  resolve(reply({ terms: ['流程图'], startDate: null, endDate: null, domains: [] }));
  await pending;
  expect(h.state().hits[0]?.id).toBe(record.id);
  expect(h.state().searching).toBe(false);
  h.controller.dispose();
});
it('unknown/duplicate model IDs and malformed query plans are rejected', () => {
  const c = { task: 'history-rank', items: [record], folders: [] };
  expect(() => parseModelOutput({ rankedIds: ['invented'] }, c)).toThrow();
  expect(() => parseModelOutput({ rankedIds: [record.id, record.id] }, c)).toThrow();
  expect(
    historyQuerySchema.safeParse({ terms: ['x'], startDate: '2026-02-31', endDate: null, domains: [] }).success,
  ).toBe(false);
  expect(
    historyQuerySchema.safeParse({ terms: ['x'], startDate: null, endDate: null, domains: ['https://evil.test/path'] })
      .success,
  ).toBe(false);
  expect(() => modelOutputJsonSchema('history-query')).not.toThrow();
});
it('transport refuses history tasks without independent history authority', async () => {
  const c = context();
  const fetcher = vi.fn();
  const transport = new ModelTransport(
    { fetch: fetcher, contains: async () => true },
    { read: async () => c, subscribe: () => () => {} },
  );
  const result = await transport.run({
    ...c,
    request: { task: 'history-rank', query: 'x', items: [record], folderIds: [] },
  });
  expect(result.status).toBe('failed');
  expect(fetcher).not.toHaveBeenCalled();
  transport.dispose();
});
it('bounded history projection rejects unsafe records and strips parameters even when full URL is enabled elsewhere', () => {
  expect(serializeHistory({ task: 'history-rank', query: 'x', items: [record], folderIds: [] })).not.toMatch(
    /private|secret/,
  );
  expect(() =>
    serializeHistory({
      task: 'history-rank',
      query: 'x',
      items: [{ ...record, url: 'https://user:password@example.test/' }],
      folderIds: [],
    }),
  ).toThrow();
});

it('never records history bodies or provider-echoed content in enabled diagnostics', async () => {
  const entries: unknown[] = [];
  vi.spyOn(debugLog, 'traceModel').mockImplementation((event, detail) => {
    entries.push({ event, detail: typeof detail === 'function' ? detail() : detail });
  });
  const marker = 'private-history-marker';
  for (const status of [200, 400]) {
    const h = setup(
      async () =>
        new Response(
          JSON.stringify(
            status === 200
              ? { [marker]: marker, choices: [{ message: { content: marker }, finish_reason: marker }] }
              : { error: { message: marker } },
          ),
          {
            status,
            headers: { 'x-request-id': marker },
          },
        ),
    );
    await h.controller.load();
    h.controller.consent(true);
    await h.controller.search();
    expect(h.state().error).not.toBe('');
    h.controller.dispose();
  }
  const logged = JSON.stringify(entries);
  expect(entries.length).toBeGreaterThan(0);
  expect(logged).not.toContain(marker);
  expect(logged).not.toContain('画流程图');
  expect(logged).not.toMatch(/request-body|response-body|answer-body/);
});
