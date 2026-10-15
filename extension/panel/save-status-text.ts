import { translate, translateKnown, type Language } from '../ui/i18n';

/** Render only UI-owned save statuses. Provider details remain literal. */
export function saveStatusText(language: Language, text: string): string {
  const failure = /^AI未完成：(.*)；(可检查配置后重试。|可手动收藏。)$/s.exec(text);
  if (failure) {
    return translate(
      language,
      failure[2] === '可手动收藏。' ? 'AI未完成：{reason}；可手动收藏。' : 'AI未完成：{reason}；可检查配置后重试。',
      { reason: failure[1]! },
    );
  }
  return translateKnown(language, text);
}
