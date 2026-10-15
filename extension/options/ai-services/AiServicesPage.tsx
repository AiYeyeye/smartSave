import { useI18n } from '../../ui/i18n';
import { useEffect, useState } from 'react';
import { Download, Plus, Sparkles, Star } from 'lucide-react';
import type { AiServicesTab, ConnectedService, FeatureAssignment } from './mock-data';
import { TAB_HASH } from './mock-data';
import type { SettingsStore } from '../../persistence/settings';
import { ToastProvider, useToast } from './toast';
import { ConnectedPanel, AddServicePanel, FeaturesPanel, ImportExportPanel } from './panels';
import { EditServiceOverlay } from './EditServiceOverlay';
import { SetupWizard } from './SetupWizard';
import './ai-services.css';

const NAV: { id: AiServicesTab; label: string; icon: typeof Star }[] = [
  { id: 'connected', label: '已连接', icon: Star },
  { id: 'add', label: '添加服务', icon: Plus },
  { id: 'features', label: '功能用模', icon: Sparkles },
  { id: 'io', label: '导入导出', icon: Download },
];

export type AiServicesController = {
  services: ConnectedService[];
  features: FeatureAssignment[];
  persistService: (service: ConnectedService, key: string, remember: boolean) => Promise<void> | void;
  removeService: (id: string) => Promise<void> | void;
  assignFeature: (featureId: string, connId: string, modelId: string) => Promise<void> | void;
  assignFeatures?: (changes: { featureId: string; connId: string; modelId: string }[]) => Promise<void> | void;
  importConfig: (payload: { services: ConnectedService[]; features?: FeatureAssignment[] }) => Promise<void> | void;
  exportConfig: () => unknown;
  getCredential: (serviceId: string) => string;
};

function AiServicesPageInner({
  tab,
  onTab,
  controller,
  settings,
}: {
  tab: AiServicesTab;
  onTab: (tab: AiServicesTab) => void;
  controller: AiServicesController;
  settings?: SettingsStore;
}) {
  const { t, message } = useI18n();
  const { toast } = useToast();
  const { services, features } = controller;
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = editingId ? services.find(s => s.id === editingId) : undefined;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && editingId) {
        e.preventDefault();
        setEditingId(null);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editingId]);

  async function disconnect(id: string) {
    try {
      await controller.removeService(id);
      toast('已断开连接');
    } catch {
      toast('断开失败');
    }
  }

  // After connecting, walk straight into choosing models and assigning them to features (both skippable).
  const [wizard, setWizard] = useState<{
    serviceId: string;
    key: string;
    remember: boolean;
    step: 'models' | 'features';
    onboarding?: boolean;
  } | null>(null);
  const wizardService = wizard ? services.find(s => s.id === wizard.serviceId) : undefined;

  async function onConnected(svc: ConnectedService, key: string, remember: boolean) {
    await controller.persistService(svc, key, remember);
    setWizard({ serviceId: svc.id, key, remember, step: 'models', onboarding: true });
  }

  async function assignAll(changes: { featureId: string; connId: string; modelId: string }[]) {
    if (controller.assignFeatures) await controller.assignFeatures(changes);
    else for (const change of changes) await controller.assignFeature(change.featureId, change.connId, change.modelId);
  }

  return (
    <div className="ai-svc ai-svc-page">
      <div className="ai-svc-shell">
        <nav className="ai-svc-tabs" aria-label={t('管理分区')}>
          {NAV.map(item => {
            const Icon = item.icon;
            const on = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className="ai-svc-nav-item"
                aria-current={on ? 'page' : undefined}
                onClick={() => {
                  setEditingId(null);
                  onTab(item.id);
                }}
              >
                <Icon aria-hidden="true" />
                {message(item.label)}
              </button>
            );
          })}
        </nav>
        <div className="ai-svc-body">
          {tab === 'connected' && (
            <ConnectedPanel
              services={services}
              onEdit={setEditingId}
              onDisconnect={id => void disconnect(id)}
              onGoAdd={() => onTab('add')}
            />
          )}
          {tab === 'add' && <AddServicePanel onConnected={onConnected} />}
          {tab === 'features' && (
            <FeaturesPanel
              features={features}
              services={services}
              onQuickSetup={() => {
                const target =
                  services.find(s => features.some(f => f.connId === s.id)) ?? services.find(s => s.enabled.length);
                if (target)
                  setWizard({
                    serviceId: target.id,
                    key: controller.getCredential(target.id),
                    remember: true,
                    step: 'features',
                  });
              }}
              onAssign={(featureId, connId, modelId) => {
                void Promise.resolve(controller.assignFeature(featureId, connId, modelId)).then(() =>
                  toast('已更新功能模型'),
                );
              }}
            />
          )}
          {tab === 'io' && (
            <ImportExportPanel
              services={services}
              exportConfig={controller.exportConfig}
              onImport={payload => controller.importConfig(payload)}
            />
          )}
        </div>
      </div>
      {wizard && wizardService && (
        <SetupWizard
          key={wizard.serviceId + wizard.step}
          service={wizardService}
          services={services}
          features={features}
          initialStep={wizard.step}
          onboarding={wizard.onboarding}
          onSaveModels={async (enabled, catalog) => {
            await controller.persistService({ ...wizardService, enabled, catalog }, wizard.key, wizard.remember);
          }}
          onAssign={assignAll}
          onClose={summary => {
            setWizard(null);
            if (summary) {
              toast(summary);
              onTab('features');
            } else onTab('connected');
          }}
        />
      )}
      {editing && (
        <EditServiceOverlay
          key={editing.id}
          service={editing}
          initialKey={controller.getCredential(editing.id)}
          settings={settings}
          onClose={() => setEditingId(null)}
          onSave={async (next, key, remember) => {
            await controller.persistService(next, key, remember);
          }}
          onChangeService={() => {
            setEditingId(null);
            onTab('add');
            toast('请选择新的服务类型');
          }}
        />
      )}
    </div>
  );
}

export function AiServicesPage({
  tab,
  onTab,
  controller,
  settings,
}: {
  tab: AiServicesTab;
  onTab: (tab: AiServicesTab) => void;
  controller: AiServicesController;
  settings?: SettingsStore;
}) {
  return (
    <ToastProvider>
      <AiServicesPageInner
        tab={tab}
        onTab={tabNext => {
          onTab(tabNext);
          if (typeof location !== 'undefined') {
            const hash = TAB_HASH[tabNext];
            if (location.hash.replace(/^#/, '') !== hash) location.hash = hash;
          }
        }}
        controller={controller}
        settings={settings}
      />
    </ToastProvider>
  );
}
