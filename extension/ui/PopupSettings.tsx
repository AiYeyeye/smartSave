import { Archive, ChartNoAxesCombined, ChevronRight, Palette, ScrollText, Shield, Sparkles } from 'lucide-react';
import { AiSidebarSummary } from '../options/ai-services';
import type { AiServicesTab, ConnectedService, FeatureAssignment } from '../options/ai-services';
import { AccentPicker, ModeSwitch } from './ThemeProvider';
import { LanguagePicker, useI18n } from './i18n';

const LINKS: { route: string; title: string; icon: typeof Palette }[] = [
  { route: 'ai-services', title: 'AI 服务管理', icon: Sparkles },
  { route: 'token-usage', title: 'Token 统计', icon: ChartNoAxesCombined },
  { route: 'export', title: '导出与备份', icon: Archive },
  { route: 'privacy', title: '隐私与规则', icon: Shield },
  { route: 'debug', title: '收藏记录与调试日志', icon: ScrollText },
  { route: 'appearance', title: '更多外观选项', icon: Palette },
];

/** Popup quick settings: appearance, model-per-feature, and links into the full settings page. */
export function PopupSettings({
  services,
  features,
  onOpenRoute,
  onOpenAiServices,
  onAssignFeature,
  onTrial,
}: {
  services: ConnectedService[];
  features: FeatureAssignment[];
  onOpenRoute: (route: string) => void;
  onOpenAiServices: (tab: AiServicesTab) => void;
  onAssignFeature: (featureId: string, connId: string, modelId: string) => void;
  onTrial?: () => void;
}) {
  const { t, message } = useI18n();
  return (
    <div className="popup-settings">
      <section className="popup-block" aria-label={t('外观')}>
        <h2>{t('外观')}</h2>
        <ModeSwitch />
        <AccentPicker compact />
        <LanguagePicker />
      </section>
      <AiSidebarSummary services={services} features={features} onOpen={onOpenAiServices} onAssign={onAssignFeature} />
      {onTrial && (
        <button type="button" onClick={onTrial}>
          {t('试分类当前网页')}
        </button>
      )}
      <section className="popup-block" aria-label={t('完整设置')}>
        <h2>{t('完整设置')}</h2>
        <div className="link-list">
          {LINKS.map(link => (
            <button key={link.route} type="button" onClick={() => onOpenRoute(link.route)}>
              <link.icon aria-hidden="true" />
              {message(link.title)}
              <span className="setting-arrow" aria-hidden="true">
                <ChevronRight />
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
