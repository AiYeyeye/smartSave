import { Palette, Sparkles, Shield, Archive } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ModelSettings } from '../options/ModelSettings';
import { SiteRulesSettings } from '../options/SiteRulesSettings';
import { RecoveryWorkbench } from '../options/RecoveryWorkbench';
import { ExportSettings } from '../options/ExportSettings';
import { ThemePicker, themes, useTheme } from './ThemeProvider';
import { SidebarPosition } from './SidebarPosition';
import type { SettingsStore } from '../persistence/settings';

export type SettingsPage = 'overview' | 'appearance' | 'model' | 'privacy' | 'export-backup';
export type SettingsJump = { page: SettingsPage; nonce: number; recovery?: boolean };

export function SettingsNav({
  visible,
  store,
  jump,
  page,
  onPage,
}: {
  visible: boolean;
  store?: SettingsStore;
  jump?: SettingsJump;
  page: SettingsPage;
  onPage: (page: SettingsPage) => void;
}) {
  const { theme } = useTheme();
  const currentName = (themes.find(item => item.id === theme)?.name ?? '清爽文具（默认）').replace(/（默认）$/, '');
  const [showRecovery, setShowRecovery] = useState(true);
  useEffect(() => {
    if (!jump) return;
    onPage(jump.page);
    setShowRecovery(jump.recovery !== false);
  }, [jump, onPage]);
  const cards: { id: SettingsPage; title: string; hint: string; icon: typeof Palette }[] = [
    { id: 'appearance', title: '外观', icon: Palette, hint: `四种风格 · 当前为${currentName}` },
    { id: 'model', title: 'AI 模型', icon: Sparkles, hint: '未配置时整理前需要设置' },
    { id: 'privacy', title: '隐私', icon: Shield, hint: '控制发送内容与 AI 排除目录' },
    { id: 'export-backup', title: '导出与备份', icon: Archive, hint: '手动导出、JSON 自动输出与恢复' },
  ];
  return (
    <div hidden={!visible} className="settings-nav">
      <section hidden={page !== 'overview'} className="settings-overview" aria-label="设置">
        {cards.map(card => (
          <button
            key={card.id}
            type="button"
            className="settings-card"
            title={card.hint}
            onClick={() => {
              if (card.id === 'export-backup') setShowRecovery(true);
              onPage(card.id);
            }}
          >
            <span className="setting-icon">
              <card.icon aria-hidden="true" />
            </span>
            <strong>{card.title}</strong>
            <span className="setting-arrow" aria-hidden="true">
              ›
            </span>
          </button>
        ))}
      </section>
      <section hidden={page !== 'appearance'} className="surface" aria-label="外观设置">
        <ThemePicker />
        <SidebarPosition />
      </section>
      <div hidden={page !== 'model' && page !== 'privacy'}>
        <ModelSettings showHeading={false} store={store} fields={page === 'privacy' ? 'privacy' : 'model'} />
      </div>
      <div hidden={page !== 'privacy'}>
        <SiteRulesSettings />
      </div>
      <div hidden={page !== 'export-backup'}>
        <ExportSettings visible={visible && page === 'export-backup'} />
        {showRecovery && <RecoveryWorkbench />}
      </div>
    </div>
  );
}
