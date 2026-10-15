# 四种接口协议对照（智栏 AI 连接）

更新：2026-10-13。请求由 `model-transport.ts` 构建，地址由 `model-route.ts` 生成，JSON 解析在 `model-replies.ts`，流式读取在 `model-stream.ts`，模型发现在 `model-discovery.ts`。协议回归见 `model-protocols.test.ts`、`model-stream.test.ts`。

## 请求侧

| | OpenAI Chat Completions | OpenAI Responses | Anthropic Messages | Google Generative AI |
|---|---|---|---|---|
| 地址 | `{base}/v1/chat/completions` | `{base}/v1/responses` | `{base}/v1/messages` | `{base}/v1beta/models/{model}:generateContent` |
| 鉴权头 | `Authorization: Bearer` | `Authorization: Bearer` | `x-api-key` + `anthropic-version: 2023-06-01` + `anthropic-dangerous-direct-browser-access: true` | `x-goog-api-key` |
| 模型写在 | body `model` | body `model` | body `model` | URL 路径 |
| 系统提示 | `messages[0].role=system` | `instructions` | 顶层 `system` | `systemInstruction.parts` |
| 用户内容 | `messages[1]` | `input`（字符串） | `messages[0]` | `contents[0].parts` |
| 要求 JSON | `response_format: {type: json_object}` | `text.format: {type: json_object}` | 本应用通过系统提示要求 JSON | `generationConfig.responseMimeType: application/json` |
| 输出额度（均可自定义，默认 128000） | `max_completion_tokens` | `max_output_tokens` | `max_tokens` | `generationConfig.maxOutputTokens` |
| 模型列表 | `GET /v1/models` → `data[].id` | 同左 | `GET /v1/models?limit=1000` → `data[].id`（默认只回 20 条） | `GET /v1beta/models?pageSize=1000` → `models[].name`，只保留 `supportedGenerationMethods` 含 `generateContent` 的 |

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

## 验证结果（2026-10-12）

本地 817 个单元测试、6 个构建/Worker 集成测试以及类型、lint、构建和源码清单检查通过。用户重载 dist 后，按验收要求保持原先失败的 Responses 连接、开启流式响应，确认「合成分类测试和实际收藏都成功」。这是该连接的用户实测反馈；其余三种模式的本次证据为本地协议回归，未新增真实服务验收。服务内部为何曾返回缺少 text 的 JSON 尚无直接证据。

## 官方与开源依据

- [OpenAI Responses 事件文档](https://developers.openai.com/api/reference/resources/responses/streaming-events)；[openai-node 固定源码](https://github.com/openai/openai-node/tree/fe2d6a382623b00753f002de539f8a26c936b5be)，Apache-2.0。
- [Vercel AI Responses 实现](https://github.com/vercel/ai/blob/ba05943b69ad070558bb5bc912da99ec66d7d263/packages/openai/src/responses/openai-responses-language-model.ts)，Apache-2.0，参考错误优先和 delta/结束处理。
- [Anthropic 流式事件](https://platform.claude.com/docs/en/build-with-claude/streaming)；[固定 SDK 源码](https://github.com/anthropics/anthropic-sdk-typescript/tree/2979ed5cef4b2f059b95af23e08728c01e588f86)，MIT。
- [Google GenerateContent 文档](https://ai.google.dev/api/generate-content)；[固定 SDK 源码](https://github.com/googleapis/js-genai/tree/839ffc25de12a47a66db10d236d53d59d97d0530)，Apache-2.0。
- [eventsource-parser 固定源码](https://github.com/rexxars/eventsource-parser/tree/a7885df23221b3d3ce814e18948d37e54a90101c)，MIT。分发包包含其许可声明。

## 共同的宽容处理

- 取到文字后再找 JSON：先整段解析，再剥 ```json 代码块，再取第一个 `{` 到最后一个 `}`；先去掉 `<think>…</think>`。
- 规范化：数字 ID 转字符串；丢弃 `confidence` 等额外说明字段。整理操作中的 `reason` 保留并受 500 字符上限校验，用于展示建议理由；顶层 `reason` 和其他任务的说明字段仍丢弃。`newFolders` / `merges` 缺省补空数组。`url` 这类意外字段仍按严格 schema 拒绝。
- 失败分级（Debug 日志 `parse-failed.stage`，收藏回执原因）：`provider` 服务生成失败 · `envelope` 回复结构不认识 · `empty` 没有回答文字 · `incomplete` 截断或缺少结束事件 · `refused` 拒答或拦截 · `json` 不是 JSON · `validate` JSON 不符合任务要求（附 zod 首个问题路径）。
- HTTP 非 2xx：Debug 日志记录状态码、脱敏错误信息以及有界的响应正文，便于看出“不支持 response_format”之类的问题。

## 收藏失败时收集诊断

重新加载扩展后，在「Debug 日志」开启开关，清空旧记录，收藏一个网页，再点「复制全部」。不需要打开开发者工具。

每次调用有 `callId`，每次尝试有 `attempt`。四种协议都会记录 `request`（实际地址、参数、脱敏请求头）、`request-body`（请求正文）、`response-headers`（HTTP 状态、Content-Type、服务端请求编号）、`response-body`（响应正文）、`reply-extracted`（回答长度与停止原因），以及校验/失败和最终结果。空回复后的重试使用同一调用编号、不同尝试编号。

正文经过有界读取后捕获；JSON、SSE 和读取失败时的已接收文字都会留下诊断，`complete:false` 表示捕获未完整结束。`reply-extracted.events` 为流式事件数。HTTP 200、服务声明 completed 和成功校验分类答案是三个独立阶段。

日志默认关闭；开启后只保存在本机。API 密钥、鉴权字段及响应中回显的配置密钥被替换为 `[redacted]`；书签标题、网址和模型回答可能保留，分享前检查。单份正文最多 65536 字符，超过时 `truncated=true`；最多 400 条记录且总量不超过 1 MiB，旧记录会淘汰。面板正文可展开，「复制全部」包含已保存的正文。

## Organization context and batching
The app does not configure/discover a model-specific context window. The four native protocols use saved maxOutputTokens or the shared default 128000; edit it under AI 服务 → 编辑 → 最大输出 tokens. Draft testing, saving and configuration export/import preserve it. This is the application request budget, not a model capability guarantee. Global request byte guards remain independent of tokens.

Organization now first requests a folder taxonomy from structure/counts/bounded samples, then waits for user confirmation. It classifies bookmarks in sequential batches (default 100, user-editable positive integer), additionally limited to a 48KiB serialized request body. Each request includes only its items and the fixed approved taxonomy, not previous replies or the whole bookmark inventory. Every ID must be moved or explicitly unchanged. Completed batches are viewable immediately; output-limit batches split, failures retain earlier results, and continuation resumes pending items only. All native changes still wait for final confirmation. Keep the workbench open; page reload/close discards the in-memory run.
