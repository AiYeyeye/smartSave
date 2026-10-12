import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type Accent = 'indigo' | 'blue' | 'teal' | 'amber' | 'rose' | 'graphite';
export type Appearance = { mode: ThemeMode; accent: Accent };

export const modes: { id: ThemeMode; name: string; icon: typeof Sun }[] = [
  { id: 'system', name: '跟随系统', icon: Monitor },
  { id: 'light', name: '浅色', icon: Sun },
  { id: 'dark', name: '深色', icon: Moon },
];
export const accents: { id: Accent; name: string; swatch: string }[] = [
  { id: 'indigo', name: '靛紫', swatch: '#5b5bd6' },
  { id: 'blue', name: '海蓝', swatch: '#2563eb' },
  { id: 'teal', name: '青绿', swatch: '#0f8a7e' },
  { id: 'amber', name: '琥珀', swatch: '#c2690a' },
  { id: 'rose', name: '玫红', swatch: '#db2b58' },
  { id: 'graphite', name: '石墨', swatch: '#3a3f4a' },
];

/** Popup and options share one extension origin, so localStorage carries the choice to both pages. */
export const APPEARANCE_KEY = 'zhilan.appearance';
const DEFAULT_APPEARANCE: Appearance = { mode: 'system', accent: 'indigo' };

function readAppearance(): Appearance {
  try {
    const raw = globalThis.localStorage?.getItem(APPEARANCE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    return {
      mode: modes.some(m => m.id === parsed.mode) ? (parsed.mode as ThemeMode) : DEFAULT_APPEARANCE.mode,
      accent: accents.some(a => a.id === parsed.accent) ? (parsed.accent as Accent) : DEFAULT_APPEARANCE.accent,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function writeAppearance(value: Appearance) {
  try {
    globalThis.localStorage?.setItem(APPEARANCE_KEY, JSON.stringify(value));
  } catch {
    /* private mode / blocked storage: keep the in-memory choice */
  }
}

function systemDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

type ThemeContextValue = {
  appearance: Appearance;
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
  setAccent: (accent: Accent) => void;
};
const ThemeContext = createContext<ThemeContextValue | null>(null);
export const THEME_OVERLAY_ID = 'theme-overlay';

export function ThemeProvider({ children }: PropsWithChildren) {
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);
  const [dark, setDark] = useState(systemDark);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setDark(query.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  useEffect(() => {
    // Another extension page changed the appearance.
    const onStorage = (event: StorageEvent) => {
      if (event.key === APPEARANCE_KEY) setAppearance(readAppearance());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const resolved: 'light' | 'dark' = appearance.mode === 'system' ? (dark ? 'dark' : 'light') : appearance.mode;

  useEffect(() => {
    // Match the document canvas (scroll overscroll / popup edges) to the theme.
    document.documentElement.style.colorScheme = resolved;
    document.documentElement.style.background = resolved === 'dark' ? '#0f1013' : '#f4f5f7';
  }, [resolved]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      appearance,
      resolved,
      setMode: mode =>
        setAppearance(previous => {
          const next = { ...previous, mode };
          writeAppearance(next);
          return next;
        }),
      setAccent: accent =>
        setAppearance(previous => {
          const next = { ...previous, accent };
          writeAppearance(next);
          return next;
        }),
    }),
    [appearance, resolved],
  );

  return (
    <ThemeContext.Provider value={value}>
      <div className="theme-root" data-mode={resolved} data-accent={appearance.accent} data-theme={resolved}>
        {children}
        <div id={THEME_OVERLAY_ID} className="theme-overlay" />
      </div>
    </ThemeContext.Provider>
  );
}

export function overlayHost() {
  return document.getElementById(THEME_OVERLAY_ID) ?? document.body;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme requires ThemeProvider');
  return context;
}

export function ModeSwitch({ compact = false }: { compact?: boolean }) {
  const { appearance, setMode } = useTheme();
  return (
    <div className="segmented" role="radiogroup" aria-label="颜色模式">
      {modes.map(({ id, name, icon: Icon }) => (
        <label key={id} title={name}>
          <input
            type="radio"
            name={compact ? 'appearance-mode-compact' : 'appearance-mode'}
            checked={appearance.mode === id}
            onChange={() => setMode(id)}
            aria-label={compact ? `快速切换为${name}` : name}
          />
          <Icon aria-hidden="true" />
          {compact ? null : name}
        </label>
      ))}
    </div>
  );
}

export function AccentPicker({ compact = false }: { compact?: boolean }) {
  const { appearance, setAccent } = useTheme();
  return (
    <div className="swatches" role="radiogroup" aria-label="主题色">
      {accents.map(({ id, name, swatch }) => (
        <label key={id} className="swatch" title={name} style={{ ['--swatch' as string]: swatch }}>
          <input
            type="radio"
            name={compact ? 'appearance-accent-compact' : 'appearance-accent'}
            checked={appearance.accent === id}
            onChange={() => setAccent(id)}
            aria-label={name}
          />
          <i aria-hidden="true" />
          {name}
        </label>
      ))}
    </div>
  );
}

export function ThemePicker() {
  return (
    <div className="appearance">
      <fieldset>
        <legend>颜色模式</legend>
        <ModeSwitch />
      </fieldset>
      <fieldset>
        <legend>主题色</legend>
        <AccentPicker />
      </fieldset>
      <div className="theme-preview" aria-hidden="true">
        <div className="theme-preview-side">
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="theme-preview-main">
          <i style={{ width: '60%' }} />
          <i style={{ width: '85%' }} />
          <i style={{ width: '40%' }} />
          <b />
        </div>
      </div>
      <p className="hint">外观保存在本机浏览器，工具栏弹窗与设置页同步生效。</p>
    </div>
  );
}
