# 真实模型评测

评测只读取导出的书签副本，不移动或修改浏览器书签。人工标注“应该放哪里”后，才能讨论准确率；现有目录不能自动当成正确答案。

1. 在智栏导出待评测书签与候选目录为 JSON v1。把私人文件放在仓库根目录的 `.local/private/evaluation/`（已忽略，不提交）。从 `extension/` 运行：

   ```powershell
   node checks/model-evaluation.mjs --from-export ../.local/private/evaluation/bookmarks.json --output ../.local/private/evaluation/labeled.json
   ```

2. 模板包含最多200条 HTTP(S)书签，`cases[].expectedFolderId` 留空。逐条填写你认为正确的目录ID，可在同文件的 `tree.nodes` 中查询目录。删除不适合评测的条目或换成其他书签ID。导出ID只在这个文件内有效。

3. 创建模型路线文件 `.local/private/evaluation/models.json`，可放1–20个配置。示例中的地址和模型名需要替换：

   ```json
   [{"config":{"adapter":"openai-compatible","baseUrl":"https://YOUR-ENDPOINT/v1","model":"YOUR-MODEL","timeoutMs":60000,"fastMode":true},"keyEnv":"ZHILAN_EVAL_API_KEY"}]
   ```

   协议可选 `openai-compatible`、`openai-responses`、`anthropic`、`google-generative-ai`、`ollama`、`lm-studio`。不同提供商可指定不同的密钥环境变量名；密钥不放在配置/数据文件里。输出上限保持应用默认128000，也可以显式填写 `maxOutputTokens`。

4. 先检查标注与候选覆盖，不会发送请求：

   ```powershell
   node checks/model-evaluation.mjs --dataset ../.local/private/evaluation/labeled.json --config ../.local/private/evaluation/models.json
   ```

5. 将所需密钥设到对应环境变量后，加 `--run` 才会逐条、逐模型发送书签标题、经过隐私处理的网址及候选目录；会消耗提供商额度。Ctrl+C可取消。429/5xx可能按应用策略重试。

   ```powershell
   node checks/model-evaluation.mjs --dataset ../.local/private/evaluation/labeled.json --config ../.local/private/evaluation/models.json --run --output ../.local/private/evaluation/report.json
   ```

报告包括准确率（失败计为不正确）、成功请求准确率、失败率、成功请求耗时中位数/P90、可用的SSE首字耗时和逐条结果。它不保存书签标题、网址、密钥或原始模型响应。所有模型使用同一标注集和生产候选选择；报告会标明正确目录是否被候选选择覆盖，便于区分召回与模型判断问题。此入口比较模型本身，已有本地规则命中率和完整浏览器流程需要另外验收。
