# Extension development

[Project overview](../README.en.md) · [中文说明](../README.md)

This is the Manifest V3 extension for 智栏 / Zhilan. Browser bookmarks are authoritative; model results are validated data. Native changes use the shared mutation coordinator, journal and backup/recovery path.

## Build and check

Use Node.js >=22.12 and pnpm 11.7.0. Dependencies are pinned in `pnpm-lock.yaml`.

```sh
pnpm --dir extension install --frozen-lockfile
pnpm --dir extension lint
pnpm --dir extension typecheck
pnpm --dir extension test
pnpm --dir extension test:integration
pnpm --dir extension build
pnpm --dir extension release:source
```

Integration tests write test-mode build artifacts. Run the final production build **after** integration tests; do not run them concurrently. Load only `extension/dist` as an unpacked extension. Formatting uses Prettier (`format` / `format:check`).

`release:source` validates the source and artifact inventory, static manifest/module references and shipped notices. `release:ready` additionally requires the manual release evidence. Neither command manufactures browser or provider evidence.

## Runtime and permissions

The current manifest requires Chrome 116+. A toolbar click opens a left overlay on eligible webpages, or the browser side panel on browser-owned pages / when selected in Appearance. Long workspaces use `options/index.html`. The only web-accessible resource is `panel/index.html`; an injected overlay must claim the exact worker-issued document token before it is trusted. Restored claims remain bound to their original tab, frame and document.

Required permissions: bookmarks, storage, activeTab, scripting, contextMenus, favicon and sidePanel. Optional identity is used for user-triggered OpenRouter sign-in. Optional HTTP(S) host declarations support user-configured model services; actual host access is requested when needed. There are no mandatory host permissions or persistent manifest content scripts. Scripts used for explicit extraction/overlay injection are built as classic scripts without dynamic imports.

The toolbar/save entrypoints and browser-native bookmark classification are separate from read-only search. `search-bookmarks` suggests Alt+Shift+K; the omnibox keyword is `zl`. Search verifies current native identity and URL before opening a result. Full-query handoff uses short-lived worker memory rather than query text in navigation URLs.

AI routes support OpenAI Chat Completions and Responses, Anthropic Messages and Gemini. Configure an existing service and assign models by feature. Fast search uses bounded retrieval; deep search checks allowed bookmarks in batches. Local rules may avoid a model call. Only 429 and explicit 5xx responses receive bounded retries; interrupted streams and uncertain native writes are not automatically replayed.

## Source layout

- `domain/`, `schemas/`: bookmark identities, pure planning, validators and wire contracts.
- `adapters/`, `background/`: browser/model boundaries and worker-owned tasks.
- `persistence/`: settings, rules, receipts, journals and task checkpoints.
- `panel/`, `options/`, `ui/`: React surfaces. `ui/i18n/` owns the incremental Chinese/English UI catalog.
- `tests/`: unit/component and real-build integration tests. `tests/e2e/` contains explicitly invoked isolated browser fixtures.
- `scripts/`, `checks/`: build validation and release inventories.

Language, light/dark mode and accent color retain immediate local caches and synchronize through three allowlisted versioned browser sync keys. All model settings, keys, URLs, directory references/rules and bookmark keywords remain local. Language switching must not remount task owners, trigger model calls or translate native bookmark content. English covers the workspaces and browser-owned entrypoints; the final owned-message audit includes uncommon status paths. Native/user content, proper names and diagnostic identifiers intentionally retain their original text. Opt-in `tests/e2e/ai-services-localization.py --run` checks the quick setup path; add `--advanced` for model selection and feature assignment.

Save output optionally includes up to5 keywords of32 characters per assignment. One worker serializes the local keyword sidecar, bounded to2000 entries/2MiB, and rechecks installation/ID/title/URL before attaching it. Confirmed panel saves use reconciled final-step identities; read-only trials and unknown writes do not attach metadata. Native edits/removal prune stale entries; local index construction independently filters freshness. Panel search, omnibox and fast candidate retrieval use it locally; keyword text is not added to model search payloads or public exports. `tests/e2e/onboarding-trial.py --run --keywords` verifies an explicit read-only trial, one native-save model call, real local keyword search, movement retention and deletion cleanup with a local fixture provider.

## Isolated browser acceptance

Use a disposable profile and synthetic bookmarks. Scripts require `--run` and accept `--browser` for the local Chromium executable. Examples, run from the repository root:

Run the three main flows together with `python extension/tests/e2e/acceptance.py --run --browser /absolute/path/to/chromium`. It rebuilds and validates production assets first, then runs native save/keyword search, background organization and duplicate deletion/undo sequentially in separate fresh profiles. The temporary aggregate results include per-case logs/evidence and production asset hashes; failures return a nonzero exit code. Without `--run`, it only prints the plan. Python Playwright and an existing Chromium executable are required; nothing is downloaded. Run source tests before this command because build integration tests can replace `dist` with test-mode assets.

```sh
python extension/tests/e2e/search-entrypoints.py --run --browser /path/to/chromium
python extension/tests/e2e/suspected-duplicates.py --run --browser /path/to/chromium
python extension/tests/e2e/organize-partial-repair.py --run --browser /path/to/chromium
```

Read each script's scope before running it. Some fixtures instrument event delivery or use a synthetic loopback provider; they are not real-provider accuracy or physical omnibox/OS shortcut tests. Each writes evidence to a temporary directory. The public [release status](../docs/release/status.md) describes evidence boundaries and remaining gates.

Actual labeled-provider accuracy/latency evaluation is deferred until the user supplies manually labeled data. User-specific evaluation inputs and reports stay outside release source inventories. Do not publish or push private datasets, credentials or diagnostic request bodies.

## Dependencies and notices

Runtime notices are shipped from `public/THIRD_PARTY_NOTICES.txt`. `licenses.json` records installed metadata; dependency audit snapshots are local reports, not current security guarantees; do not commit them. Keep dependency versions and bundled notices in sync when making dependency changes. Public builds need no private task/agent directories. Review the [repository layout](../docs/development/repository-layout.md) before adding files.
