# User-configured models (real-provider validation NOT RUN)

No model is needed for native CRUD, local search or manual export. Save AI failure permits manual confirmation; search failure retains local results; import classification pauses and does not write half-classified items. Organizer proposals never apply without preview, confirmation and backup.

In `模型与隐私`, select `接口协议`: `OpenAI-compatible（JSON模式）`, `Ollama native`, or `LM Studio structured`. Enter `服务基础地址`, `模型名称`, `超时（毫秒）` and optionally `API Key`; there is no built-in endpoint/key. Base address is a base, **not** the complete completion URL: source appends `/api/chat` for Ollama, `/v1/chat/completions` otherwise (avoid duplicating `/v1`). HTTPS is required except HTTP normalized loopback localhost/127.x.x.x/[::1]. Embedded username/password, query and fragment are rejected. No redirects/cookies/implicit retries/provider fallback.

Review full-URL/body/excluded-directory settings and [privacy](privacy.md). Click `保存模型设置`, explicitly `授权模型主机`, then only when authorized for a real test `使用合成数据测试连接`。This sends an actual synthetic search request (no bookmark candidates), not an offline check, and saves current configuration first. Success does not validate all four AI tasks. `取消请求` cancels without automatic retry.

## Local server setup (operator-owned, NOT RUN here)
For Ollama, start the chosen installed model/server separately and allow only the actual `chrome-extension://<extension-id>` Origin using the documented `OLLAMA_ORIGINS` setting. Do not use a wildcard or expose loopback publicly. For LM Studio, verify server/model JSON Schema capability and configure documented CORS/Origin and token controls. Keep authentication where required; do not recommend disabling it. Record exact server/model versions. No software/model download or server configuration is performed here.

## Failures and evidence
Permission denial: explicitly authorize the configured host, not all hosts. 401: credential; 403: server authentication/Origin; 429: manually retry later; timeout: inspect server/hardware and deliberately adjust timeout; schema: check adapter/model structured output support. Errors omit provider bodies. Closing pages does not keep requests alive. Settings/privacy/tree/permission changes invalidate proposals; obtain a fresh preview.

P2 remains NOT RUN: record Windows/browser/server/model versions, sanitized route, all four AI task outcomes and denied/auth/timeout/malformed-response cases. No cloud fallback, network probe or real-model call was executed in this task.
