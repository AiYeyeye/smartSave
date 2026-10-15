import { apiModeToAdapter } from '../domain/ai-providers';
import type { AiServicesStore } from '../persistence/ai-services';
import type { SettingsStore } from '../persistence/settings';

export type ModelSettingsReader = Pick<SettingsStore, 'snapshot' | 'subscribe'>;
export type AiFeature = 'save' | 'classify' | 'search' | 'import' | 'organize';

/** Resolve one feature without modifying primary settings or moving credentials between owners. */
export async function featureModelContext<T extends Awaited<ReturnType<SettingsStore['snapshot']>>>(
  context: T,
  services: AiServicesStore,
  featureId: AiFeature,
): Promise<T> {
  const snapshot = await services.load();
  if (!snapshot.services.length && !snapshot.revision) return context;
  const feature = snapshot.features.find(entry => entry.id === featureId);
  const service = snapshot.services.find(entry => entry.id === feature?.connId);
  if (!service?.baseUrl.trim() || !feature?.modelId)
    return { ...context, revision: JSON.stringify([context.revision, snapshot.revision]), config: undefined, key: '' };
  return {
    ...context,
    revision: JSON.stringify([context.revision, snapshot.revision]),
    config: {
      adapter: apiModeToAdapter(service.mode),
      baseUrl: service.baseUrl,
      model: feature.modelId,
      timeoutMs: service.timeoutMs ?? 60_000,
      ...(service.streaming === undefined ? {} : { streaming: service.streaming }),
      ...(service.fastMode === undefined ? {} : { fastMode: service.fastMode }),
      ...(service.maxOutputTokens === undefined ? {} : { maxOutputTokens: service.maxOutputTokens }),
    },
    key: services.credential(service.id),
  };
}

/** Shared by UI requests and worker write validation so import evidence uses the same route. */
export function featureModelSettings(
  base: ModelSettingsReader,
  services: AiServicesStore | undefined,
  featureId: AiFeature,
): ModelSettingsReader {
  if (!services) return base;
  return {
    async snapshot() {
      return featureModelContext(await base.snapshot(), services, featureId);
    },
    subscribe(listener) {
      const stopBase = base.subscribe(listener);
      const stopServices = services.subscribe(listener);
      return () => {
        stopBase();
        stopServices();
      };
    },
  };
}
