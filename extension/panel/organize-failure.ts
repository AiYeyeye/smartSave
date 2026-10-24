export const failureMessages: Record<string, string> = {
  'json-mode-input-required':
    '模型服务未识别输入消息中的 JSON 输出要求，已拒绝请求。请更新并重新加载扩展后测试连接；若仍失败，请向服务商反馈 JSON 模式兼容问题。',
  'partial-invalid-targets': '少量书签的目标目录无效。本批有效建议已暂存，可显式补问一次；补问完成前整批不可执行。',
  'partial-repair-failed': '本次补问未能完成，已停止，不会再次补问。可手动重新生成未完成批次。',
  'organize-credential-required': '本次整理使用的临时密钥已失效。请重新输入密钥后继续；已完成建议保留。',
  'checkpoint-unavailable': '无法保存整理进度，已停止生成。请检查本机存储后重试；未修改书签。',
  'folder-context-too-large': '分类目录连同提示词超过 1 MiB 请求上限，请选择一个子目录后重新整理。',
  'bookmark-context-too-large':
    '单条书签连同分类目录和提示词超过 1 MiB 请求上限。请缩小整理范围，或检查过长的标题和网址后重试。',
  'invalid-organize-stage': '模型未按当前整理阶段返回建议，请重试本阶段。',
  'invalid-organize-plan': '确认后的分类结构无法使用，请返回调整文件夹方案。',
  'output-limit':
    '模型达到输出额度上限，未能生成完整方案；思考内容也会占用额度。请在 AI 服务中调整所选模型的最大输出 tokens 后重试；也可缩小整理范围。延长等待时间无法解决此问题。',
  'provider-error':
    '模型服务返回了失败或相互矛盾的完成状态，方案无法使用。请稍后重试；反复出现时，在 AI 服务中测试连接或更换模型。',
  'http-error': '模型服务返回异常，未能完成本次生成。请稍后重试；反复出现时检查 AI 服务连接。',
  'connection-or-configuration': '未能连接模型服务或接收回复。请检查网络及 AI 服务中的地址、模型配置，测试连接后重试。',
  'network-error': '接收模型回复时网络连接中断，本次回复未完整接收。请检查网络或模型服务后重试；已完成的批次会保留。',
  'stale-context': '整理期间书签或模型配置发生变化，本次回复已失效。请重新生成方案。',
  redirect: '模型服务地址发生重定向，连接已停止。请在 AI 服务中核对并填写实际接口地址后重试。',
  cancelled: '本次生成已停止。请重新生成方案。',
  empty: '模型已结束回复，但没有返回整理建议。请重新生成；反复出现时更换模型。',
  refused:
    '模型服务拒绝回答或触发内容审核。请先用合成数据测试连接，再检查本次发送的标题、网址和分类要求；切换接口模式不能解决内容拦截。',
  'http-400': '模型服务未接受请求。请核对接口模式、基础地址、模型 ID 和支持的输出额度；具体原因见 Debug 日志。',
  'http-422': '模型服务未接受请求。请核对接口模式、基础地址、模型 ID 和支持的输出额度；具体原因见 Debug 日志。',
  'payload-too-large': '本次整理内容超过请求大小上限。请缩小整理范围，按子目录分批整理。',
  'overlapping-merge': '模型同时建议合并分类和单独移动其中的内容，操作存在冲突，方案已拒绝。请重新生成或缩小整理范围。',
  'privacy-excluded-descendant': '模型建议会影响已排除的子目录内容，方案已拒绝。请缩小整理范围后重试。',
  'protected-source': '模型建议修改不可移动或删除的根分类，方案已拒绝。请重新生成或选择子目录。',
  'invalid-output': '模型返回的分类或操作不符合整理规则，方案校验未通过。请重新生成或缩小整理范围。',
  'response-too-large': '模型返回的数据超过处理限额。请缩小整理目录后重试。',
  timeout: '模型等待超时，请重试或缩小整理目录。',
  'prepare-timeout': '连接书签或读取设置超时，请重新连接后重试。',
  permission: '模型服务尚未授权，请在 AI 服务中检查权限。',
  schema: '模型没有返回有效整理方案，请重试或更换模型。',
  'model-unconfigured': '尚未配置整理模型，请先在 AI 服务中配置连接。',
  'http-401': '模型服务密钥无效，请检查 AI 服务配置。',
  'http-403': '模型服务拒绝了访问，请检查服务权限。',
  'http-429': '模型服务请求过多或额度不足，请稍后重试。',
  incomplete: '模型回复未完成，请重试或缩小整理目录。',
  'tree-unavailable': '书签服务暂时未连接，请等待连接恢复后重试。',
  unavailable: '整理服务不可用，请检查模型配置和书签连接。',
  'authority-unavailable': '整理服务连接超时，请重新连接后重试。',
  'authority-disconnected': '整理连接已中断，请重新生成方案。',
  stale: '整理范围或配置已变化，请重新生成方案。',
  'missing-organize-instructions': '请填写自定义分类要求。',
  'invalid-organize-preference': '分类要求无效或过长，请调整后重试。',
  'privacy-excluded': '此整理范围已被保护或排除，请更换目录或取消该范围的保护后重试。',
  'protected-folder': '建议会改动受保护分类或其路径，请调整范围后重新生成。',
  'unsafe-folder-removal': '模型建议删除仍有内容或不可修改的分类，方案已拒绝，请重新生成。',
};
export const failureMessage = (reason: string) => {
  return Object.hasOwn(failureMessages, reason)
    ? failureMessages[reason]
    : '整理过程发生未识别错误，未能生成可执行方案。请重新生成；若仍失败，请在设置中查看调试日志，并反馈本页的错误阶段与代码。';
};
