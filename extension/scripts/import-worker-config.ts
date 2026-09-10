import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';
/** Force the dependency's pure lookup implementation, not its browser DOM decoder. */
export function inertParserResolution(): Plugin {
 const require = createRequire(import.meta.url);
 const mdast = require.resolve('mdast-util-from-markdown');
 const nested = createRequire(mdast);
 const micromark = nested.resolve('micromark-util-decode-string');
 const decoder = createRequire(micromark).resolve('decode-named-character-reference');
 return { name: 'inert-parser-resolution', enforce: 'pre', resolveId(id) {
   if (id === 'decode-named-character-reference') return resolve(dirname(decoder), 'index.js');
 } };
}
