# AI 助手协作说明

[English](AGENTS.md) · 简体中文

## 开始工作

修改前阅读 [README](README.md)、[目录规则](docs/development/repository-layout.md)、[架构说明](docs/development/architecture.md) 和 [开发命令](extension/README.md)。先检查 `git status`，保留已有修改。公开仓库必须能独立构建和测试，不依赖私有文件或特定代理工具。

## 文件边界

- `extension/`：扩展源码、测试、合成样例和构建配置。
- `docs/`：使用指南、格式与协议、开发、许可、发布和商店文档；`docs/media/` 仅放已审核的公开演示素材。
- `tools/`：仓库/文档校验、打包和素材工具；`.github/`：CI 与贡献模板。
- `.local/`：已忽略的私有归档、诊断、临时工作和发行 ZIP，不得提交或上传。
- `.trellis/`、`.agents/`、`.codex/`：可选的本地自动化配置，已忽略；存在时阅读对应工作流和规范。公开代码、测试和文档不得依赖这些目录，也不得强制加入 Git。

原始产品需求、设计附件、原型、研究、私人书签、真实模型回复、凭据和会话日志放到 `.local/private/<分类>/`。可复用的合成测试样例放到 `extension/tests/fixtures/` 或 `extension/import/fixtures/`。

## 实现约束

浏览器原生书签是唯一事实源。沿用统一写入协调器、预览/确认和恢复日志，不能重放结果未知的写入。模型输出是不可信数据，必须校验 ID 与当前授权，不能作为代码执行。凭据和私人内容不得进入共享产物。面向用户的改动同步中英文界面及文档，切换语言/主题不能丢草稿或重建任务。保留项目和第三方许可；当前为 PolyForm Noncommercial 1.0.0，应表述为“非商业用途源码公开”。

## 验证

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

仓库检查读取 Git 暂存区，最终检查前仅暂存本次应提交的文件。集成测试与最终生产构建必须顺序执行。浏览器测试使用合成数据与独立临时配置。源码检查不能替代人工发布门，见 [发布状态](docs/release/status.md)。如实报告结果及限制，同步相关链接和双语版本，生成物保持忽略。删除提交不能清除旧历史；不得把共享历史重写作为日常整理操作。
