# AI 服务 UI（对齐 redesign SoT）

侧栏摘要 + 独立管理页。视觉 / 交互以 `/workspace/smartsave-ai-services-redesign.html` 与 `smartsave-ai-services-design-spec.md` 为定稿；业务层继续走真实 `useAiServices` store（`chrome.storage.local.aiServices`），复用 `listModels`、`ModelTransport`、`SettingsStore`。

## 定稿要点

| 项 | 约定 |
| --- | --- |
| 侧栏宽度 | popup **定宽 ≈380px**（`body.popup` / redesign `--sidebar-w`） |
| 暗色 Token | `--page #121212` · `--bg #1a1a1a` · `--card #242424/#2a2a2a` · `--border #333` · `--text #f3f4f6` · `--muted #9ca3af` · `--accent #3b82f6` · folder `#eab308` · radius 12–16px · 树行高 ~32px |
| 功能用模 | 侧栏与管理页均列出全部 **5** 项（导入/收藏/搜索/整理/页面分类） |
| 模型选择器 | **行内展开**（搜索 + 按连接分组）；宽度跟随侧栏/卡片；**禁止 `position:fixed` 浮出 ≈380px 边界** |
| 主名 | 产品主名写 **Anthropic**，不写 Claude（订阅副文案可保留 Claude Pro） |
| 书签树 | 自写交互；对照手感见 `docs/research/bookmark-projects-learning.md` §3.5；**MS-RSL：禁止复制 Bookmark Sidebar 的代码/CSS/资源/品牌** |

## 文件列表

| 文件 | 作用 |
|------|------|
| `mock-data.ts` | 类型、hash、厂商目录（来自 `domain/ai-providers`） |
| `useAiServices.ts` | 持久化 store hook |
| `ai-services.css` | redesign 暗色 token 与组件样式 |
| `AiSidebarSummary.tsx` | 侧栏设置摘要（chips + 五项行内用模） |
| `AiServicesPage.tsx` | 管理页壳 |
| `panels.tsx` | 已连接 / 添加 / 功能用模 / 导入导出 |
| `EditServiceOverlay.tsx` | 编辑：获取列表、测试连接、保存 |
| `ModelPicker.tsx` | 行内模型选择器（非 fixed） |
| `Avatar.tsx` / `toast.tsx` / `index.ts` | 辅助 |

## 侧栏书签相关（extension 宿主）

| 面 | 说明 |
| --- | --- |
| `ui/PanelChrome.tsx` + `PanelFooter` | 品牌 + 设置齿轮、常驻搜索、Footer 整理/导入/导出 |
| `ui/theme.css` | `body.popup` / `.shell.panel` **scoped** 暗色覆盖；options 其他 soft-ui 不整站打碎 |
| `panel/BookmarkTree.tsx` | 展开折叠、拖拽 before/after 蓝线 / 文件夹中部移入高亮、⋯/右键（上移下移、重命名、移入…、删除、新建）；根目录不可重命名/删除/拖出（既有 `readOnly`） |

## 路由 hash

| Hash | 行为 |
|------|------|
| `#ai-services` | 管理页 · 已连接 |
| `#ai-services/add` | 管理页 · 添加服务 |
| `#ai-services/features` | 管理页 · 功能用模 |
| `#ai-services/io` | 管理页 · 导入导出 |

## 如何验证（Chrome）

1. `cd extension && pnpm install && npx tsc --noEmit`（或 `pnpm build`）
2. `chrome://extensions` → 加载已解压的扩展 → 选构建产物目录
3. **侧栏**：打开 toolbar popup（≈380px）对照 `/workspace/smartsave-ai-services-redesign.html`「侧栏·书签主页 / 设置摘要」
4. **管理页**：`chrome-extension://<id>/options/index.html#ai-services` 对照 redesign 已连接 / 添加 / 功能用模 / 导入导出 / 编辑层
5. 添加服务 → API Key → 连接；编辑 →「获取列表」/「测试连接」/「保存服务」
6. 侧栏设置摘要内点功能用模行 → 行内展开选模型（不得溢出侧栏）

## OAuth 现状

订阅区均为 `needs-browser-flow` 或 `unsupported`：需要 `chrome.identity` / `launchWebAuthFlow`，当前只展示说明，请用 API Key。
