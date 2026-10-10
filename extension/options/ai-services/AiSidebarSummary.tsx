import { Download, Plus } from 'lucide-react';
import type { ConnectedService, FeatureAssignment, AiServicesTab } from './mock-data';
import { Avatar } from './Avatar';
import './ai-services.css';

export function AiSidebarSummary({
  services,
  features,
  onOpen,
}: {
  services: ConnectedService[];
  features: FeatureAssignment[];
  onOpen: (tab: AiServicesTab) => void;
}) {
  const chips = services.slice(0, 3);
  const featPreview = features.slice(0, 3);
  return (
    <div className="ai-svc ai-svc-summary">
      <div>
        <p className="ai-svc-section-label">AI 服务</p>
        <div className="ai-svc-block">
          <h2>AI 服务</h2>
          <div className="ai-svc-chip-list">
            {chips.length === 0 ? (
              <p className="ai-svc-empty-line">尚未连接任何服务</p>
            ) : (
              chips.map(s => (
                <div key={s.id} className="ai-svc-chip">
                  <Avatar letter={s.letter} avatarClass={s.avatarClass} />
                  <div className="meta">
                    <strong>{s.name}</strong>
                    <span>
                      {s.enabled.length} 个模型 · {s.status === 'ok' ? '已连接' : '需检查'}
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
              管理 AI 服务
            </button>
            <button type="button" className="ai-svc-btn ai-svc-btn-ghost" onClick={() => onOpen('io')}>
              <Download aria-hidden="true" />
              导入 / 导出
            </button>
          </div>
        </div>
      </div>
      <div>
        <p className="ai-svc-section-label">功能用模</p>
        <div className="ai-svc-block">
          <div className="ai-svc-feat-summary">
            {featPreview.map(f => (
              <div key={f.id} className="ai-svc-feat-chip">
                <strong>{f.name}</strong>
                <span className="model-tag" title={f.modelId}>
                  {f.modelId || '未绑定'}
                </span>
              </div>
            ))}
          </div>
          <button type="button" className="ai-svc-link" onClick={() => onOpen('features')}>
            管理功能模型 →
          </button>
        </div>
      </div>
      <p className="ai-svc-hint">侧栏仅摘要。连接、模型与功能分配在管理页完成。</p>
    </div>
  );
}
