import { translate, translateKnown, type Language, type MessageKey } from '../ui/i18n';

// Adapter for the controller's existing internal status strings. No model/user/native title text is translated.
const counts: { pattern: RegExp; key: MessageKey; names: string[] }[] = [
  {
    pattern: /^服务繁忙，(\d+) 秒后重试（(\d+)\/3），可随时取消。$/,
    key: '服务繁忙，{seconds} 秒后重试（{attempt}/3），可随时取消。',
    names: ['seconds', 'attempt'],
  },
  {
    pattern: /^正在比较 (\d+) 条候选书签…找不到时可尝试深度搜索。$/,
    key: '正在比较 {count} 条候选书签…找不到时可尝试深度搜索。',
    names: ['count'],
  },
  {
    pattern: /^深度搜索：已检查 (\d+) \/ (\d+) 条，正在比较相关结果…$/,
    key: '深度搜索：已检查 {count} / {total} 条，正在比较相关结果…',
    names: ['count', 'total'],
  },
  {
    pattern: /^AI 找到 (\d+) 条相关书签$/,
    key: 'AI 找到 {count} 条相关书签',
    names: ['count'],
  },
];
export function searchStatusText(language: Language, text: string): string {
  if (language === 'zh-CN') return text;
  const failure = 'AI 搜索未完成，保留已找到的结果。';
  const legacyFailure = 'AI 搜索未完成，保留本地结果。';
  const cached = ' 仍可搜索上次读取的数据。';
  if (text.startsWith(failure))
    return translate(language, 'AI 搜索未完成，保留已找到的结果。{reason}', {
      reason: translateKnown(language, text.slice(failure.length)),
    });
  if (text.startsWith(legacyFailure))
    return translate(language, 'AI 搜索未完成，保留本地结果。{reason}', {
      reason: translateKnown(language, text.slice(legacyFailure.length)),
    });
  if (text.endsWith(cached))
    return translate(language, '{reason} 仍可搜索上次读取的数据。', {
      reason: translateKnown(language, text.slice(0, -cached.length)),
    });
  for (const { pattern, key, names } of counts) {
    const match = pattern.exec(text);
    if (match) return translate(language, key, Object.fromEntries(names.map((name, i) => [name, match[i + 1]!])));
  }
  return translateKnown(language, text);
}
