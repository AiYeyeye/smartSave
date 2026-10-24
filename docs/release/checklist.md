# 构建与打包 / Build and package

在仓库根目录执行以下命令。集成测试会重新生成测试用构建，因此最终生产构建需要放在其后。

Run these commands from the repository root. Integration tests generate test builds, so run the final production build afterward.

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
python tools/package-release.py --candidate
```

打包工具重新构建并校验产物，在 `.local/releases/` 生成 ZIP 和 SHA-256 校验文件。压缩包根目录含 `manifest.json`，并包含运行扩展所需的文件和许可证。

The packager rebuilds and validates production assets, then writes a ZIP and SHA-256 sidecar to `.local/releases/`. The ZIP has `manifest.json` at its root and includes extension runtime files and license notices.

不带 `--candidate` 的正式打包会先执行 `release:ready`。它同时检查浏览器兼容性、恢复、权限、性能及人工审核条件。开发命令和浏览器测试方式见 [扩展开发说明](../../extension/README.md)。

Packaging without `--candidate` runs `release:ready`, which also checks browser compatibility, recovery, permissions, performance and manual review requirements. See [extension development](../../extension/README.md) for test commands and browser workflows.
