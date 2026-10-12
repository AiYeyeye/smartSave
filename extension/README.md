# 智栏 extension foundation

正式 MV3 工程外壳，不是完整书签产品。已实现原生树投影、CRUD、唯一安全写入内核（操作日志 v2）、恢复面板（撤销 / 需处理 / 高级）、主动收藏、模型设置与提示词层、按需 AI 搜索、范围整理与精确去重、五格式导入与导出。产品方向已于 2026-09-22 转为「浏览器原生收藏 → 后台自动分类 → 先写后告知」（见 `docs/PRD-1.0.md` 第 15 节）；自动分类、本地镜像与标签尚未实现。无账号或官方模型服务。

## 开发与检查

Node >=22.12（本次 Node 24.18.0），pnpm 11.7.0；依赖以 pnpm-lock.yaml 为准。Prettier 已启用（`pnpm format` / `pnpm format:check`，printWidth 120）。

```sh
pnpm --dir extension install --frozen-lockfile
pnpm --dir extension format:check
pnpm --dir extension lint
pnpm --dir extension typecheck
pnpm --dir extension test --maxWorkers=2
pnpm --dir extension test:integration
pnpm --dir extension build
pnpm --dir extension release:source
```

`extension/dist` 是唯一加载目录。构建输出浏览器侧边栏（`panel/index.html`，`side_panel.default_path`，点工具栏按钮整高弹出，Chrome/Edge 116+）、选项页（`options/index.html`，完整工作台）及静态 ES module service worker；声明 `bookmarks`、`storage`、`activeTab`、`scripting`、`contextMenus`、`favicon`、`sidePanel` 权限，可选 `identity`（OpenRouter 登录时申请）；可选主机声明 `https://*/*` 和 `http://*/*`，没有必需 host_permissions，没有 `web_accessible_resources`，不注入任何网页。实际模型主机授权按用户配置申请。可在**用户授权的隔离 Chrome/Edge profile**中加载解压扩展：点击工具栏打开 Popup；Popup 的「AI 整理 / 导入 / 导出」在选项页新标签打开（`options/index.html#organize|#import|#export`）。批准的最低版本为 Chrome 114（`checks/release.mjs` 的 `approvedMinimumChromeVersion`）；命名快捷键与页面右键菜单在 Chrome 127+ 会直接打开 Popup（`chrome.action.openPopup`），更低版本改为在该标签的工具栏图标上显示角标，用户点击后 Popup 收到已捕获的页面。未启动日常浏览器。

信任模型：Popup 与选项页是仅有的两个可信文档，`domain/trusted-sender.ts` 按扩展 id、精确文档路径、无 query、非网页承载判定，不再有 nonce 握手或 Service Worker 内存注册表。外观在两个页面均可调；每个打开的页面仅保留自身会话主题，关闭重开回到第三种，不跨页面同步。页面草稿仅内存；手动收藏与 CRUD 通过唯一写入内核确认执行。所有功能未接入状态明确标注，没有安装演示书签。

## Build contract

Content script owners use `contentScriptConfig(entry, outDir)` from `scripts/content-script-config.ts`, **not** the panel ES-module build. Vitest builds a synthetic fixture into an OS temp directory and verifies classic-script parsing and absence of runtime imports. content-script.js is shipped for explicit activeTab/scripting extraction; no persistent manifest content_scripts entry is declared. `scripts/validate-build.mjs` validates actual distribution references and static JS module imports, not Chrome lifecycle execution.

Shared theme tokens: `ui/theme.css`; `ThemeProvider` changes an attribute without replacing children. Public empty/error/loading UI: `StateMessage`; native form/dialog selectors share the same tokens. Task03 uses fake-indexeddb for the durable operation-journal tests; no real user bookmark data is mutated. The native writer is consumed by the CRUD/save and recovery interfaces.

## Dependencies and licenses

`audit.json` contains the actual official npm audit result (zero known advisories at check time, not a guarantee). The configured mirror had no audit endpoint, so audit used `https://registry.npmjs.org`. A dev transitive ansi-regex 5.0.0 high-severity advisory was fixed via a narrowly pinned 5.0.1 workspace override. TypeScript 6.0.3 meets typescript-eslint's peer range; initial latest 7.0.2 did not.

`licenses.json` records installed package metadata. Runtime shipped notices for React/ReactDOM/scheduler (MIT) and Lucide (ISC) are in `public/THIRD_PARTY_NOTICES.txt` and copied to dist. pinyin-pro 3.29.3 (MIT) supplies bundled local pinyin data and has a shipped notice. Zod (MIT) validates runtime tree/mutation/journal boundaries and its notice is shipped. fake-indexeddb (Apache-2.0) is test-only. Tool-only Lightning CSS and its Windows binary use MPL-2.0; they are unmodified development dependencies, not included in the extension distribution. Other reported licenses: MIT, MIT-0, Apache-2.0, BSD-2/3-Clause, ISC, BlueOak-1.0.0, CC0-1.0. No external project source/assets were transplanted.

## Evidence boundary

Unit tests are jsdom interaction checks. Integration tests perform real Vite builds and parse files. They do **not** establish real Chrome/Edge side-panel rendering, width, permissions, SW startup or restart behavior. See the foundation task's validation.md for unexecuted runtime gates.

## Mutation owner and recovery boundary
See `.trellis/spec/frontend/write-boundary.md` for strict v1 commands and result semantics. Same requestId never replays. `reconcileMutation` is read-only native inspection; unknown creates are never adopted by URL. Unknown operations block new writes until proof-based reconciliation or explicit task05 quarantine acknowledgement. Quarantine preserves unknown evidence and never resumes the original request. Logs contain local private bookmark titles/URLs, not keys/body text. No clear-database workaround is supported. Browser/API/worker interruption acceptance remains NOT RUN.

## Import panel (task10 integration, acceptance incomplete)
`ui/App.tsx` retains `panel/ImportWorkbench.tsx` while toggling Import/appearance/organizer; themes do not remount it. The file picker calls `import/worker-client.ts`, never the synchronous parser. It composes the shared SettingsStore with browserModelAuthority/ModelTransport/ImportPipeline and the real ImportController/dedicated worker authority. Parsing and every model continuation are explicit actions. Checkpoint listing uses a cursor metadata projection; loading validates only the chosen ID. Applying IDs route to the actual RecoveryWorkbench/journal rather than classification. Same-request result lookup uses ImportController.retry, never a new create request.

Five-format selection, encoding/resource/unsupported-protocol diagnostics, source evidence, explicit root, pause/resume/recover/reclassify, selected/title-edited preview and one confirmation are exposed. Source title evidence is not edited. Only needed folder creates appear in the compiled count. Settings/tree events cancel transport and lease; navigation alone does not dispose work. Files/text are not persisted separately from the existing approved checkpoint.

Acceptance remains incomplete: synthetic UI tests currently cover Worker-boundary parsing, diagnostics, four-theme/navigation retention and metadata unknown isolation, not the full production UI classification/authority lifecycle matrix. Browser/native/provider/user-file/P1–P4 NOT RUN. See task10 validation/progress; do not treat a green build as whole10 acceptance.

## UI acceptance repair iteration (2026-09-09; NOT COMPLETE)
Implemented controller-owned rejection/durable reread vs uncertain handoff states, identifiable skipped source evidence, selected destination binding through compiler/authority/journal, frozen controller command display, and import-only missing-title suggestions. Added actual-owner UI handoff/mapping/manual-load/empty/all-existing tests; preserved the shared persistence owner.
Final source checks: lint/typecheck pass; units 434/434 in 49 files (--maxWorkers=2, 61.66s); integration 6/6; build/static MV3 pass. Earlier focused43 and full428 passed. New lifecycle fixture initially had optional native title type errors and late teardown callback rejection, then a generated multiline quote parse failure and duplicate text assertion mismatch; corrected and final full run green. Existing Vite chunk/config warnings remain.
Still incomplete: actual UI all-batches/pause/resume/recover-epoch/root/privacy/cancel/quota/partial acceptance matrix; status/error UX and draft initialization architecture need independent review. Page-memory drafts do not survive an actual browser page reload. This iteration must not be accepted as whole10 completion. Browser/native/provider/user-file/P1–P4/manual NOT RUN. No stage/commit/archive/task11/probes/publish.

## Task11 production export source update
Panel/options expose retained ExportSettings: independent roots/exclusions, manual JSON/HTML/Markdown and dedicated automatic JSON consent, gesture picker/reauthorization, same-origin IDB handles and worker-only auto writes. Refresh shows durable status; invalid roots require reselection. Final source checks:509 unit,6 integration, lint/typecheck/build pass. See `.trellis/tasks/09-08-zhilan-v1-11-export/validation.md`. Synthetic tests are not real handle proof. Chrome153 historical success/prompt-no-write evidence preserved; remaining Chrome restart/reliability and Edge no-page/restart NOT RUN. Independent review/manual acceptance open; no task12/release claim.
