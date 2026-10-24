# AI 书签搜索 / AI bookmark search

[中文使用说明](../guides/user-guide.md) · [English guide](../guides/user-guide.en.md) · [模型协议 / Protocols](../reference/model-protocols.md)

## 设计依据 / Design rationale

用户希望先让 AI 根据问题排列文件夹，再优先检查相关目录中的书签。旧实现每次按原生顺序串行检查全部书签，最多 100 条一批；本地命中不影响检查顺序。目录排序可以提前发现结果，但若仍检查全部书签，总耗时不一定降低。仅凭目录名排除候选还会漏掉未整理或放错位置的书签。

The user requested folder prioritization before bookmark assessment. The previous implementation scanned every bookmark serially in native order, at most 100 per batch, without prioritizing local hits. Folder ordering can improve time to a useful result, but does not necessarily reduce full-scan latency. Folder labels alone cannot safely exclude unfiled or misplaced bookmarks.

| 研究 / Research | 可借鉴内容 / Applicable idea | 边界 / Limits |
| --- | --- | --- |
| [RAPTOR, 2024](https://arxiv.org/abs/2401.18059) | 多层内容摘要帮助定位主题 / Multi-level content summaries help retrieval | 原文使用聚类、向量和摘要；主实验采用跨层检索，不等于只按文件夹名向下查找 / Uses clusters, embeddings and summaries; main results use collapsed-tree retrieval, not folder-name routing |
| [Retrieve & Re-Rank](https://sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html) | 先找候选，再精细判断 / Retrieve candidates before expensive assessment | 当前仍用用户所选聊天模型判断，并非文档中的 Cross-Encoder / The app uses the selected chat model, not the documented cross-encoder |
| [Reciprocal Rank Fusion, 2009](https://research.google/pubs/reciprocal-rank-fusion-outperforms-condorcet-and-individual-rank-learning-methods/) | 结合多种排名，保留跨目录入口 / Combine retrieval rankings and retain cross-folder candidates | 第一版只使用有界本地优先与目录轮转，不声称实现 RRF / Version one uses bounded local priority and folder rotation, not RRF |
| [Query2doc, 2023](https://aclanthology.org/2023.emnlp-main.585/) | 查询扩展可缓解中英文及同义词差异 / Expansion can address vocabulary mismatch | 第一版只在目录规划同一请求内生成短词，不生成伪文档；无质量或速度等价承诺 / Short terms share the planning request; no pseudo-document generation or equivalent quality/speed claim |
| [Sentence-BERT, 2019](https://arxiv.org/abs/1908.10084) | 预计算内容向量，查询时找候选 / Precompute document embeddings for retrieval | 向量索引、模型部署和增量更新属于后续评估 / Embedding indexes, deployment and incremental updates remain future work |

论文结果不能直接外推为中文书签的耗时或准确率；标题缺少的信息也不能通过检索算法凭空补齐。

Paper benchmarks do not establish latency or accuracy for Chinese bookmarks. Retrieval cannot invent information missing from bookmark metadata.

## 当前第一版 / Current first version

1. 本地搜索与明确网站、唯一文件夹规则仍然立即可用。普通查询只在点击 AI 后联网。Local search and exact site/unique-folder shortcuts remain available immediately; AI requires an explicit click.
2. 超过 100 条候选且分布在多个直接父目录时，先发送 `search-plan`。只从隐私允许、符合收藏时间范围的书签计算目录完整路径、数量和最多 3 个标题样本，每个样本最多 100 个 UTF-16 代码单元；不发送 URL 或页面正文。For more than 100 candidates across multiple direct parents, `search-plan` sends full folder paths, scoped counts and up to three title samples, each capped at 100 UTF-16 code units. Samples exclude private/out-of-range bookmarks and contain no URLs or page bodies.
3. 模型返回完整、无重复、已知的目录 ID 排序，以及最多 12 个短检索词。排序不能确认匹配或移除候选。The model returns every offered folder ID exactly once, plus up to 12 short retrieval terms. Planning neither confirms matches nor removes candidates.
4. 最多 20 个跨目录本地命中优先，其余按目录优先级每轮各取 25 条；每次模型判断仍最多 100 条，并按实际请求字节缩小批次。所有候选保持唯一、可继续检查。Up to 20 cross-folder local hits go first; remaining candidates rotate through folders in ranked order, 25 per folder per round. Assessment remains at most 100 bookmarks per request, reduced when necessary to fit the actual envelope. Every candidate remains available exactly once.
5. 普通查询首次得到匹配且还有未查书签时暂停，显示覆盖进度与“继续搜索剩余书签”。继续时只检查剩余候选，并查到本次范围结束。含“所有”“全部”“每一”或英文 `all`/`every` 的查询直接完整检查；这是保守的字面触发，不代表完整自然语言意图解析。Ordinary queries pause after the first accepted batch containing matches when candidates remain. **Search remaining bookmarks** resumes the unexamined suffix to completion. Explicit Chinese all/every markers or English `all`/`every` opt into full coverage. This is a conservative lexical trigger, not comprehensive intent parsing.
6. 无匹配则继续检查。只有完整、未变化且零确认匹配的近 90 天阶段才扩大到 360 天；不重发已检查条目，不因失败或取消而扩展。Zero-match queries continue scanning. Only a complete, unchanged 90-day phase with no confirmed match expands to 360 days; checked items are not resent, and failures/cancellation never trigger widening.
7. 目录排序有最多 5 秒的总预算（不超过配置超时）；超大请求跳过规划。规划网络、超时或输出错误按本地顺序继续，不增加说明段落。权限或上下文失效停止，不绕过校验。Planning has a wall-clock budget of at most five seconds, bounded by the configured timeout. Oversized plans are skipped. Network/timeout/output failures fall back to local order without an extra helper paragraph. Permission or freshness failures stop the search.
8. 每批仍须完整返回匹配、不匹配、不确定三组 ID。保留取消/失败前的有效判断；改变查询、时间、设置或权限清除继续状态。暂停时书签变化需要重新搜索。所有继续状态仅在当前界面内存中，不持久化密钥或结果。Each assessment accounts for every supplied ID as matched, unmatched or uncertain. Cancellation/failure retains accepted current results. Query/filter/settings/permission changes clear continuation; bookmark changes while paused require a fresh search. Continuation is page-memory only, without persistent credentials or result caching.

## 文件夹范围 / Folder scope

搜索页的“搜索文件夹”默认全局，可选择一个原生文件夹及其全部后代，包括只读文件夹。文件夹与收藏时间取交集，约束本地关键词、最近收藏、网站/文件夹快捷查询、AI 目录规划、批次判断、继续搜索及 90→360 天补查。历史搜索保持独立。筛选和操作放在结果标题上方，不再显示优先查找、回退或完成说明段落。

**Search folder** defaults to all folders and accepts any native folder with its descendants, including read-only folders. Its intersection with the saved-date filter applies to local keywords, Recently saved, site/folder shortcuts, AI planning and assessment, continuation and 90→360-day widening. History remains independent. Filters and actions precede the results heading; priority, fallback and completion helper paragraphs are omitted.

`domain/search-scope.ts` 的 `searchScope(tree, folderScope?)` 统一解析成员及必要的祖先 ID。`SearchController.setFolderScope(NodeRef | undefined)` 在变化时取消旧任务；每次运行冻结范围。`search-plan` / `search-batch` 内部请求携带可选 `folderScope`，序列化时再次验证安装身份、文件夹和全部候选 ID，范围外 ID 返回 `outside-scope`。该内部引用不进入供应商 JSON，合法候选仍保留完整祖先路径。选中目录也参与上下文依赖；删除、错误类型或跨安装选择返回 `invalid-search-folder`，界面要求重新选择，不能静默扩大到全局。临时断连保留本地显示缓存，但禁用使用旧数据的操作。

`searchScope(tree, folderScope?)` centralizes subtree membership and necessary ancestor IDs. `SearchController.setFolderScope(NodeRef | undefined)` cancels old work when changed; each run captures its scope. Internal `search-plan` / `search-batch` requests carry optional `folderScope`. Serialization revalidates installation identity, the folder and every offered ID, rejecting out-of-scope IDs with `outside-scope`. The internal reference is not emitted in provider JSON; permitted candidates retain full ancestor paths. The selected folder participates in dependency freshness. Deleted, wrong-kind or foreign selections produce `invalid-search-folder` and require explicit reselection, without widening to all folders. Transient disconnection retains local display caches while disabling actions on stale data.

个人偏好中的书签示例也属于发送范围。带证据的条目只有在全部证据属于当前子树或必要祖先、且通过既有隐私与新鲜度校验时才可注入；无证据的手动通用偏好保留。发送前再次核对，证据移出范围使请求失效，不改动已存偏好。完整原生快照始终供书签操作使用，搜索过滤不构成写权限。

Bookmark examples in personal preferences also belong to the disclosure boundary. Evidence-backed entries are included only when every evidence ID belongs to the subtree or its necessary ancestors and passes existing privacy/freshness checks. Generic manual entries without evidence remain usable. Revalidation before sending detects evidence moved outside the scope without modifying stored preferences. Bookmark actions always use the full native snapshot; search filtering grants no write authority.

覆盖测试：`search-scope.test.ts`、`search-planning.test.ts`、`search-ui.test.ts` 和 `personalization.test.ts`。`tests/fixtures/check-search-folder-scope.py` 使用真实 App 组件、合成目录和模型响应，检查两种界面的中英文 320/380/480px 布局，以及 203 条范围内书签分 100/100/3 批发送。该证据不代表真实模型召回率或浏览器原生侧栏验收。

Coverage lives in `search-scope.test.ts`, `search-planning.test.ts`, `search-ui.test.ts` and `personalization.test.ts`. `check-search-folder-scope.py` uses production App components with synthetic folders and model replies to check both surfaces at 320/380/480px in Chinese/English and 203 scoped bookmarks sent in 100/100/3 batches. This does not establish real-provider recall or native browser side-panel acceptance.

## 后续评估 / Follow-up evaluation

缓存有效 AI 判断、维护目录摘要、实现 RRF 或预建向量索引尚未实现。第一版不增加供应商、依赖、权限或浏览器写入路径。小集合与单目录跳过规划，以免增加没有排序收益的往返。

Persistent judgment caching, maintained folder summaries, RRF and embedding indexes are not implemented. Version one adds no provider, dependency, permission or bookmark mutation path. Small and single-folder catalogs skip planning because an extra round trip would not improve folder ordering.

使用合成书签及人工标注的问题比较旧版与新版：首个正确结果时间、前 10 条准确程度、完整搜索召回率、实际检查覆盖率、模型请求次数、输入/输出 Token。覆盖中英文、放错目录、含糊目录、平铺目录、单个大目录、零命中、要求全部、隐私排除与最近收藏。分别报告首次结果和完整扫描耗时，不以少查书签伪装同等召回下的提速。

Compare old and new versions using synthetic bookmarks and labeled queries: time to the first correct result, top-ten quality, full-search recall, actual coverage, request count and input/output tokens. Include bilingual queries, misplaced bookmarks, vague/flat/large folders, no-match/all-match queries, privacy exclusions and recent saves. Report first-result and full-scan latency separately; reduced coverage is not an equal-recall speed measurement.
