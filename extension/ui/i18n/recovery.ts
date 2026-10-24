export const recoveryEnglish = {
  确认: 'Confirm',
  '新建的恢复节点会追加到目标目录末尾；不保证还原原来的排列顺序。':
    'Newly restored items are appended to the destination folder. Their original order is not guaranteed.',
  备份与恢复: 'Backup and recovery',
  '收藏、整理与导入的操作记录保存在这里。撤销前先预览影响；结果未知的操作不会自动重试。':
    'Records of saves, organization and imports are kept here. Preview the impact before undoing. Operations with unknown outcomes are not retried automatically.',
  恢复状态: 'Recovery status',
  '恢复资料仅保存在本地，含私人标题与网址；不含模型密钥、正文或摘要。':
    'Recovery data is stored locally and contains private titles and URLs. It does not contain model keys, page bodies or summaries.',
  '容量尚未读取；估算不保证写入成功。':
    'Storage usage has not been loaded. Estimates do not guarantee a successful write.',
  '估算使用 {usage} / 配额 {quota} 字节；实际备份事务成功后才可写入。':
    'Estimated usage: {usage} / quota: {quota} bytes. Changes can be written only after the backup transaction succeeds.',
  未知: 'Unknown',
  '已清理恢复快照；保留请求去重记录。': 'Recovery snapshots cleared. Request deduplication records are retained.',
  '传输或响应不可用；写入结果可能未知。请求编号 {id}；刷新并核对日志，不自动重试。':
    'Transport or response unavailable; the write outcome may be unknown. Request: {id}. Refresh and check the journal. No automatic retry.',
  '取消未获确认，请求 {id} 结果仍待核对。':
    'Cancellation was not acknowledged. The outcome of request {id} still needs verification.',
  '正在核对请求 {id}': 'Checking request {id}',
  停止尚未发起步骤: 'Stop remaining steps',
  刷新恢复记录: 'Refresh recovery records',
  撤销最近操作: 'Undo recent operations',
  '撤销只回退有回执的步骤；之后被改动过的项目会跳过并保留现状。':
    'Undo only reverts steps with receipts; items changed since are skipped and kept as they are.',
  '这些操作没有完整回执，请先在书签管理器核对再处理。':
    'These operations lack complete receipts. Check the bookmark manager before acting.',
  '最近 {count} 次已完成的收藏、编辑、移动、删除与整理批次。撤销只回退有回执的步骤；之后被改动过的项目会被跳过并保留现状。':
    'The latest {count} completed saves, edits, moves, deletions and organization batches. Undo reverses only receipted steps. Items changed afterward are skipped and kept as they are.',
  预览撤销: 'Preview undo',
  '暂无可撤销的操作。': 'No operations available to undo.',
  需要你处理: 'Needs your attention',
  '这些操作没有拿到完整回执，扩展不知道浏览器里最终写成了什么。先在书签管理器核对，再决定核对、停止或隔离；隔离只是登记，不代表完成或失败。':
    'These operations lack complete receipts, so their final browser state is unknown. Check the bookmark manager first, then reconcile, stop or quarantine. Quarantine records your acknowledgement; it does not establish success or failure.',
  '结果未知，需人工核对': 'Unknown outcome; manual verification required',
  '原因：{reason}': 'Reason: {reason}',
  '核对当前状态（不重放）': 'Check current state (no replay)',
  停止未发起步骤: 'Stop unissued steps',
  人工核对后隔离: 'Quarantine after manual verification',
  '没有需要处理的异常。': 'No issues need attention.',
  恢复预览: 'Recovery preview',
  '没有可安全应用的项目；当前数据保持不变。': 'No items can be safely applied. Current data stays unchanged.',
  '保留 / 跳过 {id}：{reason}': 'Keep / skip {id}: {reason}',
  确认以上影响范围: 'Confirm the impact shown above',
  取消预览: 'Cancel preview',
  恢复风险确认: 'Recovery risk confirmation',
  '请先在浏览器书签管理器人工核对。隔离不证明完成、失败或没有重复项；不认领或删除任何候选，永不重放此请求及剩余步骤。仅允许重新扫描、预览并确认独立新操作。未知证据继续保留。':
    'Verify manually in the browser bookmark manager first. Quarantine does not establish success, failure or absence of duplicates. It does not adopt or delete candidates, and this request and its remaining steps will never replay. Only newly scanned, previewed and confirmed independent operations may proceed. Unknown evidence is retained.',
  '清理将失去本批次撤销与备份恢复能力。未知及被引用记录不可清理。':
    'Clearing snapshots removes this batch’s undo and backup recovery capability. Unknown or referenced records cannot be cleared.',
  我已核对并理解风险: 'I have verified the situation and understand the risk',
  '高级：合并恢复、副本恢复、清理快照与完整记录': 'Advanced: merge, copy, snapshot cleanup and all records',
  完整恢复记录: 'All recovery records',
  '合并恢复只补回当前缺失且可证明位置的内容；新副本可能产生重复，不会认领原身份；清理快照后本批次不能再撤销或恢复。':
    'Merge recovery restores only missing content whose placement can be proven. New copies may create duplicates and do not adopt original identities. Clearing snapshots removes this batch’s undo and recovery capability.',
  独立预览合并恢复: 'Preview merge recovery',
  '恢复为新副本（可能重复）': 'Restore as new copies (may duplicate)',
  清理恢复快照: 'Clear recovery snapshots',
  '尚无恢复记录。': 'No recovery records yet.',
  副本恢复选择: 'Choose recovery copies',
  '不证明这些节点缺失；不会按路径、标题或网址认领现有节点。源备份只读保留。':
    'This does not prove the items are missing. Existing items are not adopted by path, title or URL. The source backup remains read-only.',
  当前目标目录: 'Current destination folder',
  请选择: 'Choose an option',
  '{title} · {id}（目录包含子树）': '{title} · {id} (folders include descendants)',
  预览新副本: 'Preview new copies',
  撤销影响预览: 'Undo impact preview',
  应用撤销: 'Apply undo',
  合并恢复影响预览: 'Merge recovery impact preview',
  应用合并恢复: 'Apply merge recovery',
  新副本影响预览: 'New copy impact preview',
  应用新副本: 'Apply new copies',
  '恢复为新副本，可能重复；不证明缺失，不认领原身份。':
    'Restore as new copies, which may duplicate existing items. This does not prove absence or adopt original identities.',
  '仅应用预览中的安全项；冲突保留当前数据。':
    'Apply only the safe items in this preview. Conflicting items keep their current data.',
  '{status} · {receipts}/{steps} 步有回执 · 请求 {id}': '{status} · Receipted steps: {receipts}/{steps} · Request {id}',
  收藏: 'Save',
  整理批次: 'Organization batch',
  导入批次: 'Import batch',
  批量操作: 'Batch operation',
  恢复操作: 'Recovery operation',
  已完成: 'Completed',
  部分完成: 'Partially completed',
  失败: 'Failed',
  已拒绝: 'Rejected',
  结果未知: 'Unknown outcome',
  '中断，需核对': 'Interrupted; verification required',
  '{status} · 已人工隔离（仍未知）': '{status} · Manually quarantined (still unknown)',
  '时间未知（旧版记录）': 'Time unknown (legacy record)',
  新建: 'Create',
  修改: 'Update',
  未发起: 'Not issued',
  '已发起，未确认': 'Issued, not confirmed',
  有回执: 'Receipted',
  '{action}：{state}{identity}': '{action}: {state}{identity}',
  '，ID {id}': ', ID {id}',
  '新建「{title}」{url} → 目录 {parent}': 'Create “{title}”{url} → folder {parent}',
  '新建目录「{folder}」并收藏「{title}」（{url}） → 目录 {parent}':
    'Create folder “{folder}” and save “{title}” ({url}) → folder {parent}',
  '标题改为「{value}」': 'title to “{value}”',
  '网址改为「{value}」': 'URL to “{value}”',
  '修改 {id}：{changes}': 'Update {id}: {changes}',
  '移动 {id} → 目录 {parent} 第 {index} 位': 'Move {id} → folder {parent}, position {index}',
  '删除 {id}': 'Delete {id}',
  '删除子树 {id}': 'Delete subtree {id}',
  '恢复覆盖范围未知（旧版记录），不代表完整恢复。':
    'Recovery coverage is unknown for this legacy record; this does not establish full restoration. ',
  '恢复未完整：保留 / 跳过 {count} 项；{details}。':
    'Restoration incomplete: kept / skipped items: {count}; {details}. ',
  '恢复预览无跳过项。': 'The recovery preview has no skipped items. ',
  '{id}：执行子计划 {status}；已完成 {completed}，剩余 {remaining}；{reason}。{coverage}未知结果不会自动重试。':
    'Request {id}: execution subplan {status}; completed: {completed}, remaining: {remaining}; details: {reason}. {coverage}Unknown outcomes are not retried automatically.',
} as const;
