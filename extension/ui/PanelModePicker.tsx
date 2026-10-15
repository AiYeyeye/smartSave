import { useEffect, useState } from 'react';
import { PanelLeft, PanelLeftOpen } from 'lucide-react';
import { useI18n } from './i18n';

type PanelMode = 'overlay' | 'sidepanel';
const KEY = 'panelMode';

/** How the toolbar button shows the bookmark sidebar. Stored for the service worker, which owns the click. */
export function PanelModePicker() {
  const { t, message } = useI18n();
  const [mode, setMode] = useState<PanelMode>('overlay');
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    void Promise.resolve(chrome.storage.local.get(KEY))
      .then(data => {
        if (data?.[KEY] === 'sidepanel') setMode('sidepanel');
      })
      .catch(() => {});
  }, []);
  function choose(next: PanelMode) {
    setMode(next);
    if (typeof chrome !== 'undefined' && chrome.storage?.local)
      void Promise.resolve(chrome.storage.local.set({ [KEY]: next })).catch(() => {});
  }
  const options: { id: PanelMode; name: string; hint: string; icon: typeof PanelLeft }[] = [
    { id: 'overlay', name: '浮层侧栏', hint: '从左侧弹出盖在网页上，点空白处或按 Esc 收起', icon: PanelLeftOpen },
    { id: 'sidepanel', name: '浏览器侧边栏', hint: '固定在页面旁边，网页会让出位置', icon: PanelLeft },
  ];
  return (
    <fieldset>
      <legend>{t('侧栏打开方式')}</legend>
      <div className="mode-cards" role="radiogroup" aria-label={t('侧栏打开方式')}>
        {options.map(option => (
          <label key={option.id} className="mode-card">
            <input type="radio" name="panel-mode" checked={mode === option.id} onChange={() => choose(option.id)} />
            <option.icon aria-hidden="true" />
            <span>
              <strong>{message(option.name)}</strong>
              <small>{message(option.hint)}</small>
            </span>
          </label>
        ))}
      </div>
      <p className="hint">{t('浏览器内置页面（如新标签页、设置页）无法放浮层，会自动改用浏览器侧边栏。')}</p>
    </fieldset>
  );
}
