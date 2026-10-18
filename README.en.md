# Zhilan · 智栏

English · [简体中文](README.md)

A Chrome / Edge extension for browser bookmarks. Classify new bookmarks when you use the browser's star, search locally, and review bulk changes before applying them.

**Source available for noncommercial purposes.** Project-owned code uses [PolyForm Noncommercial 1.0.0](LICENSE); commercial use requires separate written authorization. This is not an OSI-approved open-source license. [License details](docs/legal/licensing.md). Maintainer: Astraxine · [Contact](mailto:mmgnosit@gmail.com).

[Quick guide](docs/guides/user-guide.en.md) · [Install](docs/guides/install.md) · [Demo video](docs/media/zhilan-quick-tour.mp4) · [Privacy](docs/privacy.en.md) · [Store publication kit](docs/store/README.md)

![Zhilan bookmark workspace with synthetic demonstration data](docs/media/screenshots/01-bookmarks.png)

## Features

- **Classify as you save.** Confirmed website rules and confident same-domain matches run locally before AI. A timeout leaves the bookmark where it is. Receipts offer correction and undo; saving a website rule requires separate confirmation.
- **Organize in batches.** Review the folder plan first, then analyze bookmarks with two concurrent batches by default. Generation continues in the background. Reopen the workspace to review progress, or manually resume interrupted work. Applying changes always requires confirmation.
- **Local and AI search.** Search titles, URLs, folder paths, Chinese pinyin and initials locally. Save classification can also generate a few local search keywords in the same model request. Fast AI search and segmented deep search run only when requested.
- **Review duplicates.** Exact duplicates and suspected URL variants are labeled separately. Original URLs remain visible, with explicit keep/delete choices.
- **Import, export and recover.** Import HTML, JSON, CSV, TXT or Markdown. Export JSON, HTML or Markdown, save to local files and inspect operation recovery records.

Native browser bookmarks are the source of truth. No Zhilan account is needed. AI features use services you already have; public configuration exports exclude credentials, and model host access is requested as needed.

Language, light/dark mode and accent color can sync through your browser. Provider keys, URLs, folder rules and bookmark keywords stay local. Keywords enrich only matching native bookmarks and are removed after deletion, title or URL changes. Existing bookmarks do not trigger automatic model requests for enrichment.

## Install from source

Requirements: Node.js >=22.12, pnpm 11.7.0 and Chrome / Edge 116+. This browser minimum is the current manifest requirement, not a claim that every supported version has been tested.

```sh
pnpm --dir extension install --frozen-lockfile
pnpm --dir extension build
```

1. Open your browser's extension management page and enable Developer mode.
2. Choose **Load unpacked** and select `extension/dist` from this repository.
3. Click the extension icon to open the sidebar. In **AI services**, connect your existing service and assign models. The current-page classification trial previews a recommendation without moving or saving a bookmark.

The sidebar overlays the left edge of a webpage by default. Appearance settings can switch to the browser side panel. Browser-owned pages use the side panel automatically.

## Search shortcuts

- **Alt+Shift+K** opens search. Conflicts with other extensions can be resolved in your browser's extension shortcut settings.
- Type **`zl`** in the address bar, press Tab or Space, then enter keywords. Select a suggestion to open a bookmark, or press Enter on the default item to open full search.
- Within the extension, **Ctrl+K** (Mac: ⌘K) returns to search and focuses its input.

The language selector is in quick settings and Appearance. Chinese and English cover navigation, search, AI service settings and workspaces. Switching languages preserves bookmark titles, folder names, model IDs and unsaved input.

## Validation and release status

The project has unit/integration tests and isolated Chromium acceptance scripts using synthetic bookmarks and temporary profiles. These exercise native saving, organization, background lifecycle, recovery, correction rules, duplicate cleanup and search entrypoints. They do not establish complete release acceptance for everyday Chrome / Edge profiles, physical system shortcuts or real providers.

A manually labeled 200-bookmark evaluation set is still pending. There is no verified claim of model accuracy, a three-second median save time or organizing 500 bookmarks in three minutes. Manual release gates remain open; passing source checks does not make a release ready.

- [Development and test commands](extension/README.md)
- [Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md) · [Third-party licenses](docs/legal/third-party-licenses.md) · [Release checklist](docs/release/checklist.md)


## Repository layout

| Directory | Contents |
| --- | --- |
| `extension/` | Extension source, synthetic fixtures and build configuration |
| `docs/` | User, reference, development, legal, release and store documentation |
| `tools/` | Repository/document checks, assets and packaging tools |
| `.github/` | CI and contribution templates |

[Documentation index](docs/README.md) · [Layout and private-material rules](docs/development/repository-layout.md) · [Architecture](docs/development/architecture.md) · [Agent instructions](AGENTS.md).

Internal product designs, research, prototypes and session records are excluded from distribution. Maintainer archives live in ignored `.local/private/`; local agent configuration is also excluded. Candidate ZIPs go to `.local/releases/`. Public builds and tests work without private material.
