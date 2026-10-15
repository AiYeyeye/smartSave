import { translate, translateKnown, type Language, type MessageKey } from '../../ui/i18n';

/** Existing UI-owned notifications, translated on render so a locale change cannot restart an operation. */
const patterns: { pattern: RegExp; key: MessageKey; field: string }[] = [
  {
    pattern: /^已导入 (\d+) 个服务（不含密钥，请重新填写）$/,
    key: '已导入 {count} 个服务（不含密钥，请重新填写）',
    field: 'count',
  },
  {
    pattern: /^未能获取模型列表：(.*)。仍可手填模型 ID。$/s,
    key: '未能获取模型列表：{reason}。仍可手填模型 ID。',
    field: 'reason',
  },
  { pattern: /^未能获取模型列表：(.*)$/s, key: '未能获取模型列表：{reason}', field: 'reason' },
  {
    pattern: /^已获取 (\d+) 个模型；尚未验证生成能力$/,
    key: '已获取 {count} 个模型；尚未验证生成能力',
    field: 'count',
  },
  { pattern: /^合成分类测试通过：(.*)$/s, key: '合成分类测试通过：{model}', field: 'model' },
  { pattern: /^分类测试失败：(.*)$/s, key: '分类测试失败：{reason}', field: 'reason' },
  { pattern: /^配置完成：收藏会用 (.*) 自动归类$/s, key: '配置完成：收藏会用 {model} 自动归类', field: 'model' },
];
export function serviceStatusText(language: Language, text: string): string {
  if (language === 'zh-CN') return text;
  for (const { pattern, key, field } of patterns) {
    const match = pattern.exec(text);
    if (match) return translate(language, key, { [field]: match[1]! });
  }
  return translateKnown(language, text);
}
