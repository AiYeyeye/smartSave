# Connect an AI service

[简体中文](model-setup.md)

Local bookmark management, search and manual export do not require AI. AI uses your own service connection, with billing and data retention controlled by that provider. There is no bundled key or automatic cloud fallback.

1. Open **Settings → AI services → Add connection** and select your provider.
2. Enter its base URL and API key, then grant access to that host.
3. Fetch the model list and explicitly select a model. If discovery is unavailable, enter an ID from your provider's console.
4. Assign models to saving, import, search and organization.
5. Saving completes setup. You can run the synthetic connection test in service settings. Getting started in sidebar settings explains how to bookmark, search and organize.

Supported modes are OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and Gemini, with existing Ollama/LM Studio paths. A provider name alone does not establish protocol compatibility.

## MiniMax, Zhipu and Z.ai

Enter these **base URLs**; the extension appends the resource path. Regional accounts, standard API access and coding subscriptions are not interchangeable. A listed model does not guarantee account access.

| Service | API mode | Base URL |
| --- | --- | --- |
| MiniMax China | OpenAI Chat Completions / Responses | `https://api.minimax.cn/v1` |
| MiniMax international | OpenAI Chat Completions / Responses | `https://api.minimax.io/v1` |
| MiniMax China Messages | Anthropic Messages | `https://api.minimax.cn/anthropic` |
| Zhipu standard API | OpenAI Chat Completions | `https://open.bigmodel.cn/api/paas/v4` |
| Zhipu Responses | OpenAI Responses | `https://open.bigmodel.cn/api/v1` |
| Zhipu Messages | Anthropic Messages | `https://open.bigmodel.cn/api/anthropic` |
| Z.ai standard API | OpenAI Chat Completions | `https://api.z.ai/api/paas/v4` |
| Z.ai Responses | OpenAI Responses | `https://api.z.ai/api/v1` |

Switching Zhipu from Chat to Responses requires changing the base URL too. Saved URLs are not rewritten, and failures never switch providers or protocols. Existing MiniMax `api.minimaxi.com` connections remain unchanged; if redirected, enter the actual endpoint from your console and authorize its host.

New MiniMax connections offer M3, M2.7 and M2.5 as fallback catalog entries. M3.1-Flash-Preview currently requires M Plan or MiniMax Code access. It always reasons; selecting no thinking uses its lowest supported effort, `low`.

Leave the output limit blank to use the service default for Chat, Responses and Gemini. Anthropic requires a limit: known Claude families use compatible values and unknown models use 4096. Explicit saved limits, including 128000, remain unchanged. Clear and save the field to restore automatic behavior. Thinking may use the output budget; increase it within the model’s supported range if the response is truncated.

MiniMax error **1026 / `input new_sensitive` means input content was blocked**. HTTP 400/422 or the label `image_content_policy_violation` does not establish that an image was sent. Run the synthetic test first. If it passes but organization fails, inspect submitted titles, URLs, folder names and instructions, or contact the provider about a possible false positive. Changing protocols, increasing the timeout or repeating the request does not fix content filtering.

References: [MiniMax Chat](https://platform.minimax.cn/docs/api-reference/text-openai-api), [Responses](https://platform.minimax.cn/docs/api-reference/responses-create), [errors](https://platform.minimax.cn/docs/api-reference/errorcode), [model status](https://platform.minimax.cn/docs/faq/models), [Zhipu Chat](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction/), [Responses](https://docs.bigmodel.cn/cn/guide/develop/responses/introduction/), [model limits](https://docs.bigmodel.cn/cn/guide/start/model-overview), [Z.ai Chat](https://docs.z.ai/api-reference/llm/chat-completion). Coding subscriptions have separate eligibility rules: [MiniMax M Plan](https://platform.minimax.cn/docs/m-plan/faq), [Z.ai tool integration](https://docs.z.ai/devpack/tool/others).

## Other providers and switching models

See the [provider contracts](../reference/model-protocols.md) for endpoints, parameters and official sources. Live discovery takes precedence over fallback catalogs, and a listed model does not guarantee access. Ark requires a current full model ID or an `ep-...` endpoint from your console.

When adding a model with existing feature assignments, review each feature’s current model and choose which to switch. You can switch organization alone, apply one model to all features, or keep the existing assignments. Enabling more models in an edited connection opens the same assignment step. Saving a connection alone does not switch every feature.

Changing models invalidates old organization plans, which must be regenerated. Failed restoration ends the waiting state and displays the cause; stopping returns to scope selection while retaining saved tasks. Already-submitted bookmark operations still require checking their execution records.

## Keys and privacy

Remembered keys are stored in plaintext in extension-local storage. Adding a connection currently enables remembering by default; clear it if needed. Temporary keys belong to a page/task and may disappear on close or reload. Background native-save classification normally needs saved credentials. Removing one local key does not guarantee removal of other compatibility-storage copies; revoke it in the provider console for complete revocation.

Review excluded folders, full URLs and page-body assistance under Privacy and rules. Page-body assistance is off by default; full URLs are on, and query parameters can contain private information. Local search sends nothing, while configured native-star saves may classify automatically. See the [privacy policy](../privacy.en.md).

## Troubleshooting

Use a base URL, not a complete `/chat/completions` URL. Embedded credentials, query parameters and fragments are rejected. Remote services require HTTPS; normalized loopback services may use HTTP. Redirects are rejected.

| Result | What to check |
| --- | --- |
| No model list | Endpoint, authorization, or manual model ID entry |
| 401 / 403 | Key, quota, Origin and provider access controls |
| 400 / 422 | Specific error, API mode, base URL, model ID and output limit |
| MiniMax 1026 | Content rejection; compare a synthetic test with the failing task |
| 429 / 5xx | Bounded retries apply only to these explicit responses |
| Interrupted network/stream | Check connectivity; explicitly continue retained organization batches |
| Invalid output | Check the selected model and protocol; invalid proposals cannot be applied |
| Unknown write result | Inspect recovery records; retrying does not prove nothing was written |

Background organization can keep generating while its workbench is closed; applying changes still requires fresh authority and confirmation. Other page requests or temporary credentials may not survive closing the page. A successful test proves only that request, not every feature or provider.

Local model servers must be installed separately. Configure authentication and CORS for the actual extension ID using the server's official guidance. See the [protocol reference](../reference/model-protocols.md).
