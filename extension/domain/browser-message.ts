import fallback from '../public/_locales/zh_CN/messages.json';
import english from '../public/_locales/en/messages.json';
import { LANGUAGE_KEY, type Language } from '../ui/preferences';

let language: Language = 'zh-CN';
const listeners = new Set<() => void>();
export function setBrowserLanguage(value: unknown) {
  const next = value === 'en' ? 'en' : 'zh-CN';
  if (language === next) return;
  language = next;
  for (const listener of listeners) listener();
}
export function onBrowserLanguageChange(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Worker/content contexts cannot read extension localStorage. Observe its language-only mirror. */
export function watchBrowserLanguage() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local || !chrome.storage?.onChanged) return () => {};
  let revision = 0;
  let disposed = false;
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !Object.hasOwn(changes, LANGUAGE_KEY)) return;
    revision++;
    setBrowserLanguage(changes[LANGUAGE_KEY]?.newValue);
  };
  chrome.storage.onChanged.addListener(changed);
  void chrome.storage.local.get(LANGUAGE_KEY).then(values => {
    if (!disposed && revision === 0) setBrowserLanguage(values[LANGUAGE_KEY]);
  }).catch(() => {});
  return () => {
    disposed = true;
    chrome.storage.onChanged.removeListener(changed);
  };
}
/** Runtime labels follow the selected app language; absent preferences default to Chinese. */
export function browserMessage(key: keyof typeof fallback, substitutions: string[] = []): string {
  const catalog = language === 'en' ? english : fallback;
  return catalog[key].message.replace(/\$([1-9])/g, (_, index: string) => substitutions[Number(index) - 1] ?? '');
}
