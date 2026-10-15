import { expect, it, vi } from 'vitest';
import {
  evaluationDatasetSchema,
  evaluationRouteSchema,
  evaluationTemplate,
  evaluateModel,
  prepareEvaluation,
} from '../checks/model-evaluation-runner';
import { syntheticConnectionTree } from '../adapters/ai-connection';

const config = {
  adapter: 'openai-compatible' as const,
  baseUrl: 'https://evaluation.test/v1',
  model: 'synthetic',
  timeoutMs: 1000,
};
function dataset() {
  const tree = syntheticConnectionTree();
  const bookmark = tree.nodes.find(node => node.ref.nativeId === 'test-bookmark')!;
  tree.nodes.push({
    ...bookmark,
    ref: { ...bookmark.ref, nativeId: 'second-bookmark' },
    title: 'Private title that must not enter the report',
    url: 'https://private.example.test/path?secret=yes',
  });
  return evaluationDatasetSchema.parse({
    version: 1,
    name: 'Synthetic evaluation only',
    tree,
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
    cases: [
      { bookmarkId: 'test-bookmark', expectedFolderId: 'test-docs' },
      { bookmarkId: 'second-bookmark', expectedFolderId: 'test-other' },
    ],
  });
}

it('compares exact manual labels, counts failures honestly, and omits content and keys from the report', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"assignments":[{"itemId":"test-bookmark","folderId":"test-docs"}],"newFolders":[]}',
              },
              finish_reason: 'stop',
            },
          ],
        }),
      ),
    )
    .mockResolvedValueOnce(new Response('private-provider-body', { status: 401 }));
  const report = await evaluateModel(dataset(), config, 'private-evaluation-key', { fetch: fetcher });
  expect(report).toMatchObject({
    requested: 2,
    processed: 2,
    accuracy: 0.5,
    completedAccuracy: 1,
    failureRate: 0.5,
    latency: { count: 1 },
    firstToken: undefined,
  });
  expect(report.rows[1]).toMatchObject({ correct: false, reason: 'http-401' });
  expect(JSON.stringify(report)).not.toMatch(
    /Private title|private\.example|secret=yes|private-provider-body|private-evaluation-key/,
  );
  const wire = String(fetcher.mock.calls[1]![1]?.body);
  expect(wire).not.toContain('secret=yes');
});

it('rejects duplicate/missing labels and excludes private cases before any provider request', async () => {
  const input = dataset();
  expect(() => evaluationDatasetSchema.parse({ ...input, cases: [input.cases[0], input.cases[0]] })).toThrow();
  expect(() =>
    evaluationDatasetSchema.parse({ ...input, cases: [{ bookmarkId: 'test-bookmark', expectedFolderId: '' }] }),
  ).toThrow();
  const fetcher = vi.fn<typeof fetch>();
  input.privacy.excludedFolders = [input.tree.nodes.find(n => n.ref.nativeId === 'test-root')!.ref];
  await expect(evaluateModel(input, config, '', { fetch: fetcher })).rejects.toThrow('excluded-evaluation-case');
  expect(fetcher).not.toHaveBeenCalled();
  expect(() => evaluationRouteSchema.parse({ config: { ...config, baseUrl: 'http://remote.test' } })).toThrow();
});

it('builds offline export templates with blank labels instead of assuming current placement is correct', () => {
  const template = evaluationTemplate({
    format: 'markora.bookmarks',
    schemaVersion: 1,
    generatedAt: '2026-10-14T00:00:00Z',
    roots: [
      {
        type: 'folder',
        id: 'docs',
        title: 'Docs',
        path: ['Docs'],
        children: [
          { type: 'bookmark', id: 'b', title: 'Example', url: 'https://example.test/', path: ['Docs', 'Example'] },
        ],
      },
    ],
  });
  expect(template.cases).toEqual([{ bookmarkId: 'b', expectedFolderId: '' }]);
  expect(() => evaluationDatasetSchema.parse(template)).toThrow();
  template.cases[0]!.expectedFolderId = 'docs';
  const prepared = prepareEvaluation(evaluationDatasetSchema.parse(template));
  expect(prepared[0]).toMatchObject({ expectedInCandidates: true });
  expect(template.tree.installationId).toBe('offline-evaluation');
});

it('cancels before issuing a request and leaves missing metrics absent', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetcher = vi.fn<typeof fetch>();
  expect(await evaluateModel(dataset(), config, '', { fetch: fetcher, signal: controller.signal })).toMatchObject({
    cancelled: true,
    processed: 0,
    accuracy: undefined,
    latency: undefined,
  });
  expect(fetcher).not.toHaveBeenCalled();
});
