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

打包工具重新构建并校验产物，在 `.local/releases/` 生成 ZIP 和 SHA-256 校验文件。压缩包内仅包含运行扩展所需的文件和许可证，不包含源码、测试、浏览器配置或私有资料。

The packager rebuilds and validates production assets, then writes a ZIP and SHA-256 sidecar to `.local/releases/`. It includes extension runtime files and license notices, without source, tests, browser profiles or private material.

不带 `--candidate` 的正式打包会先执行 `release:ready`。它同时检查人工发布条件；不要通过删除条件或把候选包改名来跳过检查。开发命令和浏览器测试方式见 [扩展开发说明](../../extension/README.md)。

Packaging without `--candidate` runs `release:ready`, which also enforces manual release conditions. Do not bypass these by removing checks or renaming a candidate package. See [extension development](../../extension/README.md) for test commands and browser workflows.
