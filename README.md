
# 智栏 · Markora

- [产品需求 PRD 1.0](docs/PRD-1.0.md)
- [完整首版 Trellis 任务树（planning）](.trellis/tasks/09-08-zhilan-v1-development/README.md)：1 父任务＋12 子任务，尚未启动正式实现。
- [四风格交互原型](ui/prototype/README.md)
- [用户 P1 有界实测证据](.trellis/tasks/09-08-zhilan-technical-validation-design/research/p1-user-evidence-2026-09-08.md)：当前 Chrome 环境无实验页写入成功；重启与 Edge 等仍待验证。

## Isolated technical experiment

[智栏 P1 文件访问实验](experiments/file-access-probe/README.md) — unpacked MV3, synthetic JSON only. Real Chrome/Edge feasibility remains pending; not the production extension.

### Task10 import integration status
The production panel now exposes a retained Import workbench, real parse Worker/client and existing classification/checkpoint/import-authority/journal owners. See `extension/README.md` and `.trellis/tasks/09-08-zhilan-v1-10-import/validation.md`. Whole10 acceptance is **incomplete**: UI lifecycle matrix and independent review remain; browser/native/provider/user-file/P1–P4 are NOT RUN. Task11 is not implemented by this change.

## UI acceptance repair iteration (2026-09-09; NOT COMPLETE)
Implemented controller-owned rejection/durable reread vs uncertain handoff states, identifiable skipped source evidence, selected destination binding through compiler/authority/journal, frozen controller command display, and import-only missing-title suggestions. Added actual-owner UI handoff/mapping/manual-load/empty/all-existing tests; preserved the shared persistence owner.
Final source checks: lint/typecheck pass; units 434/434 in 49 files (--maxWorkers=2, 61.66s); integration 6/6; build/static MV3 pass. Earlier focused43 and full428 passed. New lifecycle fixture initially had optional native title type errors and late teardown callback rejection, then a generated multiline quote parse failure and duplicate text assertion mismatch; corrected and final full run green. Existing Vite chunk/config warnings remain.
Still incomplete: actual UI all-batches/pause/resume/recover-epoch/root/privacy/cancel/quota/partial acceptance matrix; status/error UX and draft initialization architecture need independent review. Page-memory drafts do not survive an actual browser page reload. This iteration must not be accepted as whole10 completion. Browser/native/provider/user-file/P1–P4/manual NOT RUN. No stage/commit/archive/task11/probes/publish.

## Task11 production export source update
Panel/options expose retained ExportSettings: independent roots/exclusions, manual JSON/HTML/Markdown and dedicated automatic JSON consent, gesture picker/reauthorization, same-origin IDB handles and worker-only auto writes. Refresh shows durable status; invalid roots require reselection. Final source checks:509 unit,6 integration, lint/typecheck/build pass. See `.trellis/tasks/09-08-zhilan-v1-11-export/validation.md`. Synthetic tests are not real handle proof. Chrome153 historical success/prompt-no-write evidence preserved; remaining Chrome restart/reliability and Edge no-page/restart NOT RUN. Independent review/manual acceptance open; no task12/release claim.
