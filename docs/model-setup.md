# User-configured models (real-provider validation NOT RUN)

No model is needed for native CRUD, local search or manual export. Save AI failure permits manual confirmation; search failure retains local results; import classification pauses and does not write half-classified items. Organizer proposals never apply without preview, confirmation and backup.

In `模型与隐私`, pick a **模型服务** vendor (DeepSeek / OpenAI / Claude / Ollama / LM Studio / 自定义). The vendor fills adapter, base URL and suggested models as a draft only. Protocol, base URL and timeout live under **高级**. Enter optional `API Key`, choose or type a `模型名称`, then `保存模型设置`. There is no built-in endpoint/key.

Base address is a base, **not** the complete completion URL: Ollama appends `/api/chat` (list: `/api/tags`); Anthropic appends `/v1/messages` (list: `/v1/models`); for OpenAI-compatible / LM Studio a base that already ends in `/v1` receives `/chat/completions` or `/models`, any other base receives `/v1/chat/completions` or `/v1/models`, so `/v1` is never duplicated. HTTPS is required except HTTP normalized loopback localhost/127.x.x.x/[::1]. Embedded username/password, query and fragment are rejected. No redirects/cookies/implicit retries/provider fallback.

Click `授权并获取模型` to grant optional host permission for the configured origin and fetch the provider model list (OpenAI-compatible `GET …/models`, Ollama `GET /api/tags`, Anthropic `GET …/models` with `x-api-key` + `anthropic-version: 2023-06-01`). List failures that are not auth-denied may fall back to a curated Claude list; you can always type a manual model ID. Then only when authorized for a real test use `使用合成数据测试连接`. This sends an actual synthetic search request (no bookmark candidates), not an offline check. Saving unchanged values is a no-op: it does not rotate the settings revision, so pending organizer proposals and running requests survive a repeated save or test. Optional `presetId` is stored for UI restore only and is not part of the credential route identity. Success does not validate all four AI tasks. `取消请求` cancels without automatic retry.

Anthropic requests use native Messages: `x-api-key`, `anthropic-version: 2023-06-01`, `POST /v1/messages` with top-level `system` and `max_tokens`; the assistant text is read from `content[].text` and validated as the same JSON proposal schema as other adapters.

Each request carries a task-specific system prompt plus the classification policy (default: new folder chains at most 3 levels below the target root, title optimization off). Model output is validated against that policy: over-deep new folders are rejected, title suggestions for already-titled items are dropped, and URLs are never taken from the model.

## Local server setup (operator-owned, NOT RUN here)
For Ollama, start the chosen installed model/server separately and allow only the actual `chrome-extension://<extension-id>` Origin using the documented `OLLAMA_ORIGINS` setting. Do not use a wildcard or expose loopback publicly. For LM Studio, verify server/model JSON Schema capability and configure documented CORS/Origin and token controls. Keep authentication where required; do not recommend disabling it. Record exact server/model versions. No software/model download or server configuration is performed here.

## Failures and evidence
Permission denial: explicitly authorize the configured host, not all hosts. 401: credential; 403: server authentication/Origin; 429: manually retry later; timeout: inspect server/hardware and deliberately adjust timeout; schema: check adapter/model structured output support; list-unsupported: type the model ID manually. Errors omit provider bodies. Closing pages does not keep requests alive. Settings/privacy/tree/permission changes invalidate proposals; obtain a fresh preview.

P2 remains NOT RUN: record Windows/browser/server/model versions, sanitized route, all four AI task outcomes and denied/auth/timeout/malformed-response cases. No cloud fallback, network probe or real-model call was executed in this task.
