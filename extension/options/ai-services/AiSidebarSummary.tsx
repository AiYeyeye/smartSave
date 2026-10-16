import { useI18n } from '../../ui/i18n';
import { Download, Plus } from 'lucide-react';
import type { ConnectedService, FeatureAssignment, AiServicesTab } from './mock-data';
import { Avatar } from './Avatar';
import { ModelPicker } from './ModelPicker';
import './ai-services.css';

export function AiSidebarSummary({
  services,
  features,
  onOpen,
  onAssign,
}: {
  services: ConnectedService[];
  features: FeatureAssignment[];
  onOpen: (tab: AiServicesTab) => void;
  onAssign?: (featureId: string, connId: string, modelId: string) => void;
}) {
  const { t, message } = useI18n();
  const chips = services;
  return (
    <div className="ai-svc ai-svc-summary">
      <div>
        <p className="ai-svc-section-label">{t('设置')}</p>
        <div className="ai-svc-block">
          <h2>{t('AI 服务')}</h2>
          <div className="ai-svc-chip-list">
            {chips.length === 0 ? (
              <p className="ai-svc-empty-line">{t('尚未连接任何服务')}</p>
            ) : (
              chips.map(s => (
                <div key={s.id} className="ai-svc-chip">
                  <Avatar letter={s.letter} avatarClass={s.avatarClass} />
                  <div className="meta">
                    <strong>{s.name}</strong>
                    <span>
                      {t('{count} 个模型 · {status}', {
                        count: s.enabled.length,
                        status: t(s.status === 'ok' ? '已连接' : '需检查'),
                      })}
                    </span>
                  </div>
                  <span className={`ai-svc-dot${s.status !== 'ok' ? ' warn' : ''}`} />
                </div>
              ))
            )}
          </div>
          <div className="ai-svc-actions">
            <button type="button" className="ai-svc-btn ai-svc-btn-primary" onClick={() => onOpen('add')}>
              <Plus aria-hidden="true" />
              {t('管理 AI 服务')}
            </button>
            <button type="button" className="ai-svc-btn ai-svc-btn-ghost" onClick={() => onOpen('io')}>
              <Download aria-hidden="true" />
              {t('导入 / 导出')}
            </button>
          </div>
        </div>
      </div>
      <div>
        <p className="ai-svc-section-label">{t('功能用模')}</p>
        <div className="ai-svc-block">
          <div className="ai-svc-feat-summary">
            {features.map(f => (
              <div key={f.id} className="ai-svc-sidebar-feat-row">
                <span className="ai-svc-sidebar-feat-label">{message(f.name)}</span>
                {onAssign ? (
                  <ModelPicker
                    feature={f}
                    services={services}
                    compact
                    onSelect={(connId, modelId) => onAssign(f.id, connId, modelId)}
                  />
                ) : (
                  <div className="ai-svc-feat-chip">
                    <strong>{message(f.name)}</strong>
                    <span className="model-tag" title={f.modelId}>
                      {f.modelId || t('未绑定')}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
          <button type="button" className="ai-svc-link" onClick={() => onOpen('features')}>
            {t('管理功能模型 →')}
          </button>
        </div>
      </div>
    </div>
  );
}
