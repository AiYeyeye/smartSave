import { Palette, Sparkles, Shield, Archive, FolderTree, WandSparkles, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ModelSettings } from '../options/ModelSettings';
import { SiteRulesSettings } from '../options/SiteRulesSettings';
import { RecoveryWorkbench } from '../options/RecoveryWorkbench';
import { ExportSettings } from '../options/ExportSettings';
import { ThemePicker, themes, useTheme } from './ThemeProvider';
import type { SettingsStore } from '../persistence/settings';
import { AiSidebarSummary } from '../options/ai-services';
import type { AiServicesTab, ConnectedService, FeatureAssignment } from '../options/ai-services';

export type SettingsPage = 'overview' | 'appearance' | 'model' | 'privacy' | 'export-backup';
export type SettingsJump = { page: SettingsPage; nonce: number; recovery?: boolean };
/** A workbench the settings hub links to; only the options page (the full workbench host) offers these. */
export type WorkbenchLink = { id: 'browse' | 'organize' | 'import'; title: string; hint: string };
const workbenchIcons = { browse: FolderTree, organize: WandSparkles, import: Upload } as const;

export function SettingsNav({
  visible,
  store,
  jump,
  page,
  onPage,
  workbenches,
  onWorkbench,
  aiServices,
  onOpenAiServices,
}: {
  visible: boolean;
  store?: SettingsStore;
  jump?: SettingsJump;
  page: SettingsPage;
  onPage: (page: SettingsPage) => void;
  workbenches?: WorkbenchLink[];
  onWorkbench?: (workbench: WorkbenchLink['id']) => void;
  aiServices?: {
    services: ConnectedService[];
    features: FeatureAssignment[];
  };
  onOpenAiServices?: (tab: AiServicesTab) => void;
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
    { id: 'model', title: 'AI 模型（旧）', icon: Sparkles, hint: '旧单连接配置；新管理页见上方摘要' },
    { id: 'privacy', title: '隐私', icon: Shield, hint: '控制发送内容与 AI 排除目录' },
    { id: 'export-backup', title: '导出与备份', icon: Archive, hint: '手动导出、JSON 自动输出与恢复' },
  ];
  return (
    <div hidden={!visible} className="settings-nav">
      {workbenches && workbenches.length > 0 && (
        <section hidden={page !== 'overview'} className="settings-overview" aria-label="工作台">
          {workbenches.map(link => {
            const Icon = workbenchIcons[link.id];
            return (
              <button
                key={link.id}
                type="button"
                className="settings-card"
                title={link.hint}
                onClick={() => onWorkbench?.(link.id)}
              >
                <span className="setting-icon">
                  <Icon aria-hidden="true" />
                </span>
                <strong>{link.title}</strong>
                <span className="setting-arrow" aria-hidden="true">
                  ›
                </span>
              </button>
            );
          })}
        </section>
      )}
      {page === 'overview' && aiServices && onOpenAiServices ? (
        <section className="settings-overview" aria-label="AI 服务摘要">
          <AiSidebarSummary
            services={aiServices.services}
            features={aiServices.features}
            onOpen={onOpenAiServices}
          />
        </section>
      ) : null}
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
