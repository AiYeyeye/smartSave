# Import parser dependency inventory

Exact installed closure; direct versions pinned in package.json and full closure in pnpm-lock.yaml. Registry metadata verified against registry.npmjs.org (MIT + integrity) for direct packages; installed LICENSE files read for every entry. No upstream bookmark application code reused.

| Package | Version | License |
|---|---|---|
| parse5 | 8.0.1 | MIT |
| entities | 8.1.0 | BSD-2-Clause |
| mdast-util-from-markdown | 2.0.3 | MIT |
| @types/mdast | 4.0.4 | MIT |
| @types/unist | 3.0.3 | MIT |
| decode-named-character-reference | 1.3.0 | MIT |
| character-entities | 2.0.2 | MIT |
| devlop | 1.1.0 | MIT |
| dequal | 2.0.3 | MIT |
| mdast-util-to-string | 4.0.0 | MIT |
| micromark | 4.0.0 | MIT |
| @types/debug | 4.1.13 | MIT |
| @types/ms | 2.1.0 | MIT |
| debug | 4.4.3 | MIT |
| ms | 2.1.3 | MIT |
| micromark-core-commonmark | 2.0.0 | MIT |
| micromark-factory-destination | 2.0.0 | MIT |
| micromark-util-character | 2.0.0 | MIT |
| micromark-util-symbol | 2.0.0 | MIT |
| micromark-util-types | 2.0.0 | MIT |
| micromark-factory-label | 2.0.0 | MIT |
| micromark-factory-space | 2.0.0 | MIT |
| micromark-factory-title | 2.0.0 | MIT |
| micromark-factory-whitespace | 2.0.0 | MIT |
| micromark-util-chunked | 2.0.0 | MIT |
| micromark-util-classify-character | 2.0.0 | MIT |
| micromark-util-html-tag-name | 2.0.0 | MIT |
| micromark-util-normalize-identifier | 2.0.0 | MIT |
| micromark-util-resolve-all | 2.0.0 | MIT |
| micromark-util-subtokenize | 2.0.0 | MIT |
| micromark-util-combine-extensions | 2.0.0 | MIT |
| micromark-util-decode-numeric-character-reference | 2.0.0 | MIT |
| micromark-util-encode | 2.0.0 | MIT |
| micromark-util-sanitize-uri | 2.0.0 | MIT |
| micromark-util-decode-string | 2.0.1 | MIT |
| unist-util-stringify-position | 4.0.0 | MIT |
| jsonc-parser | 3.3.1 | MIT |

## Retrieval and runtime notes
- Direct metadata checked using `pnpm view <name>@<version> license dist.integrity --registry=https://registry.npmjs.org`; configured installation mirror is registry.npmmirror.com. Lockfile records integrity. parse5 8.0.1 and mdast-util-from-markdown 2.0.3 release metadata shows 2026 updates; jsonc-parser 3.3.1 registry modified 2026-07-16. This is maintenance evidence, not a security guarantee.
- Transitive entities is BSD-2-Clause (redistribution notice retained), other closure entries MIT. Full license text is shipped in public/THIRD_PARTY_NOTICES.txt.
- Some micromark monorepo tarballs omit LICENSE; readme links to repository license. Retrieved MIT license from https://raw.githubusercontent.com/micromark/micromark/4.0.0/license; applied to the MIT-licensed micromark family entries lacking a packaged license. Other entries use their packaged license files.
- Actual Worker build test caught `decode-named-character-reference` browser export using `document.createElement`. `scripts/import-worker-config.ts` resolves its shipped pure `index.js` instead, with a real emitted-worker execution regression. No DOMParser, resource loading or execution of input HTML.
