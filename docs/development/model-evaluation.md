# 模型评测 / Model evaluation

评测使用导出的书签副本和人工标注的目标目录，不修改浏览器书签。现有目录只提供候选，不能自动作为正确答案。

Evaluation uses exported bookmark copies and manually labeled destination folders without modifying native bookmarks. Existing folders provide candidates, not automatic ground truth.

## 准备数据 / Prepare data

在智栏导出 JSON v1，将文件保存为 `.local/work/evaluation/bookmarks.json`。以下命令从 `extension/` 目录执行：

Export JSON v1 from Zhilan to `.local/work/evaluation/bookmarks.json`. Run these commands from `extension/`:

```sh
node checks/model-evaluation.mjs --from-export ../.local/work/evaluation/bookmarks.json --output ../.local/work/evaluation/labeled.json
```

模板最多包含 200 条 HTTP(S) 书签。逐条填写 `cases[].expectedFolderId`，目录 ID 可在同文件的 `tree.nodes` 中查询；删除不适合评测的条目。导出 ID 仅在该文件内有效。

The template contains up to 200 HTTP(S) bookmarks. Fill in each `cases[].expectedFolderId` using folder IDs from `tree.nodes`, and remove unsuitable cases. Export IDs are valid only within that file.

## 配置模型 / Configure models

创建 `.local/work/evaluation/models.json`，支持 1–20 个配置。替换示例地址和模型名，密钥通过指定环境变量提供：

Create `.local/work/evaluation/models.json` with 1–20 configurations. Replace the example endpoint and model, and supply keys through the named environment variables:

```json
[{"config":{"adapter":"openai-compatible","baseUrl":"https://YOUR-ENDPOINT/v1","model":"YOUR-MODEL","timeoutMs":60000,"fastMode":true},"keyEnv":"ZHILAN_EVAL_API_KEY"}]
```

协议可选 `openai-compatible`、`openai-responses`、`anthropic`、`google-generative-ai`、`ollama`、`lm-studio`。未填写 `maxOutputTokens` 时沿用应用的协议默认行为；显式值应符合所选模型的限制，见 [模型设置](../guides/model-setup.md)。

Supported adapters are listed above. Omitting `maxOutputTokens` uses the application's protocol defaults. Explicit values must fit the chosen model's limits; see [model setup](../guides/model-setup.en.md).

## 校验与运行 / Validate and run

默认只检查标注和候选覆盖，不发送请求：

The default command validates labels and candidate coverage without sending requests:

```sh
node checks/model-evaluation.mjs --dataset ../.local/work/evaluation/labeled.json --config ../.local/work/evaluation/models.json
```

配置密钥环境变量后，加 `--run` 才会逐条向模型发送标题、经过隐私处理的网址和候选目录，并消耗服务额度。Ctrl+C 可取消；明确的 429/5xx 响应可能按应用策略重试。

After setting the key environment variables, add `--run` to send titles, privacy-filtered URLs and candidate folders to each model. Provider charges apply. Ctrl+C cancels; explicit 429/5xx responses may receive bounded retries.

```sh
node checks/model-evaluation.mjs --dataset ../.local/work/evaluation/labeled.json --config ../.local/work/evaluation/models.json --run --output ../.local/work/evaluation/report.json
```

## 结果 / Results

报告包含准确率（失败计为不正确）、成功请求准确率、失败率、耗时中位数/P90、可用的流式首字耗时和逐条结果。各模型使用同一标注集和生产候选选择，并记录正确目录是否被候选覆盖。报告不保存标题、网址、密钥或原始模型回答。

The report includes accuracy with failures counted as incorrect, accuracy among successful requests, failure rate, median/P90 latency, available streaming time to first text, and per-case results. Models share the same labels and production candidate selection. Candidate coverage is reported separately. Reports omit titles, URLs, keys and raw model replies.

本入口比较模型分类结果；本地规则命中和完整浏览器交互通过 [浏览器测试](../../extension/README.md#isolated-browser-acceptance) 检查。

This entrypoint compares model classification. Use the [browser tests](../../extension/README.md#isolated-browser-acceptance) for local-rule behavior and complete browser interactions.
