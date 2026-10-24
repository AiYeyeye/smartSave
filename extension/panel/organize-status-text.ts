import { translate, translateKnown, type Language, type MessageKey } from '../ui/i18n';

// Display adapter for owned status strings. It does not change persisted state or request authority.
const counts: { pattern: RegExp; key: MessageKey; names: string[] }[] = [
  {
    pattern: /^方案已生成，共 (\d+) 项建议；请核对后点击“下一步：确认操作”。$/,
    key: '方案已生成，共 {count} 项建议；请核对后点击“下一步：确认操作”。',
    names: ['count'],
  },
  {
    pattern: /^AI 正在分析 (\d+) 项内容，生成整理方案…$/,
    key: 'AI 正在分析 {count} 项内容，生成整理方案…',
    names: ['count'],
  },
  {
    pattern: /^服务繁忙，(\d+) 秒后重试（(\d+)\/3），可随时取消。$/,
    key: '服务繁忙，{seconds} 秒后重试（{attempt}/3），可随时取消。',
    names: ['seconds', 'attempt'],
  },
  {
    pattern: /^服务繁忙，(\d+) 秒后重试（(\d+)\/3），可随时暂停。$/,
    key: '服务繁忙，{seconds} 秒后重试（{attempt}/3），可随时暂停。',
    names: ['seconds', 'attempt'],
  },
  {
    pattern: /^只整理当前目录直接收藏的 (\d+) 条书签，沿用现有分类；确认后开始分析，子目录内容保持原位。$/,
    key: '只整理当前目录直接收藏的 {count} 条书签，沿用现有分类；确认后开始分析，子目录内容保持原位。',
    names: ['count'],
  },
  {
    pattern: /^等待连接、后续流数据或完整非流式响应超过 (\d+) 秒，请重试。$/,
    key: '等待连接、后续流数据或完整非流式响应超过 {seconds} 秒，请重试。',
    names: ['seconds'],
  },
  {
    pattern: /^正在补问 (\d+) 条书签（仅此一轮）；有效建议保持不变，服务繁忙时仍按既有限次策略重试。$/,
    key: '正在补问 {count} 条书签（仅此一轮）；有效建议保持不变，服务繁忙时仍按既有限次策略重试。',
    names: ['count'],
  },
  {
    pattern: /^正在生成第 (\d+) \/ (\d+) 批建议（(\d+) 条书签）…$/,
    key: '正在生成第 {batch} / {total} 批建议（{count} 条书签）…',
    names: ['batch', 'total', 'count'],
  },
  {
    pattern: /^第 (\d+) 批已完成，可先查看下方分类预览和详细建议。$/,
    key: '第 {batch} 批已完成，可先查看下方分类预览和详细建议。',
    names: ['batch'],
  },
];
export function organizeStatusText(language: Language, text: string): string {
  if (language === 'zh-CN') return text;
  // Legacy notices combine owned prose and arbitrary native titles. Use a localized summary
  // instead of parsing/re-translating those titles or exposing Chinese UI fragments in English.
  if (
    /^(当前方案|这项整理任务)已失效，因为[\s\S]+。请重新生成(?:方案)?；未修改书签。$/.test(text) ||
    /^整理期间[\s\S]+，本次结果已失效。请重新生成方案；未修改书签。$/.test(text)
  ) return translate(language, '书签或设置已变化，当前方案已失效。请重新生成；未修改书签。');
  for (const { pattern, key, names } of counts) {
    const match = pattern.exec(text);
    if (match) return translate(language, key, Object.fromEntries(names.map((name, i) => [name, match[i + 1]!])));
  }
  const complete =
    /^全部 (\d+) 批已完成，已核对 (\d+) 条书签。(请检查整体分类和所选建议后再确认执行。|没有需要应用的操作。)$/.exec(
      text,
    );
  if (complete)
    return translate(language, '全部 {batches} 批已完成，已核对 {count} 条书签。{next}', {
      batches: complete[1]!,
      count: complete[2]!,
      next: translateKnown(language, complete[3]!),
    });
  const retained = /^(.*) 已保留 (\d+) 批结果，可继续未完成批次。未修改书签。$/.exec(text);
  const contentRetained = /^(.*) 已完成的分析已保留，可继续未完成批次。未修改书签。$/.exec(text);
  if (contentRetained)
    return translate(language, '{reason} 已完成的分析已保留，可继续未完成批次。未修改书签。', {
      reason: translateKnown(language, contentRetained[1]!),
    });
  if (retained)
    return translate(language, '{reason} 已保留 {count} 批结果，可继续未完成批次。未修改书签。', {
      reason: translateKnown(language, retained[1]!),
      count: retained[2]!,
    });
  const result =
    /^(completed|partial|failed|unknown|cancelled|rejected)：已完成 (\d+) 步，未完成 (\d+) 步。(结果未知，请在备份与恢复中核对；不自动重放。|可在备份与恢复中预览安全撤销。)$/.exec(
      text,
    );
  if (result)
    return translate(language, '{status}：已完成 {completed} 步，未完成 {remaining} 步。{next}', {
      status: result[1]!,
      completed: result[2]!,
      remaining: result[3]!,
      next: translateKnown(language, result[4]!),
    });
  const unchanged = ' 未修改书签。';
  if (text.endsWith(unchanged))
    return organizeStatusText(language, text.slice(0, -unchanged.length)) + translate(language, ' 未修改书签。');
  return translateKnown(language, text);
}

/** The prefix is generated locally; the remainder contains native/model content and stays literal. */
export function organizePreviewText(language: Language, text: string): string {
  if (language === 'zh-CN') return text;
  const prefix = /^(新建目录|移动|合并目录|删除|重命名分类)：([\s\S]*)$/.exec(text);
  return prefix
    ? translate(language, '{action}：{content}', { action: translateKnown(language, prefix[1]!), content: prefix[2]! })
    : text;
}
