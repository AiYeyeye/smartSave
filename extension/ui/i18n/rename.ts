export const renameEnglish = {
  'AI 学习规则': 'AI learned rule',
  已启用偏好: 'Active preference',
  书签名称: 'Bookmark name',
  原名称: 'Original name',
  '未建议改名，保留原名': 'No rename suggested; original name kept',
  书签名称已更新: 'Bookmark name updated',
  停止: 'Stop',
  'AI 书签改名': 'AI bookmark renaming',
  '预览名称建议，确认后优化书签名称。': 'Review suggested names and confirm to rename bookmarks.',
  'AI 名称建议': 'AI name suggestion',
  采用名称: 'Apply name',
  保留原名: 'Keep original',
  已保留原名: 'Original name kept',
  待确认名称: 'Names awaiting review',
  '选择目录，预览并修改名称建议，确认后才改名。使用整理模型，不读取网页正文。':
    'Choose a folder, review and edit suggestions, then confirm renaming. Uses the organize model and does not read webpage contents.',
  选择目录: 'Choose folder',
  生成名称建议: 'Suggest names',
  '正在生成名称建议…': 'Generating name suggestions…',
  '已生成 {done} / {total} 条名称建议': '{done} / {total} name suggestions generated',
  '名称建议已生成，请核对后确认。': 'Suggestions are ready. Review them before confirming.',
  名称建议未完成: 'Name suggestions did not complete',
  '名称建议已失效，请重新生成；已提交操作请查看恢复记录。':
    'Suggestions are no longer valid. Generate again; check recovery records for submitted operations.',
  '已停止，已生成建议保留。': 'Stopped. Completed suggestions are retained.',
  建议名称: 'Suggested name',
  '信息不足，保留原名': 'Insufficient information; keep original',
  预览改名确认: 'Review renaming',
  '已选 {count} 条待改名书签': '{count} bookmarks selected for renaming',
  '当前没有需要应用的改名。可以编辑建议名称并勾选条目，再预览确认。':
    'No renames are selected. Edit a suggested name and select its row to review and confirm a change.',
  确认改名: 'Confirm renaming',
  '将修改 {count} 条书签名称，网址和目录保持不变。': 'Rename {count} bookmarks. URLs and folders stay the same.',
  '仅实际修改名称或分类才会后台学习；直接同意 AI 建议不触发。':
    'Only actual edits to names or destinations trigger background learning. Accepting AI suggestions unchanged does not.',
  '后台学习：等待 {queued} · 进行中 {running} · 已完成 {completed} · 未完成 {failed}':
    'Background learning: {queued} queued · {running} running · {completed} completed · {failed} failed',
  '学习未完成不会影响书签修改。请检查整理模型配置；中断任务不会自动重复调用。':
    'Learning failures do not affect bookmark edits. Check the organize model configuration; interrupted tasks are not automatically replayed.',
} as const;
