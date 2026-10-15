import { build } from 'vite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const outDir = await mkdtemp(join(tmpdir(), 'zhilan-performance-'));
await build({
  configFile: false,
  logLevel: 'silent',
  build: {
    outDir,
    target: 'es2022',
    lib: { entry: resolve('checks/performance-runner.ts'), formats: ['es'], fileName: () => 'run.mjs' },
  },
});
await import(pathToFileURL(join(outDir, 'run.mjs')).href);
