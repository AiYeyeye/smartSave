# Extension development

[Project overview](../README.en.md) · [中文说明](../README.md)

This is the Manifest V3 extension for 智栏 / Zhilan. Browser bookmarks are authoritative; model results are validated data. Native changes use the shared mutation coordinator, journal and backup/recovery path.

## Build and check

Use Node.js >=22.12 and pnpm 11.7.0. Dependencies are pinned in `pnpm-lock.yaml`.

```sh
git clone https://github.com/AiYeyeye/smartSave.git
cd smartSave
pnpm --dir extension install --frozen-lockfile
pnpm --dir extension lint
pnpm --dir extension typecheck
pnpm --dir extension test
pnpm --dir extension test:integration
pnpm --dir extension build
pnpm --dir extension release:source
```

Integration tests write test-mode build artifacts. Run the final production build **after** integration tests; do not run them concurrently. Load only `extension/dist` as an unpacked extension. Formatting uses Prettier (`format` / `format:check`).

`release:source` validates the source and artifact inventory, static manifest/module references and shipped notices. `release:ready` additionally requires the manual release evidence.

## Runtime and permissions

The current manifest requires Chrome 127+. A toolbar click opens a left overlay on eligible webpages, or the browser side panel on browser-owned pages / when selected in Appearance. Long workspaces use `options/index.html`. The only web-accessible resource is `panel/index.html`; an injected overlay must claim the exact worker-issued document token before it is trusted. Restored claims remain bound to their original tab, frame and document.

Required permissions: bookmarks, storage, activeTab, scripting, contextMenus, favicon and sidePanel. Optional identity is used for user-triggered OpenRouter sign-in. Optional history is requested only by the explicit history enable action. Optional HTTP(S) host declarations support user-configured model services; actual host access is requested when needed. There are no mandatory host permissions or persistent manifest content scripts. Scripts used for explicit extraction/overlay injection are built as classic scripts without dynamic imports.

The toolbar/save entrypoints and browser-native bookmark classification are separate from read-only search. `search-bookmarks` suggests Alt+Shift+K; the omnibox keyword is `zl`. Search verifies current native identity and URL before opening a result. Full-query handoff uses short-lived worker memory rather than query text in navigation URLs.

AI routes support OpenAI Chat Completions and Responses, Anthropic Messages and Gemini. Configure an existing service and assign models by feature. Bookmark search prioritizes folders and cross-folder local candidates, then checks batches of up to 100. Ordinary queries pause after initial matches with explicit continuation; all/every queries scan the full permitted scope. See [AI search design and research](../docs/development/ai-search.md). Local rules may avoid a model call. Only 429 and explicit 5xx responses receive bounded retries; interrupted streams and uncertain native writes are not automatically replayed.

## History search

The page-owned HistoryReader queries native history on demand, rechecks permission and generation, and resolves visits when a URL was revisited outside the selected time window. It has no persistent history store or onVisited monitor. Local retrieval uses a 5000-result per-query batch with explicit read-more; history AI retrieves bounded candidates and ranks at most 80 records. Deletion/revocation clears volatile search state and cancels AI.

History tasks use independent records and mandatory ModelAuthority.validateHistory checks alongside existing search-model routing/transport. They never synthesize bookmark nodes. Query plans have strict terms/date/domain validation; ranked IDs resolve to offered records only. History URL parameters/fragments are always stripped from model input, excluded bookmark URLs cannot re-enter via history, and history request/response bodies are omitted from diagnostics. SaveCard source=history disables automatic suggestions and body capture, but reuses explicit classification, native preview/confirmation and journal recovery.

## Source layout

- `domain/`, `schemas/`: bookmark identities, pure planning, validators and wire contracts.
- `adapters/`, `background/`: browser/model boundaries and worker-owned tasks.
- `persistence/`: settings, rules, receipts, journals and task checkpoints.
- `panel/`, `options/`, `ui/`: React surfaces. `ui/i18n/` owns the incremental Chinese/English UI catalog.
- `tests/`: unit/component and real-build integration tests. `tests/e2e/` contains explicitly invoked isolated browser fixtures.
- `scripts/`, `checks/`: build validation and release inventories.

Language, light/dark mode and accent color retain immediate local caches and synchronize through three allowlisted versioned browser sync keys. All model settings, keys, URLs, directory references/rules and bookmark keywords remain local. Language switching must not remount task owners, trigger model calls or translate native bookmark content. The Chinese/English catalog covers workspaces and browser-owned entrypoints. Native/user content, proper names and diagnostic identifiers intentionally retain their original text. Opt-in `tests/e2e/ai-services-localization.py --run` checks the quick setup path; add `--advanced` for model selection and feature assignment.

Save output optionally includes up to 5 keywords of 32 characters per assignment. One worker serializes the local keyword sidecar, bounded to 2000 entries / 2 MiB, and rechecks installation/ID/title/URL before attaching it. Confirmed panel saves use reconciled final-step identities; unknown writes do not attach metadata. Native edits/removal prune stale entries; local index construction independently filters freshness. Panel search, omnibox and fast candidate retrieval use it locally; keyword text is not added to model search payloads or public exports. `tests/e2e/onboarding.py --run --keywords` verifies first-install sidebar instructions, dismissal/reopening, completed AI setup, explicit save-window capture, one native-save model call, real local keyword search, movement retention and deletion cleanup with a local fixture provider.

## Isolated browser acceptance

Use a disposable profile and synthetic bookmarks. Scripts require `--run` and accept `--browser` for the local Chromium executable. Examples, run from the repository root:

Run the three main flows together with `python extension/tests/e2e/acceptance.py --run --browser /absolute/path/to/chromium`. It rebuilds and validates production assets first, then runs native save/keyword search, background organization and duplicate deletion/undo sequentially in separate fresh profiles. The temporary aggregate results include per-case logs/evidence and production asset hashes; failures return a nonzero exit code. Without `--run`, it only prints the plan. Python Playwright and an existing Chromium executable are required; nothing is downloaded. Run source tests before this command because build integration tests can replace `dist` with test-mode assets.

```sh
python extension/tests/e2e/search-entrypoints.py --run --browser /path/to/chromium
python extension/tests/e2e/suspected-duplicates.py --run --browser /path/to/chromium
python extension/tests/e2e/organize-partial-repair.py --run --browser /path/to/chromium
python extension/tests/e2e/history-search.py --run --browser /path/to/chromium
```

Read each script's scope before running it. Some fixtures instrument event delivery or use a synthetic loopback provider; they are not real-provider accuracy or physical omnibox/OS shortcut tests. Each writes evidence to a temporary directory.

The history fixture exercises native history reads/removal, explicit AI retrieval with a loopback provider, confirmed native saving, separate bookmark/history scopes, compact favicon/title rows, context menus and bilingual panel/options layouts. Its disposable copy grants history in the manifest to automate access; the browser permission dialog and real-provider recall remain separate manual checks. It never changes production JavaScript or reads an existing browser profile.

For model accuracy and latency comparisons, use the [model evaluation guide](../docs/development/model-evaluation.md) with a manually labeled dataset.

The opt-in `python extension/tests/e2e/recent-bookmarks.py --run --browser /path/to/chromium` fixture seeds native save dates in a disposable profile and checks local recent filters, progressive90-to360-day AI fallback, both bilingual surfaces and unchanged native bookmarks. It uses a synthetic loopback provider; real-provider recall and physical side-panel host behavior remain separate checks.

The opt-in `python extension/tests/e2e/personalization.py --run --browser /path/to/chromium` fixture verifies actual worker-owned progressive review, uncertain-item destinations, subset feedback, local preference edits/approval and subsequent search hints. It uses synthetic native bookmarks and a loopback model, checks bilingual narrow layouts and asserts no native writes before final confirmation. Personal preferences use a separate trusted local store, not browser sync, and never grant write authority.

## Dependencies and notices

Runtime notices are shipped from `public/THIRD_PARTY_NOTICES.txt`. `licenses.json` records installed dependency metadata. Keep dependency versions and bundled notices in sync when making dependency changes. Review the [repository layout](../docs/development/repository-layout.md) before adding files.

### Synthetic name-renaming acceptance / 合成改名验收

After a production build, run `python extension/tests/e2e/bookmark-renaming.py --run` from the repository root, optionally with `--browser <Chromium executable>`. It uses a disposable profile and loopback fixture to verify save-time name confirmation, local-rule advice, title/category correction learning, no learning for unchanged adoption, the disabled bulk-renaming route and bilingual narrow layouts. The retained RenameWorkbench component is covered separately by unit tests. It never changes a personal browser profile and does not measure real-provider naming quality.

构建后使用独立测试资料验证收藏建议、手动纠正、“直接采用不学习”及批量改名入口关闭；保留的改名组件由单元测试覆盖。不修改个人书签，也不代表真实模型命名质量。
