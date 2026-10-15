import { z } from 'zod';
import { cancellable } from '../domain/cancellable';

const memorySchema = z.strictObject({
  version: z.literal(1),
  protectedFolderIds: z.array(z.string()).max(5000),
  rejected: z.array(z.strictObject({ signature: z.string().max(12000), label: z.string().max(400) })).max(500),
});
export type OrganizeMemory = z.infer<typeof memorySchema>;
export const emptyOrganizeMemory = (): OrganizeMemory => ({ version: 1, protectedFolderIds: [], rejected: [] });
type Storage = {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
};
/** Local-only, installation-scoped preferences. No bookmark URLs, model replies or credentials. */
export class OrganizeMemoryStore {
  private transient = new Map<string, OrganizeMemory>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private storage?: Storage) {}
  private key(installationId: string) {
    return `organize.memory.${encodeURIComponent(installationId)}`;
  }
  async load(installationId: string): Promise<OrganizeMemory> {
    if (!this.storage) return structuredClone(this.transient.get(installationId) ?? emptyOrganizeMemory());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Error('organize-memory-timeout')), 10_000);
    try {
      await cancellable(this.storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }), controller.signal);
      const key = this.key(installationId);
      const data = await cancellable(this.storage.get(key), controller.signal);
      return data[key] === undefined ? emptyOrganizeMemory() : memorySchema.parse(data[key]);
    } finally {
      clearTimeout(timer);
    }
  }
  update(installationId: string, change: (value: OrganizeMemory) => OrganizeMemory): Promise<OrganizeMemory> {
    const write = async () => {
      const value = memorySchema.parse(change(await this.load(installationId)));
      if (this.storage) await this.storage.set({ [this.key(installationId)]: value });
      else this.transient.set(installationId, value);
      return value;
    };
    const operation = this.pending
      .catch(() => {})
      .then(() => (globalThis.navigator?.locks ? navigator.locks.request(this.key(installationId), write) : write()));
    this.pending = operation;
    return operation;
  }
}
