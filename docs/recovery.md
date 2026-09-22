# Recovery and safe rollback (browser/P3 validation NOT RUN)

Native bookmarks are authoritative. Backups, receipts and unknown outcomes are extension-local evidence, not a second bookmark library. Never delete logs, clear IndexedDB, uninstall or replay an old request to make an error disappear. Native multi-step calls are not atomic; a timeout is not proof of failure or success.

## Interrupted or partial operations
1. Stop starting new tasks. `停止尚未发起步骤` / `停止未发起步骤` stops only calls not yet issued, not calls already in progress.
2. In recovery, click `读取恢复记录`, then `核对当前状态（不重放）`. Preserve request ID, timestamps, shown status, receipt count and sanitized screenshots. Inspect the browser bookmark manager without editing evidence away.
3. Unknown attempts remain unknown. `人工核对后隔离未知尝试` requires explicit risk confirmation: it does not declare success/failure, adopt a matching URL, remove duplicates or resume remaining steps. It retains evidence and allows only fresh independent previews after other blockers are resolved.
4. Backup/storage failure before issuance means no native writes for that attempt. Storage failure after issuance may leave partial/unknown effects. Do not infer an entire batch was rolled back.

## Undo, merge and copies
`预览撤销本批次` checks receipts and current state. Later-edited/conflicting items are skipped with reasons; unchanged peers may proceed. `独立预览合并恢复` preserves current content and proposes missing eligible content instead of overwriting the current tree. Placement must be provable, not merely an old numeric index. Review skipped coverage even when the executed subplan completed.

`恢复为新副本（可能重复）` requires explicit source subtree selection and a current destination, then `预览新副本`. It may duplicate content and does not restore source identity. For any recovery, inspect the proposal/conflicts, check `确认以上影响范围`, then `应用恢复预览`; `取消预览` discards authority. A restart or changed tree requires fresh preview, never reuse stale confirmation.

`清理恢复快照` is optional and destructive to undo/backup capability. The owner refuses unknown, quarantined, referenced and recovery records; eligible cleanup retains deduplication tombstones. There is no automatic “keep five” policy. Keep all recovery evidence while investigating.

## Automatic JSON output is separate
Use `停止自动输出` before changing installation or diagnosing a file error. Stop invalidates configuration leases across pages even without a configured target; a delayed page cannot re-enable with an old lease. A command receipt means accepted at a checked revision, not that a file write completed. Refresh durable status and last success.

For lost permission use the visible-page `重新授权并补写当前快照` gesture. Scope invalidation requires selecting current roots, never whole-tree fallback. Dedicated external edits are overwritten on the next authorized update. An already-issued close cannot be retracted: file writes and IDB success records are not atomic. Never claim browser-closed updates or permanent authorization.

## Upgrade / rollback
Stop new work and output, preserve the original candidate inventory and profile evidence, and keep the unpacked extension path/ID stable when testing reload. Unknown database versions fail closed: do not force-open or downgrade schemas. If the prior build cannot read retained evidence, stop and ask the owner rather than wipe it. Uninstall loses extension-local recovery data and credentials; it is not a rollback strategy. Existing native bookmarks and external output files must not be deleted.

All above is source-backed behavior in `RecoveryWorkbench.tsx`, coordinator recovery services and file-output owners, covered by synthetic tests. Since 2026-09-22 new journal records store per-step SHA-256 digests, the changed-node delta and one final snapshot per batch instead of three full trees per step; older records remain readable and recoverable without migration. Chrome/Edge interruption, restart, permissions, external edits, quotas and actual FileSystemHandle behavior still require isolated, explicitly authorized P1/P3 manual evidence.
