# Agent instructions

English · [简体中文](AGENTS.zh-CN.md)

## Start here

Read [README](README.en.md), [repository layout](docs/development/repository-layout.md), [architecture](docs/development/architecture.md), and [development commands](extension/README.md) before editing. Inspect `git status` and preserve existing work.

## Repository boundaries

- `extension/`: production extension, tests, synthetic fixtures and build configuration.
- `docs/`: maintained guides, reference, development, legal and build documentation; `docs/media/` holds reviewed public demonstration assets.
- `tools/`: repository/document validation, packaging and asset tools. `.github/`: CI and contribution templates.
- Build outputs and release ZIPs are generated files; keep them out of Git.

Put reusable synthetic fixtures in `extension/tests/fixtures/` or `extension/import/fixtures/`. Do not commit credentials, personal bookmarks or browser profiles.

## Implementation contracts

Native browser bookmarks are authoritative. Use the existing mutation coordinator, preview/confirmation and recovery journal; do not replay uncertain writes. Treat model output as untrusted data, validate IDs and current authority, and never execute model output as code. Keep credentials and private data out of shared artifacts. User-facing changes need Chinese and English UI/docs; language/theme changes must preserve drafts and task ownership. Preserve project and third-party license notices. The project uses PolyForm Noncommercial 1.0.0; describe it as source available for noncommercial purposes.

## Validation

Keep README focused on what the product does and how to use it, in everyday language. Put a brief license-name link and maintainer contact at the end. Keep documentation focused on current usage and implementation; put build and test instructions in developer documentation.

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

The repository check reads the Git index; stage only the intended files before the final check. Integration tests and the final build run sequentially. Use synthetic data and disposable profiles for browser tests. Source checks do not satisfy the manual release gates; see [build and packaging](docs/release/checklist.md). Report actual results and limits, update affected links and both language versions, and keep generated output ignored. Do not rewrite shared Git history.
