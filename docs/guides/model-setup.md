# 连接 AI 服务

[English](model-setup.en.md)

本地书签管理、搜索和手动导出不需要 AI。AI 功能使用你自己的连接，计费和数据保留由服务商决定；没有内置 Key 或自动云端兜底。

## 推荐操作

1. 打开 **设置 → AI 服务 → 添加连接**，选择已有服务。
2. 填写服务地址和 API Key，按界面授权该服务主机。不要把包含密钥的完整请求 URL 当作基础地址。
3. 获取可用模型，**手动选择模型**，再保存；不支持模型列表时可手动填写服务商给出的模型 ID。
4. 为智能收藏、导入、搜索和整理分别指定模型。
5. 保存后即可使用，也可在服务设置中使用合成数据测试连接。侧栏设置中的“新手操作步骤”说明收藏、搜索和整理的入口。

协议支持 OpenAI Chat Completions / Responses、Anthropic Messages、Gemini；保留 Ollama / LM Studio 等兼容路径。第三方中转需确认协议和模型 ID，不能只看服务名称。可选 OpenRouter 浏览器授权只在主动开始登录时申请权限。

## MiniMax、智谱与 Z.ai

以下是基础地址，扩展会追加资源路径。地区、普通 API 和编程套餐的密钥/权限不能假定通用；列表中有模型也不代表账号有调用权限。

| 服务 | 接口模式 | 基础地址 |
| --- | --- | --- |
| MiniMax 中国 | OpenAI Chat Completions / Responses | `https://api.minimax.cn/v1` |
| MiniMax 国际 | OpenAI Chat Completions / Responses | `https://api.minimax.io/v1` |
| MiniMax 中国（Messages） | Anthropic Messages | `https://api.minimax.cn/anthropic` |
| 智谱普通 API | OpenAI Chat Completions | `https://open.bigmodel.cn/api/paas/v4` |
| 智谱 Responses | OpenAI Responses | `https://open.bigmodel.cn/api/v1` |
| 智谱（Messages） | Anthropic Messages | `https://open.bigmodel.cn/api/anthropic` |
| Z.ai 普通 API | OpenAI Chat Completions | `https://api.z.ai/api/paas/v4` |
| Z.ai Responses | OpenAI Responses | `https://api.z.ai/api/v1` |

智谱从 Chat 切换到 Responses 时，需要同时修改基础地址。扩展不会重写已保存的地址或因失败自动换协议。旧 MiniMax `api.minimaxi.com` 连接保留；若服务返回重定向，请填写控制台给出的实际地址并重新授权。

MiniMax 新连接的备用列表使用 M3、M2.7、M2.5。`MiniMax-M3.1-Flash-Preview` 当前限 M Plan / MiniMax Code，不能当作普通 API 账号必定可用的默认值。该预览模型强制思考，“关闭思考”按其最低档位 `low` 发送。

最大输出默认留空：Chat、Responses 和 Gemini 使用服务自身默认值；Anthropic 必须发送上限，按已知 Claude 系列使用兼容值，未知模型使用 4096。可以手动填写模型支持的值。已有手填值（包括 128000）会保留；清空并保存即可恢复自动。思考可能消耗输出额度，若返回输出截断，应按模型规格提高上限。

MiniMax 的 **1026 / `input new_sensitive` 表示输入触发内容审核**。即使 HTTP 是 400/422，或错误名含 `image_content_policy_violation`，也不能据此认定请求发送了图片。先运行内置合成分类测试；若测试通过而整理失败，再检查发送的标题、网址、目录名和分类要求，必要时联系服务商核查误判。切换协议、延长超时或重复请求不能修复内容审核拒绝。

依据：[MiniMax Chat](https://platform.minimax.cn/docs/api-reference/text-openai-api)、[Responses](https://platform.minimax.cn/docs/api-reference/responses-create)、[错误码](https://platform.minimax.cn/docs/api-reference/errorcode)、[模型状态](https://platform.minimax.cn/docs/faq/models)、[智谱 Chat](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction/)、[Responses](https://docs.bigmodel.cn/cn/guide/develop/responses/introduction/)、[模型规格](https://docs.bigmodel.cn/cn/guide/start/model-overview)、[Z.ai Chat](https://docs.z.ai/api-reference/llm/chat-completion)。编程套餐另有适用范围，见 [MiniMax M Plan](https://platform.minimax.cn/docs/m-plan/faq) 和 [Z.ai 接入说明](https://docs.z.ai/devpack/tool/others)。

## 其他厂商和切换模型

内置厂商的接口、参数及官网依据见[厂商对照](../reference/model-protocols.md)。模型列表优先使用服务实时结果，备用列表不保证账号权限。火山方舟需选择实时模型或填写控制台的完整模型 ID / `ep-...` 接入点。

新增连接选好模型后，如果已有功能配置，会显示各功能当前模型。可只切换“智能整理”、批量切换，或选择“保持现有分配”。编辑连接新增启用模型也会显示这一分配步骤。保存连接本身不代表已切换所有功能。

更改模型会使旧整理方案失效，需要重新生成。恢复失败后会结束等待并显示原因；停止可返回范围选择，已保存任务仍保留。已经提交的书签操作须通过执行记录核对结果。

## 密钥与隐私

“记住密钥”会明文保存在扩展本地存储；添加连接当前默认勾选，请根据需要取消。临时 Key 由对应页面/任务持有，关闭或刷新页面后可能丢失。后台原生收藏通常需要已保存的凭据。删除连接或旧设置中的 Key 不保证清除兼容存储中的其他副本；彻底撤销应在服务商控制台完成。

在 **隐私与规则** 检查 AI 排除目录、完整网址和正文辅助。正文辅助默认关闭；完整网址默认开启，查询参数可能含私人内容。普通本地搜索不发送数据，配置后的原生星标收藏可能自动分类。详见 [隐私政策](../privacy.md)。

## 地址与错误处理

使用服务商提供的基础地址。常见 OpenAI 兼容地址以 `/v1` 结束，扩展按协议拼接接口；不要重复拼接 `/chat/completions`。地址不接受嵌入的用户名/密码、查询参数或片段。远程连接要求 HTTPS，本机规范化回环地址允许 HTTP；请求拒绝重定向，不自动切换服务。

| 情况 | 处理方式 |
| --- | --- |
| 无模型列表 | 检查地址与授权，或手动填模型 ID |
| 401 / 403 | 检查密钥、配额、服务端 Origin 和访问控制 |
| 400 / 422 | 查看具体错误；检查协议、地址、模型和输出额度，不能只凭 HTTP 状态判断原因 |
| MiniMax 1026 | 输入内容被审核拒绝；先用合成测试区分连接配置与本次内容问题 |
| 429 / 5xx | 等服务恢复；实现只对明确的此类响应做有限重试 |
| 网络断开 / 流中断 | 检查服务连接；整理保留已接受批次，使用明确的继续操作 |
| 输出无效 | 核对协议、模型能力和输出限制；不要把无效方案直接执行 |
| 结果未知 | 进入恢复记录核对，禁止把重试当作确认未写入 |

后台整理可在工作台关闭后继续生成，重开查看；原生写入的最终确认仍由当前有效界面发起。其他页面请求或临时 Key 不保证关页后继续。连接测试成功只证明该次请求通过，不代表所有功能和所有模型都验收通过。

本地模型服务器需另行安装和运行。按服务器官方说明限制 Origin 为实际扩展 ID、配置必要认证和 CORS；不要将本机服务暴露到公网或无条件开放所有 Origin。协议细节见 [模型协议](../reference/model-protocols.md)。
