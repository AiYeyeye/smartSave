# Import parser dependency inventory

Import parser dependencies are pinned in `package.json` and `pnpm-lock.yaml`. License texts are included in `public/THIRD_PARTY_NOTICES.txt`.

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

## Runtime and license notes

- `entities` uses BSD-2-Clause; the other entries above use MIT. Keep their notices in `public/THIRD_PARTY_NOTICES.txt` when updating dependencies.
- Some micromark packages link to the [shared MIT license](https://raw.githubusercontent.com/micromark/micromark/4.0.0/license); its text is included in the shipped notices.
- `scripts/import-worker-config.ts` resolves the pure `decode-named-character-reference/index.js` entry for the import Worker. The browser entry uses `document.createElement`, which is unavailable there. The emitted-worker regression checks this configuration. Imported HTML is parsed without loading resources or executing it.
