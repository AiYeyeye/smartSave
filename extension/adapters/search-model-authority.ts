import type { ModelAuthority } from './model-authority';
import type { AiServicesStore } from '../persistence/ai-services';
import { featureModelContext } from './feature-model-settings';

/** Overlay only the search feature's route; never save it into the shared collection settings. */
export function searchModelAuthority(base: ModelAuthority, services?: AiServicesStore): ModelAuthority {
  if (!services) return base;
  return {
    async read() {
      const context = await featureModelContext(await base.read(), services, 'search');
      if (!context.config) throw Error('unavailable');
      return context;
    },
    subscribe(listener) {
      const stopBase = base.subscribe(listener);
      const stopServices = services.subscribe(() => listener('settings'));
      return () => {
        stopBase();
        stopServices();
      };
    },
  };
}
