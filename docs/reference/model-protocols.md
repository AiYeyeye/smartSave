# 四种接口协议对照（智栏 AI 连接）

## 厂商差异 / Provider-specific contracts

协议兼容不代表所有参数通用。`domain/model-provider.ts` 只按明确的官方主机识别能力，不根据模型名或相似域名推断，不重写用户地址。Compatibility does not imply identical parameters. Official hosts select reviewed capabilities; custom gateways keep their existing behavior and saved URLs are not rewritten.

| 厂商 / Provider | 显式 Chat 输出字段 / explicit output field | API JSON 开关 / switch | stream_options |
| --- | --- | --- | --- |
| MiniMax | M3/M3.1: `max_completion_tokens`; M2.x: `max_tokens` | 省略 / omitted | 开启流时发送 / streaming only |
| 智谱 / Z.ai | `max_tokens` | `json_object` | 省略 / omitted |
| DeepSeek | `max_tokens` | `json_object` | streaming only |
| Qwen / DashScope | `max_tokens` | 模型/思考模式不同，默认省略 / omitted because support varies | streaming only |
| Moonshot / Kimi | K3: `max_completion_tokens`; older: `max_tokens` | `json_object` | streaming only |
| SiliconFlow | `max_tokens` | `json_object` | 省略 / omitted |
| 火山 / Ark | `max_tokens` | 模型相关，默认省略 / omitted | streaming only |
| OpenRouter | `max_tokens` | 下游模型相关，默认省略 / omitted | 不需要 / unnecessary |
| Groq | `max_completion_tokens` | `json_object` | streaming only |
| Mistral | `max_tokens` | `json_object` | 省略 / omitted |
| Gemini OpenAI / xAI | `max_tokens` | `json_object` | streaming only |
| OpenAI / custom gateways | `max_completion_tokens` | `json_object` | streaming only |

以上仅描述本应用默认编码；省略不等于服务必定不支持。API JSON 开关省略时仍发送 schema 提示并严格校验回答。No sampling parameters are forced. Omitted fields are not necessarily rejected by the provider; JSON schema prompts and local validation always remain.

未填输出上限时，Chat/Responses/Gemini 不发送输出限制；Messages 必须发送，已知 Claude 5.5/Fable5.1 为128000、Sonnet4/Haiku4.5为64000、Opus4为32000，未知模型4096。用户显式值不裁剪、不迁移。Optional output limits are omitted; Messages uses a compatible required budget. Explicit overrides remain unchanged and can be cleared in either editor.


MiniMax M3.1-Flash-Preview 在 Chat 使用 `reasoning_effort`，Responses 使用 `reasoning.effort`；默认低档，用户选 `none` 映射为最低支持档 `low`，选模型默认则不发参数。它不支持关闭思考。没有发送 API JSON 开关时，空回答不再触发“去掉 JSON 开关”的无意义重试。严格 schema、ID、完成状态及写入确认校验保持生效。

MiniMax M3.1 uses `reasoning_effort` for Chat and `reasoning.effort` for Responses. The app defaults to low effort; none maps to low because thinking is mandatory. Choosing the model default omits the field. An empty answer does not replay an identical request when no API JSON switch was sent. Schema, identity, completion and write-confirmation checks remain mandatory.

智谱 / Z.ai 不发送未文档化的 `stream_options`，按官方流式示例读取最后一个 choice chunk 上的 `usage`。GLM requests omit undocumented stream options; token accounting still accepts usage on the final choice chunk. References: [智谱](https://docs.bigmodel.cn/cn/guide/capabilities/streaming), [Z.ai](https://docs.z.ai/guides/capabilities/streaming).

MiniMax HTTP 400/422 的 1026 / `input new_sensitive` 归类为 `refused`，不重试。其他 400/422 保留状态码，供界面提示检查请求配置；诊断保留脱敏错误。输出额度按上述自动/显式规则处理。协议及地区的地址差异见[配置指南](../guides/model-setup.md)（[English](../guides/model-setup.en.md)）。

MiniMax 1026 is a content refusal, not a connection failure, and is never retried. Other HTTP 400/422 errors retain their status codes. Unset output budgets use the automatic rules above; explicit saved values remain unchanged. Draft connection tests and real tasks use the same request builder. Regression: `extension/tests/model-provider-compatibility.test.ts`.

官方依据 / Official references: [MiniMax Chat schema](https://platform.minimax.cn/docs/api-reference/text/api/openapi-chat-openai.json), [Responses schema](https://platform.minimax.io/docs/api-reference/text/api/openapi-responses.json), [thinking](https://platform.minimax.cn/docs/api-reference/text-openai-api), [errors](https://platform.minimax.cn/docs/api-reference/errorcode), [Zhipu Chat](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction/), [Z.ai parameters](https://docs.z.ai/api-reference/llm/chat-completion), [DeepSeek parameters](https://api-docs.deepseek.com/api/create-chat-completion/), [Mistral parameters](https://docs.mistral.ai/api).

### 其他官方依据 / Further official sources

[Qwen parameters](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions/) · [Qwen JSON/thinking support](https://help.aliyun.com/zh/model-studio/qwen-structured-output) · [Kimi](https://platform.kimi.com/docs/api/chat) · [SiliconFlow](https://docs.siliconflow.cn/docs/api/chat-completions-post) · [Ark](https://docs.volcengine.com/docs/ark/chat-api?lang=en) · [OpenRouter](https://openrouter.ai/docs/api_reference/parameters) · [Groq](https://console.groq.com/docs/api-reference) · [Gemini compatibility](https://ai.google.dev/gemini-api/docs/openai) · [xAI](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions) · [Claude limits](https://platform.claude.com/docs/en/models/overview).

备用模型更新依据 / Fallback lifecycle sources: [DeepSeek retirement](https://api-docs.deepseek.com/news/news260424/) · [Gemini deprecations](https://ai.google.dev/gemini-api/docs/deprecations) · [Groq deprecations](https://console.groq.com/docs/deprecations) · [Ark retirements](https://docs.volcengine.com/docs/ark/model-deprecation-announcement-2025?lang=en) · [xAI migration](https://docs.x.ai/developers/migration/may-15-retirement). Both settings screens derive their catalogs and base URLs from `KEY_VENDORS`; saved endpoints and model choices are not silently migrated.

## 通用协议 / General protocols

连接可按服务配置调整已识别官方模型的思考参数；旧 `fastMode` 配置保留兼容。不支持的明确参数可去掉后重发一次。429/5xx最多按2/4/8秒重试三次，网络断流仍手动继续。未填写输出上限时使用上面的自动规则，自定义值保留。整理书签批次采用两个独立请求并发、按顺序合并，遇429降低后续并发；明确启用的新协议只需返回移动项。真实评测入口见[模型评测](../development/model-evaluation.md)。

请求由 `model-transport.ts` 构建，地址由 `model-route.ts` 生成，JSON 解析在 `model-replies.ts`，流式读取在 `model-stream.ts`，模型发现在 `model-discovery.ts`。协议回归见 `model-protocols.test.ts`、`model-stream.test.ts`。

## 请求侧

| | OpenAI Chat Completions | OpenAI Responses | Anthropic Messages | Google Generative AI |
|---|---|---|---|---|
| 地址 | `{base}/v1/chat/completions` | `{base}/v1/responses` | `{base}/v1/messages` | `{base}/v1beta/models/{model}:generateContent` |
| 鉴权头 | `Authorization: Bearer` | `Authorization: Bearer` | `x-api-key` + `anthropic-version: 2023-06-01` + `anthropic-dangerous-direct-browser-access: true` | `x-goog-api-key` |
| 模型写在 | body `model` | body `model` | body `model` | URL 路径 |
| 系统提示 | `messages[0].role=system` | `instructions` | 顶层 `system` | `systemInstruction.parts` |
| 用户内容 | `messages[1]` | `input[1]`（`role: user`） | `messages[0]` | `contents[0].parts` |
| 要求 JSON | `response_format: {type: json_object}` | `text.format: {type: json_object}` | 本应用通过系统提示要求 JSON | `generationConfig.responseMimeType: application/json` |
| 输出额度（可选；Messages 必填） | `max_completion_tokens` | `max_output_tokens` | `max_tokens` | `generationConfig.maxOutputTokens` |
| 模型列表 | `GET /v1/models` → `data[].id` | 同左 | `GET /v1/models?limit=1000` → `data[].id`（默认只回 20 条） | `GET /v1beta/models?pageSize=1000` → `models[].name`，只保留 `supportedGenerationMethods` 含 `generateContent` 的 |

表格中的 `{base}` 表示规范化后的服务地址；地址生成器会识别已有版本路径，不会把 `/v1` 再拼接一次。具体以 `extension/domain/model-route.ts` 为准。

Responses 保留顶层 `instructions`，并在 `input[0]` 的 `developer` 消息中明确要求输出 JSON；`input[1]` 的 `user` 消息单独承载不可信的书签数据。这兼容只检查输入消息中是否包含 JSON 指令的服务。明确报告此要求缺失的 HTTP 400/422、JSON 或 SSE 错误映射为 `json-mode-input-required`，界面显示中英文解释，不自动重试或接受失败响应中的建议。HTTP 200 也可能承载 `response.failed`。

Responses retains top-level `instructions` and includes an explicit JSON output instruction in the `input[0]` developer message. The `input[1]` user message carries untrusted bookmark data separately. This supports providers that check only input messages for JSON instructions. Explicit missing-JSON-instruction errors in HTTP 400/422, JSON or SSE map to `json-mode-input-required`, with localized guidance and no automatic retry or acceptance of failed output. HTTP 200 can still carry `response.failed`. See [OpenAI JSON mode guidance](https://developers.openai.com/api/docs/guides/structured-outputs#json-mode).

## 回复侧

| | 回答文字在哪 | 被截断 | 拒答 / 拦截 | 要跳过的内容 |
|---|---|---|---|---|
| Chat Completions | `choices[0].message.content`（字符串；部分代理给 `[{type:'text',text}]`） | `finish_reason: "length"` | `message.refusal`，或 `finish_reason: "content_filter"` | `reasoning_content`（部分代理的思考过程） |
| Responses | `output[]` 中 `type:"message"` 项的 `content[type:"output_text"].text`；`output_text` 只是 SDK 便捷字段，原始 HTTP 和多数代理都没有 | `status: "incomplete"` + `incomplete_details.reason` | `content[type:"refusal"].refusal` | `type:"reasoning"` 项 |
| Anthropic | `content[type:"text"].text` | `stop_reason: "max_tokens"` | `stop_reason: "refusal"` | `type:"thinking"` 块 |
| Google | `candidates[0].content.parts[].text` | `finishReason: "MAX_TOKENS"` | `promptFeedback.blockReason`（即使有候选）；`finishReason` 为 SAFETY / RECITATION / BLOCKLIST / PROHIBITED_CONTENT / SPII 等 | `thought: true` 的 part |

## 原生流式与 JSON

四种模式默认使用原生流式接口，编辑服务可关闭「流式响应」以使用 JSON。旧 Ollama 和 LM Studio 默认方式保留。`streaming` 是可选配置，不在存储 schema 中自动补默认值，避免改变旧设置身份与导入证据。两个设置存储、后台收藏、连接测试和配置导入导出都保留显式 `false`。

Chat、Responses、Anthropic 请求加 `stream:true`；Google 使用 `:streamGenerateContent?alt=sse`，请求正文和 `x-goog-api-key` 头不变。实际解析根据响应 Content-Type 选择，因此服务在流式请求后返回 JSON 也可处理。

| 协议 | 文字累计 | 成功结束要求 |
|---|---|---|
| Chat | choice 0 的 `delta.content`；usage 帧不覆盖文字 | `finish_reason:stop` 和 `[DONE]` |
| Responses | 按 output/content index 累计 `response.output_text.delta`；done 和最终消息是替换快照 | `response.completed` 且状态不矛盾 |
| Anthropic | 按 block index 累计 `text_delta`；相同 delta 也必须追加 | `message_stop` 加 `end_turn` 或 `stop_sequence` |
| Google | candidate 0 的非 thought 文字逐块累计 | `STOP` 加完整 EOF |

SSE 使用固定版本 `eventsource-parser@4.1.1`，处理跨块 UTF-8、BOM、CR/LF/CRLF、多行 data 与注释。原始响应、帧缓存和最终文字有界；不自动重连。未终止的最后一帧也会报未完成。Google 的 STOP + EOF 是本应用在写书签前的完整性要求。

Responses 最终快照缺少文字或文字为空时，保留此前已收到的文字增量，这是代理兼容规则；没有任何增量时仍报 `empty`。完整快照不会和 delta 重复拼接。规范的消息片段优先，顶层 SDK 便捷字段 `output_text` 只作为兜底。

服务端 error、失败/未完成状态、拒答、额度截断都优先于正文；已有合法分类 JSON 不能掩盖后来的错误。请求连接和非流式 JSON 有总时间限制；收到真正的 SSE 响应头后，按连续无完整事件或注释心跳的时间计时，思考和元数据事件也会续期，持续有活动的流没有总时限。流结束后的校验仍有时限。取消、设置变更和过期检查贯穿全程。

整理每次使用至少 180 秒的连接/无活动等待上限，保留更长的服务配置；不再根据书签数量设置总时限。搜索和测试连接将准备耗时扣除后交由同一个传输层计时。仅 OpenAI 两种模式的真实空回复最多重试一次（去掉 API JSON 开关），沿用当前期限和取消状态，不会改协议或服务。错误、拒答、断流和取消不触发该重试。整理遇到网络错误保留已完成批次，等待用户继续，不自动重试或缩小批次；确定的输出/大小超限仍可拆分未完成批次。

## 草稿连接测试

「测试连接」使用当前编辑的协议、地址、密钥、所选测试模型和传输方式，发送一条合成书签及两个合成目录，校验真正的分类答案。测试不保存草稿，不读取真实书签，也不调用书签写入接口。编辑、关闭或取消会使旧请求结果失效。获取模型列表仅验证发现接口，不能代替生成测试。

## 验证范围

协议回归测试覆盖 JSON/SSE 解析、终止事件、错误优先级和取消路径。运行方式见 [开发命令](../../extension/README.md)。

Protocol tests cover JSON/SSE parsing, terminal events, error precedence and cancellation. See [development commands](../../extension/README.md).

## 官方与开源依据

- [OpenAI Responses 事件文档](https://developers.openai.com/api/reference/resources/responses/streaming-events)；[openai-node 固定源码](https://github.com/openai/openai-node/tree/fe2d6a382623b00753f002de539f8a26c936b5be)，Apache-2.0。
- [Vercel AI Responses 实现](https://github.com/vercel/ai/blob/ba05943b69ad070558bb5bc912da99ec66d7d263/packages/openai/src/responses/openai-responses-language-model.ts)，Apache-2.0，参考错误优先和 delta/结束处理。
- [Anthropic 流式事件](https://platform.claude.com/docs/en/build-with-claude/streaming)；[固定 SDK 源码](https://github.com/anthropics/anthropic-sdk-typescript/tree/2979ed5cef4b2f059b95af23e08728c01e588f86)，MIT。
- [Google GenerateContent 文档](https://ai.google.dev/api/generate-content)；[固定 SDK 源码](https://github.com/googleapis/js-genai/tree/839ffc25de12a47a66db10d236d53d59d97d0530)，Apache-2.0。
- [eventsource-parser 固定源码](https://github.com/rexxars/eventsource-parser/tree/a7885df23221b3d3ce814e18948d37e54a90101c)，MIT。分发包包含其许可声明。

## 共同的宽容处理

- 取到文字后再找 JSON：先整段解析，再剥 ```json 代码块，再取第一个 `{` 到最后一个 `}`；先去掉 `<think>…</think>`。
- 规范化：数字 ID 转字符串；丢弃 `confidence` 等额外说明字段。整理操作中的 `reason` 保留并受 3000 字符上限校验，用于展示建议理由；顶层 `reason` 和其他任务的说明字段仍丢弃。`newFolders` / `merges` 缺省补空数组。`url` 这类意外字段仍按严格 schema 拒绝。
- 整理兼容一种明确的格式误用：根对象恰好为 `$schema`（2020-12 标准地址）、`type:"object"`、`properties`，且 `properties` 中的 `moves/newFolders/merges` 已经是实际数组时，按内部方案继续严格校验。真正的 schema 定义、空包装、混合字段及无效操作不会被转成空方案。
- 失败分级（Debug 日志 `parse-failed.stage`，收藏回执原因）：`provider` 服务生成失败 · `envelope` 回复结构不认识 · `empty` 没有回答文字 · `incomplete` 截断或缺少结束事件 · `refused` 拒答或拦截 · `json` 不是 JSON · `validate` JSON 不符合任务要求（附 zod 首个问题路径）。
- HTTP 非 2xx：Debug 日志记录状态码、脱敏错误信息以及有界的响应正文，便于看出“不支持 response_format”之类的问题。

整理请求明确给出 `rootId` 和输入目录中只读的 `protectedSourceIds`，说明这些目录可作为已提供的目标，但不可移动、作为合并源、改名或删除。初始方案的格式/内容校验失败与方案编译冲突共用最多一次纠正机会；纠正只生成建议，仍须用户核对并确认执行。服务失败、拒答、不完整响应、网络中断和取消不会触发这次纠正。

For organization only, an exact `$schema` (2020-12), `type:"object"`, `properties` envelope can be unwrapped when its properties already contain actual `moves/newFolders/merges` arrays. Real schema definitions, empty wrappers, mixed fields and invalid actions remain rejected. All ID, conflict, privacy and mutation checks still apply. Requests identify `rootId` and offered read-only `protectedSourceIds`; these folders may receive children when offered, but cannot be moved, merged as sources, renamed or removed. Initial proposal schema failures and compiler conflicts share at most one correction round. Provider failures, refusals, incomplete responses, network interruptions and cancellation do not trigger that correction. Review and explicit confirmation remain required before bookmark writes.

## 收藏失败时收集诊断

重新加载扩展后，在「Debug 日志」开启开关，清空旧记录，收藏一个网页，再点「复制全部」。不需要打开开发者工具。

每次调用有 `callId`，每次尝试有 `attempt`。历史查询、排序和历史收藏分类不记录请求/响应正文。其他调用按协议记录 `request`（实际地址、参数、脱敏请求头）、`request-body`（请求正文）、`response-headers`（HTTP 状态、Content-Type、服务端请求编号）、`response-body`（响应正文）、`reply-extracted`（回答长度与停止原因），以及校验/失败和最终结果。空回复后的重试使用同一调用编号、不同尝试编号。

正文经过有界读取后捕获；JSON、SSE 和读取失败时的已接收文字都会留下诊断，`complete:false` 表示捕获未完整结束。`reply-extracted.events` 为流式事件数。HTTP 200、服务声明 completed 和成功校验分类答案是三个独立阶段。

日志默认关闭；开启后只保存在本机。API 密钥、鉴权字段及响应中回显的配置密钥被替换为 `[redacted]`；书签标题、网址和模型回答可能保留，分享前检查。单份正文最多 65536 字符，超过时 `truncated=true`；最多 400 条记录且总量不超过 1 MiB，旧记录会淘汰。面板正文可展开，「复制全部」包含已保存的正文。

## Organization context and batching
The app does not configure/discover a model-specific context window. The four native protocols preserve saved maxOutputTokens; otherwise optional limits are omitted and Messages uses a compatible required value; edit it under AI 服务 → 编辑 → 最大输出 tokens. Draft testing, saving and configuration export/import preserve it. This is the application request budget, not a model capability guarantee. Global request byte guards remain independent of tokens.

Organization first requests a folder taxonomy from structure/counts/bounded samples and waits for confirmation. Bookmark analysis uses two concurrent requests by default, merges results in order and may reduce concurrency after rate limiting. The default batch count is 100; 48KiB is a preferred partition target, while the independent hard request guard is 1MiB. An oversized indivisible item must pass the hard guard rather than being truncated. The sparse-output protocol can return moves only; the validator still checks offered IDs, conflicts and coverage according to the selected protocol.

Worker-owned generation persists accepted checkpoints. Reopening the workspace reconnects to progress or saved review. Interrupted requests require explicit continuation; uncertain native writes are never replayed. Closing the page does not itself discard accepted generation results, but worker/browser restart does not guarantee an in-flight network request survives. Applying the final proposal always requires current authority, a fresh preview and explicit confirmation.

## 分批书签搜索 / Progressive bookmark search

目录优先规划使用 `search-plan`：从本次允许且符合时间范围的书签派生目录完整路径、数量和最多 3 个截短标题样本，不发送 URL 或正文。返回 `{folderIds,terms}`，目录 ID 必须完整、唯一且来自输入，最多 12 个检索词，每词最多 64 字符。规划最多等待 5 秒；请求过大跳过，网络/超时/无效输出回退到本地顺序，权限或上下文失效停止。规划只调整顺序，不确认匹配或排除书签。普通查询首批有匹配后可暂停并继续；明确要求全部则不暂停。两种请求均记录为 `search` 用途。设计与参考论文见 [AI 搜索](../development/ai-search.md)。

Folder prioritization uses `search-plan`: full folder paths, scoped counts and up to three shortened title samples derived only from permitted, time-scoped bookmarks, without URLs or page bodies. Output `{folderIds,terms}` must cover offered folder IDs exactly once; terms are limited to 12 entries of 64 characters. Planning has a five-second wall-clock ceiling; oversized plans are skipped and network/timeout/output failures fall back to local order. Permission/freshness failures stop. Planning only changes inspection order, never match decisions or candidate membership. Ordinary queries may pause after initial matches with explicit continuation; all-match queries scan continuously. Both request types count as `search`. See [AI search](../development/ai-search.md) for design and research.

书签界面使用 `search-batch`：每批最多100条，发送原始查询及允许的 ID、标题、URL 和目录路径。提示词要求逐条判断，完整保留正向、排除条件及语义关系；没有提供正文时不得推测。返回 `matchedIds`、`unmatchedIds`、`uncertainIds` 三个必填数组，每个输入 ID 必须恰好出现一次，未知、重复、遗漏均拒绝该批。每批通过校验后立即显示结果，取消或失败保留已完成部分并标记尚未完成；不做最终结果截断。Token 用途继续记为 `search`。旧 `search`/`search-expand` 留作兼容，历史查询限制保持独立。

The bookmark UI uses `search-batch`: at most100 permitted ID/title/URL/path records plus the original query per request. Its prompt requires exhaustive positive/negative intent assessment from supplied metadata, with no invented page-body knowledge. The mandatory `matchedIds`, `unmatchedIds` and `uncertainIds` arrays must partition every input ID exactly once; foreign, duplicate and omitted IDs reject the batch. Accepted batches publish immediately; cancellation or failure retains completed results and marks coverage incomplete. There is no final result cap. Usage remains under `search`; legacy search/expansion and independent history limits stay compatible.

## Bookmark name advice and correction learning / 书签命名与纠正学习

Native save assignments accept optional `suggestedTitle` (trimmed, 1–200 characters). It is displayed for explicit adoption in the sidebar receipt, never executed by the classifier. Local classification can be followed by a separate `rename` request through the save model. Batch renaming uses the organize model and `suggestions: [{itemId,title,decision,reason}]`, with exact input-ID coverage and no duplicates. `keep`/`uncertain` must preserve the original title exactly (including empty or long titles); `rename` must be nonempty and at most 200 characters. Metadata is privacy-filtered; these flows do not crawl websites. Confirmed updates use the existing mutation coordinator, current-identity validation and recovery journal.

原生收藏建议名与分类建议一起返回，侧边栏确认后才改名；本地分类规则命中时可以单独请求命名建议。批量改名逐批生成，检查 ID 完整覆盖、原名及建议名边界，预览确认后仅执行标题更新。

Explicit edits carry mutation `learning` baselines; unchanged AI-name adoption remains excluded. Organizer destination approvals and feedback enqueue intent even when approving an existing suggestion. Native bookmark-manager moves/renames use event observation; exact own-write events, imports and reorder-only events are suppressed. Browser events cannot distinguish user, sync and other-extension origins. Worker-owned `preference-summary` calls use the organize model. An update combines up to 20 new examples with the entire usable profile, validates all latest citations, and limits the stored body to 3000 Unicode characters / 10 entries, including separators. Disabled, pending or private entries reserve space without being sent. Local evidence and revision are validated before dispatch and before replacement; evidence is never serialized. Raw actions remain in the learning queue until successful interpretation. Automatic summaries describe evidence-backed classification criteria or naming patterns, not operation logs. Explicit feedback takes priority; a single choice supports only a narrow interpretation and cannot establish private motives or a whole-site rule. Failed input remains in the local queue without replay; prior preferences and successful bookmark writes remain intact.

明确修改、整理页归类确认及反馈都会记录；原生管理器修改也接入，但浏览器不能区分用户、同步和其他扩展的来源。原始操作留在学习队列，成功总结有依据的分类理由或命名习惯后才写入偏好；不重复操作日志，不编造动机。更新合并整个有效偏好与最多 20 条新输入，总正文始终不超过 3000 字、10 条。停用、待确认或隐私排除内容不发送。超限或失效结果不替换原内容，失败不会回滚书签。

实际人工改名、改分类、整理归类确认及纠正反馈触发后台独立学习；直接采用 AI 名称不会调用。后台队列按动作去重，使用修改前/AI 建议/实际采用内容识别偏好；学习失败与书签保存分离。关闭个性化、删除记录或证据失效会阻止后续保存，已发送的信息无法撤回。

Save-time and batch naming share the same quality guidance: distinguish homepages, documentation, tutorials, articles and version pages; preserve identifying subjects, proper names and versions; remove redundant boilerplate; retain clear names. Folder categories alone never establish a product purpose. No additional webpage fetching or payload fields are introduced.

收藏与批量改名使用同一命名标准：区分首页、文档、教程、文章及版本页，保留主体、专名和版本，去除重复尾缀，清楚的名称保持不变；不能只凭目录名推断产品用途。不新增网页抓取或请求字段。
