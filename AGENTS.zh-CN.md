# AI 助手协作说明

[English](AGENTS.md) · 简体中文

## 开始工作

修改前阅读 [README](README.md)、[目录规则](docs/development/repository-layout.md)、[架构说明](docs/development/architecture.md) 和 [开发命令](extension/README.md)。先检查 `git status`，保留已有修改。

## 文件边界

- `extension/`：扩展源码、测试、合成样例和构建配置。
- `docs/`：使用指南、格式与协议、开发、许可和构建文档；`docs/media/` 仅放已审核的公开演示素材。
- `tools/`：仓库/文档校验、打包和素材工具；`.github/`：CI 与贡献模板。
- 构建产物和发行 ZIP 为生成文件，不加入 Git。

可复用的合成测试样例放到 `extension/tests/fixtures/` 或 `extension/import/fixtures/`。不要提交凭据、私人书签或浏览器配置。

## 实现约束

直接读写浏览器里的书签，不另建一套书签库。沿用统一写入协调器、预览/确认和恢复日志，不能重放结果未知的写入。模型输出是不可信数据，必须校验 ID 与当前授权，不能作为代码执行。凭据和私人内容不得进入共享产物。面向用户的改动同步中英文界面及文档，切换语言/主题不能丢草稿或重建任务。保留项目和第三方许可；当前为 PolyForm Noncommercial 1.0.0，应表述为“非商业用途源码公开”。

## 验证

README 用日常语言介绍功能和使用方式；许可名称链接和维护者联系方式放在末尾。文档说明当前用法和实现，构建与测试命令写在开发文档中。

在仓库根目录依次执行：

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

仓库检查读取 Git 暂存区，最终检查前仅暂存本次应提交的文件。集成测试与最终生产构建必须顺序执行。浏览器测试使用合成数据与独立临时配置。源码检查不能替代人工发布门，见 [构建与打包](docs/release/checklist.md)。如实报告结果及限制，同步相关链接和双语版本，生成物保持忽略。不得重写共享 Git 历史。
