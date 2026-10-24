export const preferencesEnglish = {
  模型: 'Model',
  刷新: 'Refresh',
  已复制: 'Copied',
  隐私: 'Privacy',
  'AI 模型': 'AI model',
  模型与隐私: 'Model and privacy',
  '配置草稿已更改；尚未保存、授权或调用模型。':
    'Draft settings changed. Nothing has been saved, authorized or sent to a model.',
  '旧密钥未绑定服务，已移除；请重新输入。':
    'The legacy key was not bound to a service and was removed. Enter it again.',
  '配置或存储不可用，请重新打开设置重试。': 'Settings or storage are unavailable. Reopen settings to try again.',
  '已删除保存的密钥。': 'Saved key deleted.',
  '隐私设置已保存；未配置模型不影响浏览。': 'Privacy settings saved. Browsing works without a configured model.',
  '模型主机权限被拒绝。': 'Model host permission was denied.',
  '未能获取模型列表：{reason}。可手填模型 ID；401检查密钥；403检查服务鉴权/Origin；429稍后重试；permission重新授权；list-unsupported 请手填。':
    'Could not fetch models: {reason}. You can enter a model ID manually. For 401, check the key; 403, service authorization/Origin; 429, retry later; permission, authorize again; list-unsupported, enter the ID manually.',
  '已授权；列表接口不可用，已填入常用模型，仍可手填自定义 ID。':
    'Authorized. The model-list endpoint is unavailable, so common models are shown. You can still enter a custom ID.',
  '已授权并获取 {count} 个模型；尚未证明任务能力。':
    'Authorized and fetched {count} models. Task capability has not been verified.',
  '模型设置已保存；尚未证明服务能力。': 'Model settings saved. Service capability has not been verified.',
  '合成分类测试通过；草稿未保存。': 'Synthetic classification test passed. The draft has not been saved.',
  '模型请求未完成：{reason}。可展开 Debug 日志查看调用与返回。':
    'Model request did not complete: {reason}. Open Debug logs to inspect the call and response.',
  '配置或存储不可用：请选择服务商或协议、模型和超时；远程地址须HTTPS，HTTP仅限回环地址。':
    'Settings or storage are unavailable. Choose a provider or protocol, model and timeout. Remote endpoints require HTTPS; HTTP is limited to loopback addresses.',
  数据发送与密钥安全: 'Data sharing and key storage',
  '请求发送到您配置的服务；本地不会自动切换云端。完整网址参数可能包含凭证。未排除的内网书签信息也可能发送。':
    'Requests go to the service you configure. Local services do not switch to cloud services automatically. Full URL parameters may contain credentials. Intranet bookmark information may also be sent unless excluded.',
  '密钥默认仅当前页面会话使用。记住密钥存于本地扩展存储；不进入同步、日志、备份或导出。':
    'By default, keys are used only in the current page session. Remembered keys are stored locally by the extension and excluded from sync, logs, backups and exports.',
  模型服务: 'Model service',
  '明确记住密钥（本地明文存储）': 'Remember the key explicitly (local plaintext storage)',
  '记住的密钥不是操作系统保险库保护的数据。':
    'Remembered keys are not protected by the operating system’s credential vault.',
  '手填模型 ID': 'Enter model ID manually',
  模型名称: 'Model name',
  '当前列表为常用模型兜底，不是实时发现结果。':
    'This list contains common models as a fallback, not live discovery results.',
  '流式响应（关闭后使用 JSON）': 'Streaming responses (uses JSON when off)',
  '优先快速响应（对已支持的模型降低思考量）': 'Prefer fast responses (reduces reasoning for supported models)',
  '高级：协议、地址与超时': 'Advanced: protocol, endpoint and timeout',
  '留空使用服务默认上限；Anthropic 使用兼容上限。自定义值须在模型支持范围内，思考可能占用输出额度。':
    'Leave blank for the service default; Anthropic uses a compatible limit. A custom value must fit the model. Thinking may consume the output budget.',
  '输出上限请输入大于或等于 1 的有效整数。': 'Enter a valid integer of at least 1 for the output limit.',
  接口协议: 'API protocol',
  服务基础地址: 'Service base URL',
  '填写服务根/代理前缀（可以以 /v1 结尾，不会重复拼接）。Anthropic 使用 /v1/messages；兼容协议使用 /v1/chat/completions；Ollama 使用 /api/chat。主机权限不能精确限定端口/路径。':
    'Enter the service root or proxy prefix; a trailing /v1 will not be duplicated. Anthropic uses /v1/messages, compatible APIs use /v1/chat/completions, and Ollama uses /api/chat. Host permissions cannot precisely limit ports or paths.',
  '超时（毫秒）': 'Timeout (milliseconds)',
  '流式响应按连续无事件或心跳的时间计时；持续收到数据会继续等待。非流式响应按总时间计时。':
    'Streaming timeouts measure continuous inactivity without events or heartbeats; incoming data keeps the request alive. Non-streaming timeouts measure total elapsed time.',
  '控制发送到模型服务的内容。排除目录不改变导出范围。':
    'Control what is sent to model services. Excluded folders do not change export scope.',
  '发送完整网址（含查询参数和片段）': 'Send full URLs (including query parameters and fragments)',
  '正文辅助（仅主动收藏）': 'Use page content (explicit saves only)',
  'AI排除目录（包括子目录；不改变导出范围）':
    'Folders excluded from AI (including descendants; export scope is unchanged)',
  '目录未就绪；现有排除配置保留。': 'Folders are not ready. Existing exclusions are retained.',
  保存隐私设置: 'Save privacy settings',
  保存模型设置: 'Save model settings',
  授权并获取模型: 'Authorize and fetch models',
  使用合成数据测试连接: 'Test connection with synthetic data',
  '已取消；不会自动重试。': 'Canceled. No automatic retry.',
  取消请求: 'Cancel request',
  删除密钥: 'Delete key',
  测试范围与请求生命周期: 'Test scope and request lifetime',
  '连接测试不代表全部任务已验证。关闭页面会取消请求，不自动重试。':
    'A connection test does not verify every task. Closing the page cancels requests, with no automatic retry.',
  '规则存储不可用，未覆盖任何数据。': 'Rule storage is unavailable. No data was overwritten.',
  '规则已保存；不会自动收藏。': 'Rule saved. No automatic save is triggered.',
  '规则操作未完成，请检查目录与存储后明确重试；不会自动选择其他目录。':
    'The rule operation did not complete. Check the folder and storage, then retry explicitly. Another folder will not be selected automatically.',
  网站目录规则: 'Website folder rules',
  '仅明确确认收藏时创建规则；重命名和移动跟随原目录身份，删除后必须重新选择。':
    'Rules are created only with explicit save confirmation. They follow the original folder through renames and moves. After deletion, choose a folder again.',
  '暂无规则。': 'No rules yet.',
  '（包含子域名）': ' (including subdomains)',
  '（精确主机）': ' (exact host)',
  '目录失效或尚未就绪，请重新选择': 'Folder unavailable or not ready. Select again.',
  '修改 {host}': 'Edit {host}',
  '删除 {host}': 'Delete {host}',
  规则目标目录: 'Rule destination folder',
  请明确选择目录: 'Choose a folder explicitly',
  包含子域名: 'Include subdomains',
  确认修改规则: 'Confirm rule changes',
  取消修改规则: 'Cancel rule changes',
  收藏记录: 'Save history',
  最近的原生收藏: 'Recent browser bookmark saves',
  '在浏览器里点星标或 Ctrl+D 收藏后，智栏的处理结果会记录在这里（最多 30 条，仅保存在本机）。':
    'After saving with the browser star or Ctrl+D, Zhilan’s results appear here. Up to 30 records are kept on this device.',
  '还没有记录。收藏一个网页试试。': 'No records yet. Try saving a webpage.',
  'Debug 日志': 'Debug logs',
  '提醒：日志可能包含书签标题和网址，分享前请检查。':
    'Note: logs may contain bookmark titles and URLs. Review before sharing.',
  '开启后记录 AI 请求、脱敏后的请求与响应正文、状态码和解析过程。仅保存在本机，不记录密钥；正文可能包含书签标题和网址，分享前请检查。单份正文最多 65536 字符，日志总量最多 1 MiB。':
    'When enabled, logs record AI requests, redacted request and response bodies, status codes and parsing steps. Stored only on this device; keys are excluded. Bodies may contain bookmark titles and URLs, so review before sharing. Each body is limited to 65,536 characters and the whole log to 1 MiB.',
  已开启: 'On',
  已关闭: 'Off',
  '开启 Debug 日志': 'Enable Debug logs',
  收藏耗时统计: 'Save timing statistics',
  '最近 30 条本机记录，按连接和模型统计成功收藏；失败单独计数。总耗时包含收藏后的等待。非流式响应无法拆分首字与生成耗时。':
    'Uses the latest 30 local records. Successful saves are grouped by connection and model; failures are counted separately. Total time includes the wait after saving. Non-streaming responses cannot separate first-token and generation time.',
  '收藏网页后会显示耗时，不需要开启 Debug 日志。':
    'Timing appears after saving a webpage. Debug logs do not need to be enabled.',
  '成功 {completed} 条 · 失败 {failed} 条': 'Successful: {completed} · Failed: {failed}',
  总耗时: 'Total time',
  等首字: 'First token',
  生成: 'Generation',
  校验与写入: 'Validation and write',
  '旧记录（不含前置等待）': 'Legacy records (excluding initial wait)',
  '{label}：中位 {median} 秒 · P90 {p90} 秒（{count} 条）': '{label}: median {median}s · P90 {p90}s (samples: {count})',
  复制全部: 'Copy all',
  清空: 'Clear',
  '已开启，暂无记录。收藏一个网页或测试一次连接试试。':
    'Enabled, with no records yet. Save a webpage or test a connection.',
  '默认关闭。开启后，新的调用会出现在这里（最多 400 条）。':
    'Off by default. When enabled, new calls appear here (up to 400 entries).',
  调用轨迹: 'Call trace',
  查看请求正文: 'View request body',
  查看响应正文: 'View response body',
  '（已截断）': ' (truncated)',
} as const;
