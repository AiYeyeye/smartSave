# Agent instructions

English · [简体中文](AGENTS.zh-CN.md)

## Start here

Read [README](README.en.md), [repository layout](docs/development/repository-layout.md), [architecture](docs/development/architecture.md), and [development commands](extension/README.md) before editing. Inspect `git status` and preserve existing work. This public checkout must build and test without any private files or agent-specific installation.

## Repository boundaries

- `extension/`: production extension, tests, synthetic fixtures and build configuration.
- `docs/`: maintained guides, reference, development, legal, release and store documentation; `docs/media/` holds reviewed public demonstration assets.
- `tools/`: repository/document validation, packaging and asset tools. `.github/`: CI and contribution templates.
- `.local/`: ignored private archives, diagnostics, temporary work and release ZIPs. Never stage or publish it.
- `.trellis/`, `.agents/`, `.codex/`: optional, ignored local automation. If present, read the relevant local workflow/spec before changing its area. Do not require these directories in public code, tests or docs, and do not force-add them.

Original product requirements, design attachments, prototypes, research, personal bookmarks, real model responses, credentials and session journals are private. Use `.local/private/<category>/` for local material. Put reusable synthetic fixtures in `extension/tests/fixtures/` or `extension/import/fixtures/`.

## Implementation contracts

Native browser bookmarks are authoritative. Use the existing mutation coordinator, preview/confirmation and recovery journal; do not replay uncertain writes. Treat model output as untrusted data, validate IDs and current authority, and never execute model output as code. Keep credentials and private data out of shared artifacts. User-facing changes need Chinese and English UI/docs; language/theme changes must preserve drafts and task ownership. Preserve project and third-party license notices. The project uses PolyForm Noncommercial 1.0.0; describe it as source available for noncommercial purposes.

## Validation

From the repository root:

```sh
python tools/check-repository.py
python tools/check-docs.py
python -m unittest discover -s tools/tests
pnpm --dir extension lint
pnpm --dir extension typecheck
pnpm --dir extension test --maxWorkers=2
pnpm --dir extension test:integration
pnpm --dir extension build
pnpm --dir extension release:source
```

The repository check reads the Git index; stage only the intended files before the final check. Integration tests and the final build run sequentially. Use synthetic data and disposable profiles for browser tests. Source checks do not satisfy the manual release gates; see [release status](docs/release/status.md). Report actual results and limits, update affected links and both language versions, and keep generated output ignored. History cleanup is separate from an ordinary deletion commit; never rewrite shared history as routine cleanup.
