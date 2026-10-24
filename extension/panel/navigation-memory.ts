import { z } from 'zod';

const id = z.string().min(1).max(256);
const positionSchema = z
  .object({
    version: z.literal(1),
    installationId: id,
    anchor: id,
    fallback: z.array(id).max(34),
    offset: z.number().finite().min(-100_000).max(100_000),
    scrollTop: z.number().finite().min(0).max(10_000_000),
    at: z.number().finite().nonnegative(),
  })
  .strict();
export type NavigationPosition = z.infer<typeof positionSchema>;
export const navigationKey = (installationId: string) => `tree.position.v1.${encodeURIComponent(installationId)}`;
export function readPosition(value: unknown, installationId: string): NavigationPosition | undefined {
  const parsed = positionSchema.safeParse(value);
  return parsed.success && parsed.data.installationId === installationId ? parsed.data : undefined;
}

/** Display preference only. No titles, URLs, selection, drafts or mutation authority. */
export class NavigationMemory {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private storage: Pick<typeof chrome.storage.local, 'get' | 'set'>) {}
  async load(installationId: string) {
    const key = navigationKey(installationId);
    return readPosition((await this.storage.get(key))[key], installationId);
  }
  save(position: NavigationPosition) {
    const write = async () => {
      const previous = await this.load(position.installationId);
      if (previous && previous.at > position.at) return;
      await this.storage.set({ [navigationKey(position.installationId)]: position });
    };
    const run = () =>
      globalThis.navigator?.locks ? navigator.locks.request(navigationKey(position.installationId), write) : write();
    this.pending = this.pending.catch(() => {}).then(run);
    return this.pending;
  }
}
