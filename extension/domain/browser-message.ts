import fallback from '../public/_locales/zh_CN/messages.json';

/** Browser-owned surfaces follow Chrome's UI locale, independently of the in-page language choice. */
export function browserMessage(key: keyof typeof fallback, substitutions: string[] = []): string {
  const localized = typeof chrome !== 'undefined' ? chrome.i18n?.getMessage(key, substitutions) : undefined;
  return (
    localized ||
    fallback[key].message.replace(/\$([1-9])/g, (_, index: string) => substitutions[Number(index) - 1] ?? '')
  );
}
