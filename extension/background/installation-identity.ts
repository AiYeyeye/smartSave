export interface IdentityStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
}
export function installationIdentity(storage: IdentityStorage, random: () => string = () => crypto.randomUUID()) {
  let pending: Promise<string> | undefined;
  return function ensureIdentity() {
    return pending ??= (async () => {
      await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      const result = await storage.get('installationId');
      if (result.installationId !== undefined) {
        if (typeof result.installationId !== 'string' || !result.installationId) throw Error('Invalid installation identity');
        return result.installationId;
      }
      const id = random();
      await storage.set({ installationId: id });
      return id;
    })().catch((error: unknown) => {
      // A rejected write may already have persisted: retry the read, never reuse a candidate ID.
      pending = undefined;
      throw error;
    });
  };
}
