import { inertParserResolution } from './scripts/import-worker-config';
import { build, defineConfig } from 'vite';
import { contentScriptConfig } from './scripts/content-script-config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({
  base: './', resolve: { conditions: ['worker'] },
  worker: { plugins: () => [inertParserResolution()] }, plugins: [react(), { name: 'current-page-extraction', async closeBundle() { await build(contentScriptConfig('content/extract-current-page.ts', 'dist')); } }],
  build: { target: 'chrome114', rollupOptions: {
    input: { 'import-client': resolve('import/worker-client.ts'), panel: resolve('panel/index.html'), options: resolve('options/index.html'), 'service-worker': resolve('background/service-worker.ts') },
    preserveEntrySignatures: 'strict',
    output: { entryFileNames: chunk => chunk.name === 'service-worker' ? 'service-worker.js' : 'assets/[name]-[hash].js' },
  } },
});
