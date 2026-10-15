import type { ImportItem, ImportParseError } from '../import/contracts';
import { translate, translateKnown, type Language } from '../ui/i18n';

export type ImportNotice =
  | string
  | { kind: 'read'; count: number }
  | { kind: 'paused'; reason: string }
  | { kind: 'parse-error'; code: ImportParseError['code']; reason: string }
  | { kind: 'authority-error'; reason: string };

/** Render owned notices without translating imported content or model/transport diagnostics. */
export function importNoticeText(language: Language, notice: ImportNotice): string {
  if (typeof notice === 'string') return translateKnown(language, notice);
  switch (notice.kind) {
    case 'read':
      return translate(language, '文件已读取：{count} 条原始项。点击下一步选择存放目录。', notice);
    case 'paused':
      return translate(language, '已暂停：{reason}。仅保留已提交的进度。', { reason: notice.reason });
    case 'parse-error':
      return `${notice.code}: ${translateKnown(language, notice.reason)}`;
    case 'authority-error':
      return translate(language, '{reason}：请核对目标、任务及恢复日志，再明确恢复或重新校验；不会自动重试。', {
        reason: notice.reason,
      });
  }
}

export function importSourceText(language: Language, item: ImportItem): string {
  return translate(language, '来源 {id} · {url} · {diagnostic} · {provenance} · 原目录 {path}', {
    id: item.sourceOrdinal,
    url: item.rawURL,
    diagnostic: item.diagnostic ?? translate(language, '待分类'),
    provenance: JSON.stringify(item.provenance),
    path: JSON.stringify(item.oldPath),
  });
}
