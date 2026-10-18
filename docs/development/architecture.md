# 架构 / Architecture

智栏是 React + TypeScript 的 Manifest V3 扩展，没有项目自建后端。浏览器原生书签是唯一事实源，模型只提供需要校验的建议。以下路径相对 `extension/`。

Zhilan is a React/TypeScript Manifest V3 extension without a project-operated backend. Native browser bookmarks are authoritative; models return proposals that must be validated. Paths below are relative to `extension/`.

| 层 / Layer | 责任 / Responsibility |
| --- | --- |
| `panel/`, `options/`, `ui/` | React 界面、工作台和双语目录 / React surfaces, workspaces and localization |
| `background/` | 原生事件、消息授权、写入协调器、后台整理与文件输出 / native events, authority, mutations, organization and file output |
| `domain/`, `schemas/` | 纯计划逻辑、ID/新鲜度检查、消息与模型 schema / planning, identities, freshness and schemas |
| `adapters/` | 浏览器 API 与模型协议边界 / browser APIs and model protocol boundaries |
| `persistence/` | 本地设置、操作日志、恢复证据与检查点 / local settings, journals, recovery evidence and checkpoints |
| `import/`, `export/` | 五格式解析、三格式输出和公开 JSON v1 / parsers, serializers and public JSON v1 |
| `public/` | manifest、图标、浏览器语言、分发许可 / manifest, icons, browser locales and notices |

## 关键约束 / Contracts

- 读取由共享树连接投影；旧缓存可显示，但不能作为当前写入授权。Shared tree reads may preserve display caches; cached data cannot authorize mutations.
- 写入经过统一协调器、当前范围/身份检查和操作日志；整理在最终确认后写入。未知结果先查询恢复证据，不自动重放。Mutations use the coordinator, current scope/identity checks and journal; organizing requires final confirmation. Unknown outcomes are reconciled without automatic replay.
- 整理生成由 worker 拥有并保存检查点，界面可以重新连接。持久化进度不等于持久化写入授权，恢复后重新预览。The worker owns generation checkpoints; reconnecting UI must obtain fresh apply authority.
- 模型请求沿用所选功能模型、隐私投影、权限与取消边界。流式回复需完整结束并通过 schema 和语义校验。Model calls use selected feature routes, privacy projection, host permission and cancellation; complete stream and semantic validation are required.
- 原生星标自动分类、只读搜索和显式网页试分类有不同入口；试分类不能写书签。Native-save classification, read-only search and explicit webpage trials have separate entrypoints; trials cannot write bookmarks.
- 语言、明暗和主题色可同步；模型密钥、规则、关键词、日志与恢复证据留在本地。Only allowlisted appearance/language preferences sync; credentials, rules, keywords, logs and recovery data stay local.

参阅 [模型协议](../reference/model-protocols.md)、[导出格式](../reference/export-json-v1.md)、[隐私政策](../privacy.en.md) 和 [测试命令](../../extension/README.md)。公共构建与测试不读取维护者的任务/会话目录。

See the linked protocol, export, privacy and development references for executable boundaries. Public builds/tests do not read maintainer task or session directories.
