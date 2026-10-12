# 四种接口协议对照（智栏 AI 连接）

更新：2026-10-12。代码位置：请求 `extension/adapters/model-transport.ts`（`modelRequestBody`、`requestHeaders`），地址 `extension/domain/model-route.ts`，回复解析 `extension/adapters/model-replies.ts`，模型列表 `extension/adapters/model-discovery.ts`。测试：`extension/tests/model-protocols.test.ts`。

## 请求侧

| | OpenAI Chat Completions | OpenAI Responses | Anthropic Messages | Google Generative AI |
|---|---|---|---|---|
| 地址 | `{base}/v1/chat/completions` | `{base}/v1/responses` | `{base}/v1/messages` | `{base}/v1beta/models/{model}:generateContent` |
| 鉴权头 | `Authorization: Bearer` | `Authorization: Bearer` | `x-api-key` + `anthropic-version: 2023-06-01` + `anthropic-dangerous-direct-browser-access: true` | `x-goog-api-key` |
| 模型写在 | body `model` | body `model` | body `model` | URL 路径 |
| 系统提示 | `messages[0].role=system` | `instructions` | 顶层 `system` | `systemInstruction.parts` |
| 用户内容 | `messages[1]` | `input`（字符串） | `messages[0]` | `contents[0].parts` |
| 要求 JSON | `response_format: {type: json_object}` | `text.format: {type: json_object}` | 无原生开关，靠系统提示 + 宽容解析 | `generationConfig.responseMimeType: application/json` |
| 输出额度 | 不传（`max_tokens` 与推理模型的 `max_completion_tokens` 不通用） | `max_output_tokens: 16000` | `max_tokens: 8192`（必填） | 不传（默认即模型上限） |
| 模型列表 | `GET /v1/models` → `data[].id` | 同左 | `GET /v1/models?limit=1000` → `data[].id`（默认只回 20 条） | `GET /v1beta/models?pageSize=1000` → `models[].name`，只保留 `supportedGenerationMethods` 含 `generateContent` 的 |

## 回复侧

| | 回答文字在哪 | 被截断 | 拒答 / 拦截 | 要跳过的内容 |
|---|---|---|---|---|
| Chat Completions | `choices[0].message.content`（字符串；部分代理给 `[{type:'text',text}]`） | `finish_reason: "length"` | `message.refusal`，或 `finish_reason: "content_filter"` | `reasoning_content`（部分代理的思考过程） |
| Responses | `output[]` 中 `type:"message"` 项的 `content[type:"output_text"].text`；`output_text` 只是 SDK 便捷字段，原始 HTTP 和多数代理都没有 | `status: "incomplete"` + `incomplete_details.reason` | `content[type:"refusal"].refusal` | `type:"reasoning"` 项 |
| Anthropic | `content[type:"text"].text` | `stop_reason: "max_tokens"` | `stop_reason: "refusal"` | `type:"thinking"` 块 |
| Google | `candidates[0].content.parts[].text` | `finishReason: "MAX_TOKENS"` | 无候选时 `promptFeedback.blockReason`；`finishReason` 为 SAFETY / RECITATION / BLOCKLIST / PROHIBITED_CONTENT / SPII 等 | `thought: true` 的 part |

## 共同的宽容处理

- 取到文字后再找 JSON：先整段解析，再剥 ```json 代码块，再取第一个 `{` 到最后一个 `}`；先去掉 `<think>…</think>`。
- 规范化：数字 ID 转字符串；丢弃 `reason`/`confidence` 等说明字段；`newFolders` / `merges` 缺省补空数组。`url` 这类意外字段仍按严格 schema 拒绝。
- 失败分级（Debug 日志 `parse-failed.stage`，收藏回执原因）：`envelope` 回复结构不认识 · `empty` 没有回答文字 · `incomplete` 输出被截断 · `refused` 拒答或拦截 · `json` 不是 JSON · `validate` JSON 不符合任务要求（附 zod 首个问题路径）。
- HTTP 非 2xx：Debug 日志记录状态码和服务商的错误信息（最多 300 字），便于看出“不支持 response_format”之类的问题。
