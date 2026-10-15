export const importEnglish = {
  '先选择书签文件，读取完成后点击下一步。': 'Choose a bookmark file, then select Next after it has been read.',
  '模型设置或权限已变化；预览失效。请明确继续或重新分类，不会自动请求。':
    'Model settings or permissions changed and the preview is no longer valid. Continue or reclassify explicitly. No request is sent automatically.',
  '{reason}：请核对目标、任务及恢复日志，再明确恢复或重新校验；不会自动重试。':
    '{reason}: check the destination, task and recovery journal, then explicitly resume or validate again. No automatic retry.',
  '操作未获确认；请保留任务并核对恢复记录，不会自动重试。':
    'The operation was not confirmed. Keep this task and check recovery records. No automatic retry.',
  '全量分类完成；请检查整批预览。': 'Classification finished. Review the full batch preview.',
  '已暂停：{reason}。仅保留已提交的进度。': 'Paused: {reason}. Only committed progress is retained.',
  根目录: 'Root folder',
  导入工作台: 'Import workbench',
  '读取文件，让 AI 重新分类，检查后再添加到浏览器。':
    'Read a file, let AI reclassify its bookmarks, then review them before adding them to the browser.',
  选择文件: 'Choose file',
  选择目标: 'Choose destination',
  检查预览: 'Review preview',
  确认导入: 'Confirm import',
  选择要导入的书签文件: 'Choose a bookmark file to import',
  '支持浏览器导出的 HTML，以及 JSON、CSV、TXT、Markdown 文件。':
    'Supports browser-exported HTML, JSON, CSV, TXT and Markdown files.',
  导入格式: 'Import format',
  导入文件: 'Import file',
  '格式已更改，请重新选择文件。': 'Format changed. Choose the file again.',
  '文件超过已测量的 32MiB 解析保护预算；不截断。':
    'The file exceeds the tested 32 MiB parsing limit. It will not be truncated.',
  '文件已读取：{count} 条原始项。点击下一步选择存放目录。':
    'File read: {count} source items. Choose Next to select a destination folder.',
  已读取文件: 'File read',
  '{name} · {count} 条原始项': '{name} · Source items: {count}',
  查看文件中的原始条目: 'View original file entries',
  待分类: 'Awaiting classification',
  '来源 {id} · {url} · {diagnostic} · {provenance} · 原目录 {path}':
    'Source {id} · {url} · {diagnostic} · {provenance} · Original folder {path}',
  '下一步：选择目标目录': 'Next: choose destination folder',
  '请先在 AI 服务中配置模型，再开始导入分类。': 'Configure a model in AI services before classifying an import.',
  '正在连接书签服务，请稍候…': 'Connecting to the bookmark service…',
  '书签要放在哪里？': 'Where should the bookmarks go?',
  导入目标根: 'Import destination root',
  请选择一个目录: 'Choose a folder',
  'AI 会把文件中的书签重新分类到此目录下。检查预览后，才会创建书签。':
    'AI will reclassify the file’s bookmarks under this folder. Bookmarks are created only after you review and confirm the preview.',
  '正在分类…': 'Classifying…',
  '下一步：AI 分类并预览': 'Next: classify with AI and preview',
  继续分类: 'Continue classification',
  重新分类: 'Reclassify',
  '已请求暂停；已发起写入结果须核对日志。':
    'Pause requested. Check the journal for the outcome of any writes already issued.',
  暂停当前任务: 'Pause current task',
  继续以前的导入任务: 'Continue a previous import task',
  读取导入任务列表: 'Load import task list',
  '此任务已交给写入日志；请读取恢复记录核对，不可重新分类。':
    'This task has been handed to the write journal. Check recovery records; it cannot be reclassified.',
  '已加载；仅在明确点击后继续。': 'Loaded. Continues only when explicitly requested.',
  加载任务: 'Load task',
  确认导入内容: 'Confirm import contents',
  检查分类结果: 'Review classification results',
  '分类尚未完成。可以先查看已有条目，再点击继续分类。':
    'Classification is incomplete. Review the available entries, then choose Continue classification.',
  '已分类 {count} / {total} 条 · 已选 {selected} 条': 'Classified: {count} / {total} · Selected: {selected}',
  '日志请求：{id}。checkpoint 阶段不代表写入完成。':
    'Journal request: {id}. The checkpoint phase does not establish write completion.',
  任务和跳过项详情: 'Task and skipped-item details',
  '任务 {id} · {stage} · {phase} · 已映射 {count} 组': 'Task {id} · {stage} · {phase} · Mapped groups: {count}',
  '忽略了 {count} 个未映射字段：{reason}': 'Ignored unmapped fields: {count}; {reason}',
  '跳过了 {count} 个缺少 URL 字段的元素：{reason}': 'Skipped elements without a URL field: {count}; {reason}',
  '{url} · 原始标题：{title} · 原目录：{path} · 来源路径：{sourcePath} · ':
    '{url} · Original title: {title} · Original folder: {path} · Source path: {sourcePath} · ',
  '旧任务缺少此跳过项的原始证据；无法还原 URL/标题/路径。':
    'This legacy task lacks original evidence for the skipped item. Its URL, title and path cannot be reconstructed.',
  '来源 {id}：{reason}': 'Source {id}: {reason}',
  '；保留来源 {id}': '; retained source {id}',
  重新调整分类: 'Adjust classification',
  更改目标或重新分类: 'Change destination or reclassify',
  '取消不想导入的书签，也可以调整标题和存放目录。':
    'Deselect bookmarks you do not want to import. You can also edit titles and destination folders.',
  原始内容详情: 'Original content details',
  'AI 锁定': 'AI locked',
  原文: 'Source text',
  '原始标题（{kind}）：{title}；原目录：{path}': 'Original title ({kind}): {title}; original folder: {path}',
  '来源 {id} · {format} · {path} · UTF-16 [{start}, {end})':
    'Source {id} · {format} · {path} · UTF-16 [{start}, {end})',
  书签标题: 'Bookmark title',
  '明确编辑标题 {id}': 'Edit title for source {id}',
  存放目录: 'Destination folder',
  '明确调整目标 {id}': 'Change destination for source {id}',
  请选择目标: 'Choose a destination',
  '所选 {selected}；实际新建书签 {bookmarks}；所需目录 {folders}':
    'Selected: {selected}; new bookmarks: {bookmarks}; required folders: {folders}',
  '确认后将添加这些书签到浏览器。写入前会自动备份，请核对所选内容。':
    'Confirmation adds these bookmarks to the browser. A backup is saved before writing. Check your selection first.',
  查看即将创建的书签和目录: 'View bookmarks and folders to be created',
  '冻结步骤 {id}：{details}': 'Frozen step {id}: {details}',
  '{title} · {url} · 目标 {parent} · 依赖 {dependencies}':
    '{title} · {url} · Destination {parent} · Dependencies {dependencies}',
  新目录: 'New folder',
  '检查完成后点击下一步，系统会核对重复项和目标目录。':
    'After reviewing, choose Next to validate duplicates and destination folders.',
  '请选择已勾选条目的目标，或取消勾选；空目标草稿不会发送预览请求。':
    'Choose a destination for selected entries, or deselect them. Drafts with an empty destination do not send a preview request.',
  '预览已核对，请确认导入。': 'Preview validated. Confirm to import.',
  '所选内容已存在，无需导入。': 'The selected content already exists. No import is needed.',
  '下一步：确认导入': 'Next: confirm import',
  '已拒绝且持久任务确认未交接；请重新校验预览。':
    'Rejected. The saved task confirms no handoff occurred. Validate the preview again.',
  '结果不确定；保留同一请求，读取恢复日志核对，禁止重新创建。':
    'Outcome uncertain. Keep the same request and check the recovery journal. Do not create it again.',
  '已交接日志；请根据实际状态及回执核对。': 'Handed to the journal. Verify the actual status and receipts.',
  确认并导入书签: 'Confirm and import bookmarks',
  '读取同一请求结果（日志去重，不新建请求）': 'Read the same request’s result (journal deduplication, no new request)',
  '请求 {id}：{status}；原因 {reason}；完成 {completed}，剩余 {remaining}；{verification}。':
    'Request {id}: {status}; reason: {reason}; completed: {completed}, remaining: {remaining}; {verification}.',
  '需要核对，禁止盲目重试': 'verification required; do not retry blindly',
  以日志回执为准: 'use journal receipts as evidence',
  '选择下一个书签文件，读取完成后点击下一步。':
    'Choose the next bookmark file, then select Next after it has been read.',
  导入另一个文件: 'Import another file',
  支持的文件与导入说明: 'Supported files and import details',
  '支持 HTML、JSON、CSV、TXT、Markdown；不支持 Excel/PDF。文件编码为 UTF-8（可带 BOM）或带 BOM 的 UTF-16。只添加 HTTP(S) 链接，不修改已有书签；AI 会重新分类，不保留旧目录结构。':
    'Supports HTML, JSON, CSV, TXT and Markdown, but not Excel or PDF. Encoding must be UTF-8 (with optional BOM) or UTF-16 with BOM. Only HTTP(S) links are added; existing bookmarks are not modified. AI reclassifies entries rather than retaining the old folder structure.',
} as const;
