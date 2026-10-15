export const organizeStatusEnglish = {
  '此整理任务已提交，请查看执行记录确认结果。':
    'This task has been submitted. Check the execution records for its outcome.',
  '正在读取整理任务…': 'Loading organization task…',
  '本次整理已停止，请检查配置后重新开始。': 'This task stopped. Check settings before starting again.',
  '无法保存整理进度，请检查本机存储后重新打开。': 'Cannot save progress. Check local storage and reopen.',
  '无法读取整理偏好，请检查本机存储后重新打开；已保存进度保留。':
    'Cannot read organization preferences. Check local storage and reopen; saved progress is retained.',
  '已恢复完成的整理建议，请核对后确认执行。': 'Completed suggestions restored. Review them before confirming changes.',
  '已恢复目录方案；未完成的生成需要手动重新开始。': 'Folder plan restored. Restart unfinished generation manually.',
  '已恢复整理进度，继续时只分析未完成批次。': 'Progress restored. Continuing analyzes only unfinished batches.',
  '正在连接书签服务…': 'Connecting to bookmarks…',
  '书签服务不可用。': 'Bookmarks are unavailable.',
  '请选择整理范围；扫描与提案都不会自动写入。':
    'Choose a scope. Scans and suggestions do not automatically change bookmarks.',
  '保护范围已变化，请重新生成整理建议。未修改书签。':
    'Protected folders changed. Generate suggestions again. No bookmarks were changed.',
  '已停止本次生成；未修改书签，可以重新生成。': 'Generation stopped. Bookmarks are unchanged; you can generate again.',
  '范围、书签、隐私或模型设置已变化；旧提案已失效，保留选择供核对，请重新生成。':
    'The scope, bookmarks, privacy or model settings changed. The old plan is invalid; selections remain for reference. Generate again.',
  '去重选择已修改；请重新预览后确认。': 'Duplicate choices changed. Preview again before confirming.',
  '停止请求未获确认；请核对恢复记录，不重放。':
    'The stop request was not acknowledged. Check recovery records; operations will not replay.',
  '本地扫描完成；精确重复与疑似重复分别标注，每组需明确选择保留和删除。':
    'Local scan complete. Exact and possible duplicates are labeled separately. Explicitly choose what to keep and delete in each group.',
  '本地扫描完成，未发现精确重复或疑似重复书签。': 'Local scan complete. No exact or possible duplicates found.',
  '范围不可用，请重新选择。': 'This scope is unavailable. Choose it again.',
  '正在连接整理服务并读取当前书签…': 'Connecting to the organization service and loading bookmarks…',
  '整理连接已中断，当前方案已失效；请重新生成。未自动执行书签操作。':
    'The organization connection ended and the plan is invalid. Generate again. No bookmark operations ran automatically.',
  '分析已完成，没有需要应用的操作。': 'Analysis complete. No changes to apply.',
  '正在校验返回的整理内容…': 'Validating the returned plan…',
  '正在接收 AI 整理建议…': 'Receiving AI organization suggestions…',
  '模型服务已响应，正在生成整理建议…': 'The model has responded and is generating suggestions…',
  '正在等待 AI 返回整理建议…': 'Waiting for AI suggestions…',
  '文件夹方案已生成。先核对分类树与目录变更，再确认分类并开始分批整理书签；此时不会写入。':
    'Folder plan ready. Review the tree and folder changes, then confirm to start bookmark batches. This does not write changes.',
  '已暂停。已完成批次保留，继续时只处理尚未完成的书签。未修改书签。':
    'Paused. Completed batches are retained; continuing processes only unfinished bookmarks. No bookmarks were changed.',
  '已返回文件夹方案；后续书签建议已清除，确认新的分类后会重新分批分析。未修改书签。':
    'Returned to folder review. Subsequent bookmark suggestions were cleared. Confirm the new folders to analyze batches again. No bookmarks were changed.',
  '这一批内容过长，已自动拆成更小的批次；已完成的结果不受影响。':
    'This batch was too large and has been split into smaller batches. Completed results are retained.',
  '书签或配置已变化，之前的批次已失效；请重新生成文件夹方案。未修改书签。':
    'Bookmarks or settings changed and previous batches are invalid. Generate a new folder plan. No bookmarks were changed.',
  '去重预览不可用；每组必须明确保留至少一项，且范围与扫描必须仍有效。':
    'Duplicate preview unavailable. Explicitly keep at least one item per group; the scope and scan must still be valid.',
  '选择或目标无效，依赖目录必须同时勾选；请调整或重新生成。':
    'The selection or destination is invalid. Select required folders too, or generate a new plan.',
  '正在备份并执行所选整理操作…': 'Backing up and applying selected operations…',
  '结果未知，请在备份与恢复中核对；不自动重放。':
    'The outcome is unknown. Check backup and recovery; operations will not replay automatically.',
  '可在备份与恢复中预览安全撤销。': 'Preview a safe undo in backup and recovery.',
  '整理连接已断开，正在重新读取进度；后台任务不会因页面断开而取消。':
    'Disconnected. Reloading progress; the background task continues independently of this page.',
  '无法连接整理任务，请重新读取已保存任务或重新打开智栏。':
    'Cannot connect to the task. Reload saved tasks or reopen Zhilan.',
  '无法连接整理任务，请重新打开智栏。': 'Cannot connect to the task. Reopen Zhilan.',
  '请先在 AI 服务中为智能整理分配可用模型，再开始生成。':
    'Assign an available model to organization in AI services before generating.',
  '需要重新输入本次整理使用的 API Key，再点击继续；已完成建议保留。':
    'Enter this task’s API key again, then click continue. Completed suggestions are retained.',
  '整理进度已被其他页面更新，请重新读取任务后再操作。': 'Another page updated this task. Reload it before continuing.',
  '整理请求未获确认，请重新读取已保存任务；不会自动重发分析或书签写入。':
    'The request was not acknowledged. Reload saved tasks; analysis and bookmark changes will not be resubmitted automatically.',
  '无法读取已保存的整理任务，请重试；现有书签未修改。':
    'Cannot load saved tasks. Retry; existing bookmarks are unchanged.',
  '无法恢复这项整理任务，请检查范围和模型配置；未自动继续分析。':
    'Cannot restore this task. Check its scope and model settings. Analysis did not resume automatically.',
  '正在停止尚未发出的写入，请核对执行记录。': 'Stopping remaining writes. Check the execution records.',
  '停止请求未获确认，请核对同一请求的执行记录。':
    'The stop request was not acknowledged. Check the records for the same request.',
  '执行结果需要核对，请读取同一请求的执行记录；不会重放。':
    'The outcome needs verification. Read the records for the same request; it will not replay.',
  '整理已完成，可从恢复记录核对或撤销。': 'Organization complete. Review or undo it in recovery records.',
  '执行已停止，请核对执行记录后再处理。': 'Execution stopped. Check its records before continuing.',
  '此请求的执行结果尚未确定，请查看恢复记录核对；不会自动重发。':
    'The request outcome is not yet known. Check recovery records; it will not be resubmitted automatically.',
  '执行已停止，请查看恢复记录。': 'Execution stopped. Check recovery records.',
  '无法读取执行结果，请稍后核对同一请求编号；不会重放书签写入。':
    'Cannot read the result. Check the same request ID later; bookmark writes will not replay.',
  '少量书签的目标目录无效。本批有效建议已暂存，可显式补问一次；补问完成前整批不可执行。':
    'A few bookmarks have invalid destination folders. Valid suggestions are retained. You may explicitly request one correction round; this batch cannot run until it succeeds.',
  '本次补问未能完成，已停止，不会再次补问。可手动重新生成未完成批次。':
    'The correction round failed and has stopped. It will not repeat. You can manually regenerate unfinished batches.',
  '本次整理使用的临时密钥已失效。请重新输入密钥后继续；已完成建议保留。':
    'This task’s temporary key is unavailable. Enter it again to continue; completed suggestions are retained.',
  '无法保存整理进度，已停止生成。请检查本机存储后重试；未修改书签。':
    'Progress could not be saved, so generation stopped. Check local storage and retry; no bookmarks were changed.',
  '分类目录连同提示词超过 1 MiB 请求上限，请选择一个子目录后重新整理。':
    'Folders and instructions exceed the 1 MiB request limit. Select a subfolder and try again.',
  '单条书签连同分类目录和提示词超过 1 MiB 请求上限。请缩小整理范围，或检查过长的标题和网址后重试。':
    'One bookmark, folders and instructions exceed the 1 MiB request limit. Reduce the scope or check long titles and URLs, then retry.',
  '模型未按当前整理阶段返回建议，请重试本阶段。': 'The response does not match the current stage. Retry this stage.',
  '确认后的分类结构无法使用，请返回调整文件夹方案。':
    'The confirmed folder structure is invalid. Return to the folder plan and adjust it.',
  '模型达到输出额度上限，未能生成完整方案；思考内容也会占用额度。请在 AI 服务中调整所选模型的最大输出 tokens 后重试；也可缩小整理范围。延长等待时间无法解决此问题。':
    'The model reached its output limit before completing the plan. Reasoning also uses that limit. Adjust maximum output tokens in AI services or reduce the scope, then retry. A longer timeout will not resolve this.',
  '模型服务返回了失败或相互矛盾的完成状态，方案无法使用。请稍后重试；反复出现时，在 AI 服务中测试连接或更换模型。':
    'The provider returned a failed or conflicting completion status. The plan cannot be used. Retry later; if it recurs, test the connection or choose another model.',
  '模型服务返回异常，未能完成本次生成。请稍后重试；反复出现时检查 AI 服务连接。':
    'The provider returned an error. Retry later; if it recurs, check the AI service connection.',
  '未能连接模型服务或接收回复。请检查网络及 AI 服务中的地址、模型配置，测试连接后重试。':
    'Could not connect to the provider or receive its reply. Check the network, endpoint and model settings, test the connection, then retry.',
  '接收模型回复时网络连接中断，本次回复未完整接收。请检查网络或模型服务后重试；已完成的批次会保留。':
    'The network disconnected before the reply finished. Check the network or provider and retry; completed batches are retained.',
  '整理期间书签或模型配置发生变化，本次回复已失效。请重新生成方案。':
    'Bookmarks or model settings changed during organization. The reply is invalid; generate a new plan.',
  '模型服务地址发生重定向，连接已停止。请在 AI 服务中核对并填写实际接口地址后重试。':
    'The provider redirected the request, so the connection stopped. Enter the actual endpoint in AI services and retry.',
  '本次生成已停止。请重新生成方案。': 'Generation stopped. Generate a new plan.',
  '模型已结束回复，但没有返回整理建议。请重新生成；反复出现时更换模型。':
    'The model finished without suggestions. Generate again; if it recurs, choose another model.',
  '模型服务拒绝了本次整理请求。请调整分类要求或整理范围后重试。':
    'The provider refused the request. Adjust your instructions or scope and retry.',
  '本次整理内容超过请求大小上限。请缩小整理范围，按子目录分批整理。':
    'The content exceeds the request limit. Reduce the scope and organize subfolders separately.',
  '模型同时建议合并分类和单独移动其中的内容，操作存在冲突，方案已拒绝。请重新生成或缩小整理范围。':
    'The model proposed conflicting merges and individual moves. The plan was rejected. Generate again or reduce the scope.',
  '模型建议会影响已排除的子目录内容，方案已拒绝。请缩小整理范围后重试。':
    'The suggestions would affect excluded subfolders. The plan was rejected. Reduce the scope and retry.',
  '模型建议修改不可移动或删除的根分类，方案已拒绝。请重新生成或选择子目录。':
    'The model proposed changes to a protected root folder. The plan was rejected. Generate again or choose a subfolder.',
  '模型返回的分类或操作不符合整理规则，方案校验未通过。请重新生成或缩小整理范围。':
    'The returned folders or operations failed validation. Generate again or reduce the scope.',
  '模型返回的数据超过处理限额。请缩小整理目录后重试。':
    'The response exceeds processing limits. Choose a smaller folder and retry.',
  '模型等待超时，请重试或缩小整理目录。': 'The model timed out. Retry or choose a smaller folder.',
  '连接书签或读取设置超时，请重新连接后重试。':
    'Connecting to bookmarks or reading settings timed out. Reconnect and retry.',
  '模型服务尚未授权，请在 AI 服务中检查权限。': 'The provider is not authorized. Check permissions in AI services.',
  '模型没有返回有效整理方案，请重试或更换模型。':
    'The model did not return a valid plan. Retry or choose another model.',
  '尚未配置整理模型，请先在 AI 服务中配置连接。':
    'No organization model is configured. Set up a connection in AI services first.',
  '模型服务密钥无效，请检查 AI 服务配置。': 'The provider key is invalid. Check AI service settings.',
  '模型服务拒绝了访问，请检查服务权限。': 'The provider denied access. Check service permissions.',
  '模型服务请求过多或额度不足，请稍后重试。':
    'The provider is rate-limiting requests or has insufficient quota. Retry later.',
  '模型回复未完成，请重试或缩小整理目录。': 'The reply is incomplete. Retry or choose a smaller folder.',
  '书签服务暂时未连接，请等待连接恢复后重试。': 'Bookmarks are disconnected. Wait for reconnection and retry.',
  '整理服务不可用，请检查模型配置和书签连接。':
    'Organization is unavailable. Check model settings and the bookmark connection.',
  '整理服务连接超时，请重新连接后重试。': 'The organization connection timed out. Reconnect and retry.',
  '整理连接已中断，请重新生成方案。': 'The organization connection ended. Generate a new plan.',
  '整理范围或配置已变化，请重新生成方案。': 'The scope or settings changed. Generate a new plan.',
  '请填写自定义分类要求。': 'Enter your custom organization instructions.',
  '分类要求无效或过长，请调整后重试。': 'The instructions are invalid or too long. Edit them and retry.',
  '此整理范围已被保护或排除，请更换目录或取消该范围的保护后重试。':
    'This scope is protected or excluded. Choose another folder or remove protection and retry.',
  '建议会改动受保护分类或其路径，请调整范围后重新生成。':
    'The suggestions would change protected folders or paths. Adjust the scope and generate again.',
  '模型建议删除仍有内容或不可修改的分类，方案已拒绝，请重新生成。':
    'The model proposed removing nonempty or read-only folders. The plan was rejected; generate again.',
  '整理过程发生未识别错误，未能生成可执行方案。请重新生成；若仍失败，请在设置中查看调试日志，并反馈本页的错误阶段与代码。':
    'An unrecognized error prevented a valid plan. Generate again. If it recurs, check the debug log in settings and report the failed stage and code shown here.',
  ' 未修改书签。': ' No bookmarks were changed.',
  '方案已生成，共 {count} 项建议；请核对后点击“下一步：确认操作”。':
    'Plan ready with {count} suggestions. Review them, then click “Next: confirm changes”.',
  'AI 正在分析 {count} 项内容，生成整理方案…': 'AI is analyzing {count} items and generating a plan…',
  '服务繁忙，{seconds} 秒后重试（{attempt}/3），可随时暂停。':
    'The service is busy. Retrying in {seconds}s ({attempt}/3); you can pause at any time.',
  '只整理当前目录直接收藏的 {count} 条书签，沿用现有分类；确认后开始分析，子目录内容保持原位。':
    'Organize only the {count} bookmarks directly in this folder, using existing folders. Confirm to start analysis; subfolder contents stay in place.',
  '等待连接、后续流数据或完整非流式响应超过 {seconds} 秒，请重试。':
    'Waiting for the connection, further stream data or a complete non-streaming response exceeded {seconds}s. Retry.',
  '正在补问 {count} 条书签（仅此一轮）；有效建议保持不变，服务繁忙时仍按既有限次策略重试。':
    'Requesting corrections for {count} bookmarks (one round only). Valid suggestions are retained; busy services still use the existing bounded retries.',
  '正在生成第 {batch} / {total} 批建议（{count} 条书签）…': 'Generating batch {batch} / {total} ({count} bookmarks)…',
  '第 {batch} 批已完成，可先查看下方分类预览和详细建议。':
    'Batch {batch} complete. You can review its folder preview and suggestions below.',
  '全部 {batches} 批已完成，已核对 {count} 条书签。{next}':
    'All {batches} batches are complete; {count} bookmarks checked. {next}',
  '请检查整体分类和所选建议后再确认执行。': 'Review the folder overview and selected suggestions before confirming.',
  '没有需要应用的操作。': 'No changes to apply.',
  '{reason} 已保留 {count} 批结果，可继续未完成批次。未修改书签。':
    '{reason} Retained results from {count} batches. You can continue unfinished batches. No bookmarks were changed.',
  '{status}：已完成 {completed} 步，未完成 {remaining} 步。{next}':
    '{status}: completed {completed} steps, remaining {remaining}. {next}',
  '{action}：{content}': '{action}: {content}',
} as const;
