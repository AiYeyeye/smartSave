export const exportEnglish = {
  未命名目录: 'Untitled folder',
  '收起 {title}': 'Collapse {title}',
  '展开 {title}': 'Expand {title}',
  '勾选要导出的文件夹或书签，再点击下一步。': 'Select folders or bookmarks to export, then choose Next.',
  '无法读取文件配置；已停止页面操作，请检查存储后刷新状态。':
    'File settings could not be read. Page operations have stopped. Check storage and refresh the status.',
  '请勾选要导出的内容。若所选目录已被删除，请重新选择。':
    'Select content to export. If a selected folder has been deleted, select again.',
  '已发起 {format} 下载；请在浏览器下载记录中确认完成。':
    '{format} download started. Check your browser downloads to confirm completion.',
  '导出被拒绝：请重新选择有效范围，或缩小过大的范围。':
    'Export refused. Select a valid scope again, or reduce an oversized selection.',
  'JSON 专用输出': 'Dedicated JSON output',
  '已选择候选文件；请点击授权并启用。现有目标尚未替换。':
    'Candidate file selected. Choose Authorize and enable to continue. The existing target has not been replaced.',
  '已取消选择，现有输出目标不变。': 'Selection canceled. The existing output target is unchanged.',
  '文件选择失败，现有输出目标不变。': 'File selection failed. The existing output target is unchanged.',
  '无法打开文件选择器，现有输出目标不变。': 'The file picker could not open. The existing output target is unchanged.',
  '权限未授予，未启用或重试写入。请明确重新授权。':
    'Permission was not granted. No write was enabled or retried. Authorize again to proceed.',
  '后台已接受本次补写请求；不代表文件写入成功，请刷新状态查看持久回执。':
    'The background worker accepted this update request. This does not confirm a successful file write. Refresh the status to check the saved receipt.',
  '授权失败，请使用可见页面重新授权。': 'Authorization failed. Authorize again from a visible page.',
  '已接受停止请求并撤销待启用配置；已发出的文件关闭无法撤回。':
    'Stop request accepted and pending configurations revoked. A file close already issued cannot be recalled.',
  '操作已过期或与其他页面冲突，未接受本次请求。请刷新状态后重新操作。':
    'This request expired or conflicts with another page and was not accepted. Refresh the status before trying again.',
  '存储失败，未确认接受本次请求。请检查存储并刷新状态；不会报告写入成功。':
    'Storage failed; acceptance of this request is unconfirmed. Check storage and refresh the status. No successful write is reported.',
  '后台回执不匹配，无法确认本次请求。请刷新状态核对，不会报告写入成功。':
    'The background receipt does not match this request. Refresh the status to verify. No successful write is reported.',
  '操作未完成或范围已失效。请刷新状态并明确重选目录/文件；不会回退全树。':
    'The operation did not complete or the scope is no longer valid. Refresh the status and select the folders or file again. The whole tree will not be used as a fallback.',
  '失效内容 {id}': 'Unavailable item {id}',
  导出设置: 'Export settings',
  导出书签: 'Export bookmarks',
  '选好内容和格式，即可保存到电脑。': 'Choose content and a format to save to your computer.',
  选择内容: 'Select content',
  选择格式: 'Choose format',
  确认导出: 'Confirm export',
  选择要导出的内容: 'Choose content to export',
  '勾选文件夹可选中其中全部内容；展开后也能单独勾选书签。':
    'Select a folder to include all its contents, or expand it to select individual bookmarks.',
  '已选 {bookmarks} 条书签 · {folders} 个目录': 'Selected bookmarks: {bookmarks} · Folders: {folders}',
  清空选择: 'Clear selection',
  '下一步：选择格式': 'Next: choose format',
  选择导出格式: 'Choose export format',
  '（推荐）': ' (recommended)',
  '可导入 Chrome、Edge 等浏览器': 'Import into Chrome, Edge and other browsers',
  '适合阅读、笔记和分享': 'For reading, notes and sharing',
  '保留完整书签数据，便于再次导入': 'Preserve bookmark data for later import',
  '下一步：确认导出': 'Next: confirm export',
  确认并下载: 'Confirm and download',
  '确认所选内容和格式后，点击下载。': 'Review the selected content and format, then choose Download.',
  '{bookmarks} 条书签 · {folders} 个目录 · {format} 格式':
    'Bookmarks: {bookmarks} · Folders: {folders} · Format: {format}',
  '保留目录层级和原始链接。点击下载后，在浏览器下载记录中查看文件。':
    'Folder hierarchy and original links are preserved. After downloading, find the file in your browser downloads.',
  '下载 {format}': 'Download {format}',
  导出内容说明: 'About exported content',
  'JSON、HTML、Markdown 保留原始 URL 和空目录，不包含模型、密钥、规则或日志。导出文件不是完整恢复备份。':
    'JSON, HTML and Markdown preserve original URLs and empty folders. Models, keys, rules and logs are excluded. Exported files are not full recovery backups.',
  '自动更新 JSON 文件（可选）': 'Automatically update a JSON file (optional)',
  '自动 JSON 专用文件': 'Dedicated file for automatic JSON output',
  '首次授权后会覆盖此专用输出文件及外部修改，不反向同步，不逐次确认，不自动换路径。后台是唯一自动写入者；浏览器关闭时不运行。文件关闭成功且持久回执匹配后才记录成功；中断可能已更新文件但没有成功回执。':
    'After initial authorization, automatic output overwrites this dedicated file, including external edits. It does not sync changes back, ask before each write or change paths automatically. Only the background worker writes automatically, while the browser is running. Success is recorded only after the file closes successfully and the saved receipt matches. An interruption may leave the file updated without a success receipt.',
  我同意专用输出覆盖规则: 'I agree to the dedicated file overwrite rules',
  '此环境不支持自动文件选择或持久句柄；仍可手动下载。不承诺后台文件输出。':
    'This environment does not support automatic file selection or persistent handles. Manual downloads remain available. Background file output is not assured.',
  '当前文件：{name}': 'Current file: {name}',
  '已授权文件（名称不可用）': 'Authorized file (name unavailable)',
  '当前输出根：{roots}；排除：{excluded}': 'Current output roots: {roots}; excluded: {excluded}',
  '持久状态：{status}；最近成功：{time}': 'Saved status: {status}; last success: {time}',
  无: 'None',
  '输出已暂停。权限或文件错误请明确重新授权；范围失效请清空并重新选择目录，再选择文件启用。不会自动重试或回退全树。':
    'Output is paused. For permission or file errors, authorize again explicitly. For an invalid scope, clear the selection, choose folders again, then select a file to enable output. There is no automatic retry or whole-tree fallback.',
  '选择专用 JSON 文件': 'Choose dedicated JSON file',
  '候选文件：{name}': 'Candidate file: {name}',
  名称不可用: 'Name unavailable',
  授权并启用所选文件: 'Authorize and enable selected file',
  放弃候选文件: 'Discard candidate file',
  '此句柄不支持显式授权，不能启用自动输出。':
    'This handle does not support explicit authorization. Automatic output cannot be enabled.',
  重新授权并补写当前快照: 'Reauthorize and write the current snapshot',
  停止自动输出: 'Stop automatic output',
  刷新输出状态: 'Refresh output status',
  选择导出内容: 'Select export content',
  '导出 {title}': 'Export {title}',
} as const;
