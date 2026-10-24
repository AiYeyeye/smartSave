# 架构 / Architecture

智栏是 React + TypeScript 的 Manifest V3 扩展，没有项目自建后端。智栏直接读写浏览器里的书签，模型提供的建议必须先经过校验。以下路径相对 `extension/`。

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
- 首次安装只写本机新手步骤待查看状态；侧栏展示真实操作说明，关闭后记住，升级不重置。配置 AI 保存即完成，不捕获或发送示例网页。First installation marks local sidebar instructions pending; dismissal persists and updates do not reset it. AI setup ends after saving and does not capture or send an example page.
- 语言、明暗和主题色可同步；模型密钥、规则、关键词、日志与恢复证据留在本地。Only allowlisted appearance/language preferences sync; credentials, rules, keywords, logs and recovery data stay local.

参阅 [模型协议](../reference/model-protocols.md)、[导出格式](../reference/export-json-v1.md)、[隐私政策](../privacy.en.md) 和 [测试命令](../../extension/README.md)。

See the linked protocol, export, privacy and development references for executable boundaries.

## 历史查询 / History search

历史通过可选权限按需读取，使用独立标识与访问时间，不伪造书签节点；只保存在页面内存中。删除历史或撤销权限后清理搜索状态。AI 查询复用搜索模型和传输，单独检查历史授权、候选身份与当前范围；历史收藏复用现有确认和写入协调器。

History uses optional on-demand native reads, separate record identities and visit times, and volatile page memory. Deletion/revocation invalidates search state. AI reuses the search route and transport with independent history consent/evidence checks. Bookmarking a history result uses the existing confirmation and mutation coordinator.

### Name advice and correction learning / 命名与纠正学习

`save-name-suggestion.ts` fills read-only name advice after local classification; AI classification can include the same optional field. `SaveCorrectionOwner` confirms combined title/folder edits in the toolbar confirmation popup through the mutation coordinator and binds unsettled requests to receipts. `RenameWorkbench` compiles selected, edited proposals through the existing organizer lease and journal. Explicit edit entrypoints attach `learning` baselines; untouched AI adoption does not. `CorrectionLearning` owns a durable action queue, consumes completed journal evidence and organizer-review approvals and feedback, and uses the existing organize-model transport plus local personalization store. Failures cannot change the native mutation result.

收藏名称建议与目录在工具栏确认浮层中统一确认，批量改名使用现有写入协调器。学习基于实际修改与展示建议的差异，队列在后台运行，自动采纳不产生学习事件。


`native-preference-learning.ts` also observes browser manager moves/renames, suppressing imports and exact events registered by `OwnWriteGuard`. Events cannot distinguish sync or other extensions. `preference-update.ts` validates whole-profile updates, reserves disabled/pending/private content, and applies cited scoped results. The persistence boundary enforces 3000 Unicode characters / 10 entries; model output and CAS revision checks precede replacement. Oversized legacy input retains a local migration copy. Failed learning input remains local without automatic replay.

原生管理器的移动与改名通过事件接入，排除导入及智栏自身写入。偏好整体更新经输入证据、输出引用和版本检查，总正文最多 3000 字、10 条；旧版超量数据保留本地迁移副本，失败输入不自动重发。

## 目录优先搜索 / Folder-priority search

书签 AI 搜索在较大多目录集合上先规划目录顺序，再合并跨目录本地候选，分批校验匹配、不匹配和不确定结果。普通查询首批有匹配时暂停，当前页面可继续剩余候选；明确要求全部则连续检查。规划与判断共用搜索模型、隐私投影、新鲜度与取消边界；继续状态只在页面内存保存。完整设计、研究依据及验证指标见 [AI 搜索](ai-search.md)。

For larger multi-folder collections, bookmark AI search plans folder order, combines cross-folder local candidates and validates batch decisions. Ordinary queries pause after initial matches and can resume the remaining candidates in the same page; all-match queries run continuously. Planning and assessment share the search route, privacy projection, freshness and cancellation boundaries. Continuation stays in page memory. See [AI search](ai-search.md) for design, research and evaluation criteria.


## 收藏确认浮层 / Bookmark confirmation popup

`save/index.html` 是扩展工具栏弹出面板（`chrome.action.openPopup`，Chrome 127+），锚定在扩展图标处，不创建浏览器窗口、标签页或任务栏项；侧栏只保留短待办入口。清单不设默认弹出页：`SaveDialogHost` 只在呈现时对目标窗口活动标签 `action.setPopup`，浮层通过存在端口连接，断开后恢复为空，图标点击仍打开侧栏；新 worker 启动时清理旧 worker 遗留的设置。`openPopup` 要求目标窗口处于激活状态并显示工具栏：自动呈现失败时按退避重试约一分钟，并在该窗口重新获得焦点或切换标签时再试，绝不调用 `windows.update` 抢焦点；仍失败则保留该标签的弹出页并显示图标提示。待确认队列由 worker 独占写入 `chrome.storage.session`，浮层只写自己的逐条草稿；同时最多自动呈现一个浮层，后续收藏只入队。原生新增事件先记录当时最后聚焦的普通窗口；归类及名称建议结束、回执与书签身份仍有效时自动呈现。导入、自身写入与一秒内 4 条以上的突发新增（同步、批量）不自动呈现；浏览器不区分用户新增与同步新增。旧回执、worker 恢复和回执更新不触发自动呈现。显式收藏在打开前冻结来源标签，并按浮层所在窗口（扩展上下文的 `windowId`）分队；worker 重启不恢复收藏授权。

`save/index.html` is the extension's toolbar popup (`chrome.action.openPopup`, Chrome 127+), anchored at the extension icon; it never creates a browser window, tab or taskbar entry. The sidebar retains only a compact review launcher. The manifest declares no default popup: `SaveDialogHost` calls `action.setPopup` on the target window's active tab only while presenting, the popup holds a presence port, and disconnecting resets it so a toolbar click still opens the sidebar; a fresh worker clears arms left by an earlier worker. `openPopup` needs an active window with a toolbar: automatic presentation retries with backoff for about a minute and again when that window regains focus or changes tab, never calling `windows.update` to take focus; after that the tab keeps the popup armed and the icon shows a hint. The worker is the only writer of the review queue in `chrome.storage.session`; the popup writes only its per-receipt drafts. At most one popup is presented automatically; later saves only join the queue. Native creation captures the last-focused normal window before asynchronous work; after classification and name advice settle, a current receipt with a matching live bookmark is presented. Import, own writes and bursts of four or more creations within a second (sync, bulk writes) are not presented; browser events cannot distinguish user additions from sync additions. Old receipts, worker recovery and receipt updates never trigger presentation. Explicit capture freezes the source tab before opening and queues per popup window (the extension context `windowId`); worker restart never restores capture authority.

名称与目录统一确认复用纠正 owner、写入协调器和日志；两项修改使用一个请求中的显式步骤。原生 API 不是事务，部分完成或未知结果保留证据、提示恢复，不自动重放。无变化的确认只标记已复核；关闭不修改书签或学习偏好。窗口页面不是网页可访问资源，不新增站点权限。参照 [Chrome windows API](https://developer.chrome.com/docs/extensions/reference/api/windows)。

Combined name/folder review uses the existing correction owner, mutation coordinator and journal, with explicit steps under one request. Native APIs are not transactional: partial/unknown results retain evidence and require recovery without replay. No-op review only marks completion; closing neither mutates bookmarks nor learns preferences. The page is not web-accessible and adds no host permission. See the linked Chrome windows API.

## 目录浏览位置 / Directory reading position

目录通过 `panel/use-navigation-memory.ts` 保存真正滚动容器 `main` 中的顶部可见书签 ID、相对偏移及有限回退 ID；按 installationId 隔离，仅本地存储。等展开状态和当前树就绪后恢复一次，用户先交互会取消迟到恢复。滚动节流保存，打开书签及切换界面前立即快照；隐藏目录不覆盖为零。恢复偏好不含标题、URL、搜索词、选择或写入授权，不跟随其他窗口的存储事件跳转。

The directory stores its visible native ID, relative offset and bounded fallback IDs for the actual `main` scroller, locally per installation. Restoration waits for expansion and current-tree readiness; earlier user interaction cancels late restoration. Scroll saves are throttled and navigation snapshots immediately; hiding the directory never saves a zero position. Preferences contain no titles, URLs, queries, selection or mutation authority, and storage changes from other windows never scroll this one.

浮层固定约 352px 宽，高度由浏览器按内容调整（上限 600px）；目录树在浮层内原地展开，自身限高滚动。目录树只修改本地草稿，保留原生目录顺序、展开选中目录的全部上级并支持键盘导航；名称、所选目录、展开状态逐次写入会话草稿，浮层失焦关闭后重新打开可恢复，未编辑的字段跟随较新的结果，已编辑的字段不被覆盖。可选性依据 `childrenWritable`，而非目录本身是否可改名。确认时名称与目录合并为一次请求，仍由后台检查当前写入权限。

The popup is about 352px wide and the browser sizes its height to the content (600px at most); the folder tree expands inline with its own scroll limit. The tree preserves native order, expands every ancestor of the selection and supports keyboard navigation. Name, selected folder and expansion are written to a session draft on every change, so a popup closed by blur reopens unchanged; untouched fields follow newer results while edited fields are never replaced. Eligibility uses `childrenWritable`, including protected native roots that accept bookmarks. Confirmation submits name and folder as one request, and the worker revalidates current authority.
