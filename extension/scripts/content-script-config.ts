import { resolve } from 'node:path';
import type { InlineConfig } from 'vite';

/** Future approved content scripts must use a separate, single-file classic build. */
export function contentScriptConfig(entry: string, outDir: string, fileName = 'content-script.js'): InlineConfig {
  return {
    configFile: false,
    publicDir: false,
    build: {
      target: 'chrome114',
      outDir,
      emptyOutDir: false,
      lib: {
        entry: resolve(entry),
        name: 'ZhilanContentScript',
        formats: ['iife'],
        fileName: () => fileName,
      },
    },
  };
}
