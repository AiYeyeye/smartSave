import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { english, type MessageKey } from './catalog';
import { LANGUAGE_KEY, type Language } from '../preferences';
import { synchronizePreference } from '../preferences-sync';
export type { MessageKey } from './catalog';
export type { Language } from '../preferences';
export { LANGUAGE_KEY } from '../preferences';
type Values = Record<string, string | number>;
export function translate(language: Language, key: MessageKey, values: Values = {}): string {
  const template = language === 'en' ? english[key] : key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}
/** For existing internal status strings only; never call this on bookmark titles or user/model text. */
export function translateKnown(language: Language, message: string): string {
  return Object.hasOwn(english, message) ? translate(language, message as MessageKey) : message;
}
const parse = (value: string | null): Language => (value === 'en' ? 'en' : 'zh-CN');
function readLanguage(): Language {
  try {
    return parse(localStorage.getItem(LANGUAGE_KEY));
  } catch {
    return 'zh-CN';
  }
}
const LocaleContext = createContext<{ language: Language; choose: (language: Language) => void; saved: boolean }>({
  language: 'zh-CN' as Language,
  choose: () => {},
  saved: true,
});
export function LocaleProvider({ children }: PropsWithChildren) {
  const [language, setLanguage] = useState(readLanguage);
  const [saved, setSaved] = useState(true);
  useEffect(() => {
    const listener = (event: StorageEvent) => {
      if (event.key === LANGUAGE_KEY || event.key === null) {
        setLanguage(event.key === null ? 'zh-CN' : parse(event.newValue));
        setSaved(true);
      }
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = translate(language, '智栏 · 书签助手');
  }, [language]);
  const value = useMemo(
    () => ({
      language,
      saved,
      choose: (next: Language) => {
        setLanguage(next);
        try {
          localStorage.setItem(LANGUAGE_KEY, next);
          synchronizePreference('language', next);
          setSaved(true);
        } catch {
          setSaved(false);
        }
      },
    }),
    [language, saved],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
export function useI18n() {
  const context = useContext(LocaleContext);
  return useMemo(
    () => ({
      ...context,
      t: (key: MessageKey, values?: Values) => translate(context.language, key, values),
      message: (text: string) => translateKnown(context.language, text),
    }),
    [context],
  );
}
export function LanguagePicker() {
  const { language, choose, saved, t } = useI18n();
  return (
    <fieldset>
      <legend>{t('语言')}</legend>
      <select aria-label={t('语言')} value={language} onChange={event => choose(parse(event.target.value))}>
        <option value="zh-CN" lang="zh-CN">
          简体中文
        </option>
        <option value="en" lang="en">
          English
        </option>
      </select>

      <p className="hint">
        {t('仅同步语言、明暗模式和主题色；服务密钥、网址、目录规则和书签关键词保留在本机。同步不可用时仍可正常使用。')}
      </p>
      {!saved && <p role="status">{t('语言已切换，但无法保存。重新打开后可能恢复默认语言。')}</p>}
    </fieldset>
  );
}
