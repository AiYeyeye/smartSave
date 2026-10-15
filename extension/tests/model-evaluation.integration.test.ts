import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { syntheticConnectionTree } from '../adapters/ai-connection';

it('runs the actual compiled evaluation CLI: default zero requests, explicit synthetic HTTP evaluation only', async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end(
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
      );
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('missing-local-server');
    const dir = await mkdtemp(join(tmpdir(), 'zhilan-evaluation-test-'));
    const dataset = join(dir, 'synthetic.json');
    const config = join(dir, 'models.json');
    const output = join(dir, 'report.json');
    await writeFile(
      dataset,
      JSON.stringify({
        version: 1,
        name: 'Synthetic CLI only',
        tree: syntheticConnectionTree(),
        privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
        cases: [{ bookmarkId: 'test-bookmark', expectedFolderId: 'test-docs' }],
      }),
    );
    await writeFile(
      config,
      JSON.stringify([
        {
          config: {
            adapter: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            model: 'synthetic',
            timeoutMs: 1000,
          },
        },
      ]),
    );
    const args = ['checks/model-evaluation.mjs', '--dataset', dataset, '--config', config];
    const run = promisify(execFile);
    const dry = await run(process.execPath, args);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, cases: 1, providerRequests: 0 });
    expect(requests).toBe(0);
    const result = await run(process.execPath, [...args, '--run', '--output', output]);
    expect(JSON.parse(result.stdout)[0]).toMatchObject({ accuracy: 1, processed: 1 });
    expect(requests).toBe(1);
    expect(JSON.parse(await readFile(output, 'utf8'))[0].rows[0].correct).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}, 30000);
