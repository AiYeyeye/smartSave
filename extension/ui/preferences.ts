export const LANGUAGE_KEY = 'zhilan.language';
export const APPEARANCE_KEY = 'zhilan.appearance';
export const preferenceValues = {
  language: ['zh-CN', 'en'],
  mode: ['system', 'light', 'dark'],
  accent: ['indigo', 'blue', 'teal', 'amber', 'rose', 'graphite'],
} as const;
export type Preference = keyof typeof preferenceValues;
export type PreferenceValue<K extends Preference> = (typeof preferenceValues)[K][number];
export type Language = PreferenceValue<'language'>;
export type ThemeMode = PreferenceValue<'mode'>;
export type Accent = PreferenceValue<'accent'>;
export type Appearance = { mode: ThemeMode; accent: Accent };
export const DEFAULT_APPEARANCE: Appearance = { mode: 'system', accent: 'indigo' };

export function validPreference<K extends Preference>(key: K, value: unknown): value is PreferenceValue<K> {
  return typeof value === 'string' && preferenceValues[key].some(candidate => candidate === value);
}

export function readAppearance(): Appearance {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return DEFAULT_APPEARANCE;
    return {
      mode: 'mode' in parsed && validPreference('mode', parsed.mode) ? parsed.mode : DEFAULT_APPEARANCE.mode,
      accent:
        'accent' in parsed && validPreference('accent', parsed.accent) ? parsed.accent : DEFAULT_APPEARANCE.accent,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}
