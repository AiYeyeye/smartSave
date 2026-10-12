import { useCallback, useEffect, useState } from 'react';
import { AiServicesStore, DEFAULT_FEATURES } from '../../persistence/ai-services';
import type { SettingsStore } from '../../persistence/settings';
import type { ConnectedService, FeatureAssignment } from './mock-data';

function browserAiStore() {
  return new AiServicesStore(chrome.storage.local);
}

/**
 * Real AI services data layer: loads/persists connected services + feature assignments.
 * Falls back to empty in-memory state when chrome.storage is unavailable (jsdom / story).
 */
export function useAiServices(settings?: SettingsStore) {
  const [store] = useState(() =>
    typeof chrome !== 'undefined' && chrome.storage?.local ? browserAiStore() : undefined,
  );
  const [services, setServicesState] = useState<ConnectedService[]>([]);
  const [features, setFeaturesState] = useState<FeatureAssignment[]>(() => DEFAULT_FEATURES.map(f => ({ ...f })));
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applySnap = useCallback((snap: { services: ConnectedService[]; features: FeatureAssignment[] }) => {
    setServicesState(
      snap.services.map(s => ({ ...s, catalog: s.catalog.map(m => ({ ...m })), enabled: [...s.enabled] })),
    );
    setFeaturesState(snap.features.map(f => ({ ...f })));
  }, []);

  useEffect(() => {
    let live = true;
    if (!store) {
      setReady(true);
      return;
    }
    void store
      .load()
      .then(snap => {
        if (!live) return;
        applySnap(snap);
        setReady(true);
      })
      .catch(() => {
        if (!live) return;
        setError('AI 服务配置不可用');
        setReady(true);
      });
    const unsub = store.subscribe(() => {
      void store.load().then(snap => {
        if (live) applySnap(snap);
      });
    });
    return () => {
      live = false;
      unsub();
      store.dispose();
    };
  }, [store, applySnap]);

  const persistService = useCallback(
    async (service: ConnectedService, key: string, remember: boolean) => {
      if (!store) {
        setServicesState(prev => {
          const i = prev.findIndex(s => s.id === service.id);
          if (i < 0) return [...prev, service];
          const next = [...prev];
          next[i] = service;
          return next;
        });
        return;
      }
      const snap = await store.upsertService(service, key, remember);
      applySnap(snap);
      try {
        await store.syncPrimaryToSettings(settings);
      } catch {
        /* settings sync is best-effort; service already saved */
      }
    },
    [store, settings, applySnap],
  );

  const removeService = useCallback(
    async (id: string) => {
      if (!store) {
        setServicesState(prev => prev.filter(s => s.id !== id));
        setFeaturesState(feats =>
          feats.map(f => {
            if (f.connId !== id) return f;
            return { ...f, connId: '', modelId: '' };
          }),
        );
        return;
      }
      const snap = await store.removeService(id);
      applySnap(snap);
      try {
        await store.syncPrimaryToSettings(settings);
      } catch {
        /* ignore */
      }
    },
    [store, settings, applySnap],
  );

  const assignFeature = useCallback(
    async (featureId: string, connId: string, modelId: string) => {
      const next = features.map(f => (f.id === featureId ? { ...f, connId, modelId } : f));
      setFeaturesState(next);
      if (!store) return;
      const snap = await store.saveFeatures(next);
      applySnap(snap);
      try {
        await store.syncPrimaryToSettings(settings);
      } catch {
        /* ignore */
      }
    },
    [store, settings, features, applySnap],
  );

  /** Several feature assignments in one write (setup wizard). */
  const assignFeatures = useCallback(
    async (changes: { featureId: string; connId: string; modelId: string }[]) => {
      const byId = new Map(changes.map(c => [c.featureId, c]));
      const next = features.map(f => {
        const change = byId.get(f.id);
        return change ? { ...f, connId: change.connId, modelId: change.modelId } : f;
      });
      setFeaturesState(next);
      if (!store) return;
      const snap = await store.saveFeatures(next);
      applySnap(snap);
      try {
        await store.syncPrimaryToSettings(settings);
      } catch {
        /* ignore */
      }
    },
    [store, settings, features, applySnap],
  );

  const importConfig = useCallback(
    async (payload: { services: ConnectedService[]; features?: FeatureAssignment[] }) => {
      const feats = payload.features?.length ? payload.features : features;
      if (!store) {
        applySnap({ services: payload.services, features: feats });
        return;
      }
      const snap = await store.replaceAll(payload.services, feats);
      applySnap(snap);
    },
    [store, features, applySnap],
  );

  const exportConfig = useCallback(() => {
    if (store) return store.exportConfig();
    return {
      version: 1 as const,
      services: services.map(
        ({
          id,
          name,
          serviceType,
          kind,
          detail,
          baseUrl,
          mode,
          enabled,
          catalog,
          vendorId,
          timeoutMs,
          letter,
          avatarClass,
          status,
        }) => ({
          id,
          name,
          serviceType,
          kind,
          detail,
          baseUrl,
          mode,
          enabled,
          catalog,
          vendorId,
          timeoutMs,
          letter,
          avatarClass,
          status,
        }),
      ),
      features,
    };
  }, [store, services, features]);

  const getCredential = useCallback((serviceId: string) => (store ? store.credential(serviceId) : ''), [store]);

  return {
    store,
    ready,
    error,
    services,
    features,
    persistService,
    removeService,
    assignFeature,
    assignFeatures,
    importConfig,
    exportConfig,
    getCredential,
  };
}

/** @deprecated Use useAiServices */
export function useAiServicesMock() {
  return useAiServices();
}
