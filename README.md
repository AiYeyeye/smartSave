# 智栏 · Zhilan

[English](README.en.md) · 简体中文

Chrome / Edge 的浏览器原生书签助手。点星标后自动归类，用本地规则减少等待；批量整理先预览、再确认，写入保留备份和回执。

**源码公开，仅限非商业用途。** 自有代码采用 [PolyForm Noncommercial 1.0.0](LICENSE)，商用需另行书面授权；这不是 OSI 定义的开源许可。[许可说明](docs/legal/licensing.md) · 维护者 Astraxine · [联系邮箱](mailto:mmgnosit@gmail.com)。

[使用手册](docs/guides/user-guide.md) · [安装说明](docs/guides/install.md) · [演示视频](docs/media/zhilan-quick-tour.mp4) · [隐私政策](docs/privacy.md) · [商店上架资料](docs/store/README.md)

![智栏书签目录（虚构演示数据）](docs/media/screenshots/01-bookmarks.png)

## 可以做什么

- **收藏即归类**：优先使用已确认的网站规则和有把握的同域名归类，再调用你配置的 AI。超时保留原位，回执支持纠正和撤销；纠正后可单独确认网站规则。
- **批量整理**：先审核目录方案，再分批分析书签；默认两批并发，支持后台生成、关闭页面后重开查看，以及中断后的手动继续。最终修改仍需确认。
- **本地搜索与 AI 搜索**：标题、网址、目录、中文拼音和首字母参与本地检索；收藏归类可同时生成少量本地关键词，无需额外模型请求。AI 快速搜索和深度搜索由你显式触发。
- **重复清理**：区分精确重复与疑似链接变体，展示原始链接，手动选择保留和删除。
- **导入、导出与恢复**：导入 HTML / JSON / CSV / TXT / Markdown；导出 JSON / HTML / Markdown，支持本地文件输出和操作恢复记录。

浏览器原生书签是唯一事实源。无需智栏账号；AI 功能使用你已有的服务配置。密钥不会包含在公开配置导出中，模型主机权限按需申请。

语言、明暗模式和主题色可通过浏览器同步；服务密钥、网址、目录规则和书签关键词保留在本机。关键词仅用于增强当前匹配书签的搜索，删除、改名或改网址后清理；旧书签不会自动补发模型请求。

## 本地安装

需要 Node.js >=22.12、pnpm 11.7.0，以及 Chrome / Edge 116+。最低版本来自当前扩展配置，不代表所有浏览器版本都已验收。

```sh
pnpm --dir extension install --frozen-lockfile
pnpm --dir extension build
```

1. 打开浏览器的扩展管理页，开启开发者模式。
2. 加载已解压的扩展，选择本仓库的 `extension/dist`。
3. 点击扩展图标打开书签侧栏，在“AI 服务”连接已有服务并为功能指定模型。可先用“试分类当前网页”预览分类，确认配置是否合适。

默认侧栏覆盖在网页左侧；外观设置可改为浏览器侧边栏。浏览器内置页面会使用浏览器侧边栏。

## 快速搜索

- **Alt+Shift+K**：打开搜索；若与其他扩展冲突，可在浏览器扩展快捷键设置中修改。
- **地址栏输入 `zl`**，按 Tab 或空格，再输入关键词。选择候选打开书签，直接回车打开完整搜索页。
- **智栏界面内 Ctrl+K**（Mac：⌘K）：回到搜索并聚焦输入框。

语言入口位于快速设置和外观设置，中英文覆盖导航、搜索、AI 服务和各工作台。切换语言保留正在编辑的配置，不会翻译或修改你的书签标题、目录名与模型 ID。

## 验证状态

已建立单元/集成测试与隔离 Chromium 测试线，覆盖合成数据上的原生收藏、整理、后台生命周期、恢复、纠正规则、重复清理和搜索入口。测试使用临时浏览器配置，不等同于日常 Chrome / Edge、所有系统快捷键或真实模型的完整发布验收。

人工标注的 200 条模型评测集尚未准备，因此没有宣称真实分类准确率、收藏三秒或五百条三分钟达标。发布人工门仍然开放；源码检查通过不代表可以发布。

- [开发与测试命令](extension/README.md)
- [参与贡献](CONTRIBUTING.md) · [问题反馈](SUPPORT.md) · [安全报告](SECURITY.md) · [社区规范](CODE_OF_CONDUCT.md)
- [更新日志](CHANGELOG.md) · [第三方许可](docs/legal/third-party-licenses.md) · [发布待办清单](docs/release/checklist.md)


## 仓库结构

| 目录 | 内容 |
| --- | --- |
| `extension/` | 扩展源码、合成测试样例及构建配置 |
| `docs/` | 使用、协议、开发、许可、发布与商店文档 |
| `tools/` | 文档/仓库检查、素材和打包工具 |
| `.github/` | CI 与贡献模板 |

[完整文档导航](docs/README.md) · [目录与私有资料规则](docs/development/repository-layout.md) · [架构](docs/development/architecture.md) · [AI 助手规范](AGENTS.zh-CN.md)。

内部产品设计、调研、原型及会话记录不随仓库发布；维护者本机统一存于已忽略的 `.local/private/`，本地代理工具配置也不提交。候选 ZIP 写入 `.local/releases/`。公开源码可独立构建、测试，不需要这些私有文件。
