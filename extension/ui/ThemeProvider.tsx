import { createContext, useContext, useState } from 'react';
import type { PropsWithChildren } from 'react';

export const themes = [
  { id: 'native', name: '轻盈原生' },
  { id: 'paper', name: '温润纸感' },
  { id: 'stationery', name: '清爽文具（默认）' },
  { id: 'precision', name: '深色精密' },
] as const;
type Theme = (typeof themes)[number]['id'];
const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void } | null>(null);

export function ThemeProvider({ children }: PropsWithChildren) {
  // Deliberately page-session only: no storage, URL or system preference source.
  const [theme, setTheme] = useState<Theme>('stationery');
  return <ThemeContext.Provider value={{ theme, setTheme }}>
    <div className="theme-root" data-theme={theme}>{children}</div>
  </ThemeContext.Provider>;
}

export function ThemePicker() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('ThemePicker requires ThemeProvider');
  return <fieldset className="theme-picker"><legend>界面风格</legend>
    {themes.map(({ id, name }) => <label key={id} className="theme-choice">
      <input type="radio" name="appearance" checked={context.theme === id} onChange={() => context.setTheme(id)} />
      <span>{name}</span>
    </label>)}
    <p className="hint">仅在当前页面会话生效；关闭后恢复默认，不同步到其他页面。</p>
  </fieldset>;
}
