# 目录结构 / Repository layout

| 路径 / Path | 用途 / Purpose |
| --- | --- |
| `extension/` | 扩展源码、构建配置与测试 / extension source, build configuration and tests |
| `docs/guides/` | 安装、使用、模型设置与恢复 / installation, usage, model setup and recovery |
| `docs/reference/` | 数据格式与模型协议 / data formats and model protocols |
| `docs/development/` | 架构、目录结构与评测方法 / architecture, layout and evaluation |
| `docs/legal/` | 项目与第三方许可 / project and third-party licensing |
| `docs/release/` | 构建与打包 / builds and packaging |
| `docs/media/` | 界面截图与演示视频 / screenshots and demo video |
| `docs/privacy.*` | 中英文隐私政策及网页 / privacy policies and HTML page |
| `tools/` | 仓库、文档、打包与素材工具 / repository, documentation, packaging and media tools |
| `.github/` | CI 与贡献模板 / CI and contribution templates |

根目录放项目入口、许可证、贡献说明和必要配置。新增文档按用途分类，文件名使用简短的英文 kebab-case；独立中英文版本使用语言后缀并互链。

Keep project entrypoints, licensing, contribution guidance and essential configuration at the root. Group documents by purpose. Use concise English kebab-case filenames and language suffixes for translations, with reciprocal links.

可复用测试样例放在 `extension/tests/fixtures/` 或 `extension/import/fixtures/`，使用合成数据。构建输出为 `extension/dist/`，发行 ZIP 输出为 `.local/releases/`；生成物不提交。

Put reusable synthetic fixtures in `extension/tests/fixtures/` or `extension/import/fixtures/`. Builds write to `extension/dist/` and release ZIPs to `.local/releases/`; generated files are not committed.

提交前运行 `python tools/check-repository.py` 和 `python tools/check-docs.py`，检查暂存文件、文档链接、许可证及素材。完整命令见 [扩展开发说明](../../extension/README.md)。

Before committing, run the repository and documentation checks above to validate staged files, links, licensing and media. See [extension development](../../extension/README.md) for the full command list.
