import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const outDir = await mkdtemp(join(tmpdir(), 'zhilan-soft-ui-'));
await build({ configFile: false, base: './', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [react()], build: {
  outDir, emptyOutDir: true, target: 'chrome114', lib: { entry: resolve('tests/fixtures/soft-ui-preview.tsx'), name: 'SoftUiPreview', formats: ['iife'], fileName: () => 'preview.js', cssFileName: 'preview' },
} });
await writeFile(join(outDir, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Production components — isolated visual check</title><link rel="stylesheet" href="preview.css"></head><body><div id="root"></div><script src="preview.js"></script></body></html>');
console.log(`PREVIEW_DIR=${outDir}`);
