# AI services UI / AI 服务界面

This module provides setup, service editing, model selection, feature assignment and configuration transfer. It uses `useAiServices`, the local service store and the shared discovery/transport adapters.

本模块提供引导设置、服务编辑、模型选择、功能分配和配置传输，复用现有服务存储及模型适配器。

| Files | Responsibility / 责任 |
| --- | --- |
| `SetupWizard.tsx` | Explicit model selection and feature assignment; saving completes setup / 明确选择模型与分配功能，保存即完成 |
| `AiServicesPage.tsx`, `panels.tsx` | Connected/add/features/import-export views / 管理页 |
| `AiSidebarSummary.tsx`, `ModelPicker.tsx` | Sidebar summary and inline selection / 摘要与行内选择 |
| `EditServiceOverlay.tsx` | Discovery, synthetic connection test and save / 列表、合成连接测试与保存 |
| `useAiServices.ts`, `mock-data.ts` | Store lifecycle and shared catalog/types / 存储生命周期与目录类型 |
| `ai-services.css` | Styles mapped to shared theme tokens / 共享主题变量 |

The production host is a webpage overlay or browser side panel, not a fixed-width toolbar popup. Options pages host longer workspaces. Preserve narrow layouts, keyboard access, localized labels and unsaved input. Discovery is separate from generation testing; generation tests use synthetic data and do not write bookmarks. Public configuration exports exclude credentials.

生产宿主为网页覆盖侧栏或浏览器侧栏，长工作台位于 options 页面。保持窄屏、键盘、双语和草稿保留；获取模型列表不等于生成测试，生成测试使用合成数据且不写书签。公开配置导出排除凭据。

Routes: `#ai-services`, `#ai-services/add`, `#ai-services/features`, `#ai-services/io`. OpenRouter login uses the optional identity permission and PKCE via `adapters/openrouter-oauth.ts`; other provider cards use the implemented API-key flows.

Run the [development checks](../../README.md). Opt-in `tests/e2e/ai-services-localization.py --run` exercises quick setup; `--advanced` covers advanced selection/assignment. Use synthetic bookmarks and a disposable browser profile.
