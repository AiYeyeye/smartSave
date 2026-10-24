# 恢复与撤销 / Recovery and undo

书签保存在浏览器中。智栏的备份和操作记录用于核对、撤销或恢复修改。操作超时可能留下部分修改；遇到“结果未知”时，先停止新操作，保留恢复记录。

Bookmarks remain in your browser. Zhilan uses backups and operation records to reconcile, undo or recover changes. A timeout may leave partial changes. If an outcome is unknown, stop new operations and preserve the recovery records.

## 操作中断或结果未知 / Interrupted or unknown operations

在 **设置 → 导出与备份 → 备份与恢复记录** 中查看：

1. **撤销最近操作**：查看已完成的操作，预览可以撤销的修改。
2. **需要你处理**：点击“核对当前状态（不重放）”，核对已发起步骤的结果；“刷新恢复记录”可重新读取状态。
3. “停止未发起步骤”只停止尚未发起的步骤，已开始的写入仍可能完成。
4. 若核对后仍未知，可在人工检查书签后选择“人工核对后隔离”，并确认影响。隔离保留记录，不会自动补做剩余步骤，也不代表成功或失败。

Open **Settings → Export & backup → Backup and recovery records**:

1. **Undo recent operations** lists completed operations and offers an undo preview.
2. **Needs your attention** offers reconciliation of the current state without replaying writes. Refresh the records to reread the status.
3. Stopping unstarted steps does not cancel writes already issued.
4. If reconciliation cannot resolve an outcome, inspect the native bookmarks before choosing manual quarantine and confirming its impact. Quarantine retains the record without declaring success, failure or resuming remaining steps.

不要重复提交旧操作、清空存储或卸载扩展来处理未知结果。需要帮助时提供请求编号、时间、错误码及脱敏截图，见 [问题反馈](../../SUPPORT.md)。

Do not resubmit the old operation, clear storage or uninstall to resolve an unknown outcome. For help, provide the request ID, time, error code and sanitized screenshots; see [Support](../../SUPPORT.md).

## 撤销、合并恢复与新副本 / Undo, merge and copies

先点击“预览撤销”，检查影响范围和跳过原因，再确认应用。后来被修改、移动或发生冲突的条目可能跳过。重启或书签发生变化后，需要重新预览。

“高级”中提供：

- **合并恢复**：保留当前内容，补回能够确认位置的缺失内容。
- **恢复为新副本**：选择来源子树和当前目标目录，预览并确认；可能产生重复内容。
- **清理恢复快照**：删除符合条件的快照，会减少可撤销和恢复的内容。未知、隔离、被引用或恢复操作的记录不能按普通快照清理。

Preview undo, inspect the scope and skipped items, then confirm. Items edited, moved or conflicting with later changes may be skipped. Restarting or changing bookmarks requires a fresh preview.

The **Advanced** section offers:

- **Merge recovery:** preserve current content and restore eligible missing items where placement can be established.
- **Restore as a new copy:** select a source subtree and current destination, review and confirm. This may create duplicates.
- **Clean recovery snapshots:** remove eligible snapshots, reducing available undo and recovery. Unknown, quarantined, referenced and recovery records are protected from ordinary snapshot cleanup.

## 自动 JSON 输出 / Automatic JSON output

更换安装目录或排查文件问题前，先“停止自动输出”。丢失文件权限时，在可见页面点击“重新授权并补写当前快照”；范围失效时重新选择目录。检查持久化状态和最近成功时间，接受命令不等于文件已经写完。

自动输出会覆盖专用文件中的外部修改，已开始的文件关闭操作不能撤回。浏览器关闭期间不会更新文件，文件授权也可能失效。

Stop automatic output before changing the installation path or diagnosing file errors. If permission is lost, reauthorize from a visible page and write the current snapshot. Select folders again if the scope becomes invalid. Check durable status and the last successful update; command acceptance does not mean the file write has finished.

Automatic output overwrites external edits to its dedicated file. An issued file close cannot be retracted. Updates stop while the browser is closed, and file permission may expire.

## 更新与回退 / Update and rollback

更新前停止新操作及自动输出，保留需要的备份，保持加载目录和扩展 ID 稳定。旧版本无法读取数据时不要强制降级或清空数据库。卸载会删除扩展设置、凭据及恢复记录，不能用作回退；原生书签和已导出文件需分别管理。

Before updating, stop new operations and automatic output, preserve needed backups, and keep the unpacked path and extension ID stable. If an older version cannot read the data, do not force a downgrade or clear the database. Uninstalling removes extension settings, credentials and recovery records; it is not a rollback method. Native bookmarks and exported files are managed separately.
