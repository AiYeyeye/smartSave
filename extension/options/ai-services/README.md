# AI 服务 UI（真实数据层）

侧栏摘要 + 独立管理页。连接 / 拉模型 / 测试 / 保存写入 `AiServicesStore`（`chrome.storage.local.aiServices`），并复用 `listModels`、`ModelTransport`、`SettingsStore` 同步主路由。

## 文件列表

| 文件 | 作用 |
|------|------|
| `mock-data.ts` | 类型、hash、厂商目录（来自 `domain/ai-providers`） |
| `useAiServices.ts` | 持久化 store hook（替代原会话 mock） |
| `ai-services.css` | 布局与组件样式 |
| `AiSidebarSummary.tsx` | 侧栏摘要 |
| `AiServicesPage.tsx` | 管理页壳 |
| `panels.tsx` | 已连接 / 添加 / 功能用模 / 导入导出 |
| `EditServiceOverlay.tsx` | 编辑：获取列表、测试连接、保存 |
| `ModelPicker.tsx` / `Avatar.tsx` / `toast.tsx` / `index.ts` | 辅助组件 |

## 路由 hash

| Hash | 行为 |
|------|------|
| `#ai-services` | 管理页 · 已连接 |
| `#ai-services/add` | 管理页 · 添加服务 |
| `#ai-services/features` | 管理页 · 功能用模 |
| `#ai-services/io` | 管理页 · 导入导出 |

## 如何验证（Chrome）

1. `cd extension && pnpm install && pnpm build`
2. `chrome://extensions` → 加载已解压的扩展 → 选 `extension/dist`（或构建产物目录）
3. 打开 `chrome-extension://<id>/options/index.html#ai-services`
4. **添加服务** → 选厂商 → 填 API Key（OpenAI/Anthropic 可改 Base URL）→ 连接（会请求主机权限并尝试 `listModels`）
5. **编辑** →「获取列表」/「测试连接」/「保存服务」
6. **功能用模** 分配会同步主连接到旧 `SettingsStore`（智能收藏优先）
7. 订阅登录卡片会说明 OAuth 未接线，**不会**假成功

## OAuth 现状

订阅区（Anthropic / OpenAI / xAI / OpenRouter / Kimi / GitHub Copilot / Meta）均为 `needs-browser-flow` 或 `unsupported`：需要 `chrome.identity` / `launchWebAuthFlow`，当前只展示说明，请用 API Key。

## 主名

产品主名写 **Anthropic**，不写 Claude（订阅副文案可保留 Claude Pro）。
