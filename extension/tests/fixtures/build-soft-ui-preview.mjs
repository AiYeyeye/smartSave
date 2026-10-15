import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inertParserResolution } from '../../scripts/import-worker-config.ts';
const outDir = await mkdtemp(join(tmpdir(), 'zhilan-soft-ui-'));
await build({
  configFile: false,
  base: './',
  resolve: { conditions: ['worker'] },
  worker: { plugins: () => [inertParserResolution()] },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
    target: 'chrome114',
    lib: {
      entry: resolve('tests/fixtures/soft-ui-preview.tsx'),
      name: 'SoftUiPreview',
      formats: ['es'],
      fileName: () => 'preview.js',
      cssFileName: 'preview',
    },
  },
});
await writeFile(
  join(outDir, 'index.html'),
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Production components — isolated visual check</title><link rel="stylesheet" href="preview.css"></head><body><div id="root"></div><script type="module" src="preview.js"></script></body></html>',
);
console.log(`PREVIEW_DIR=${outDir}`);
