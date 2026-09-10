import { expect, it, vi } from 'vitest';
import { installationIdentity } from '../background/installation-identity';

it.each(['get', 'set', 'setAccessLevel'] as const)('single-flights concurrent retries after %s rejection and caches success', async failure => {
  let failing = true;
  const storage = {
    get: vi.fn(async () => { if (failing && failure === 'get') throw Error('get'); return {}; }),
    set: vi.fn(async () => { if (failing && failure === 'set') throw Error('set'); }),
    setAccessLevel: vi.fn(async () => { if (failing && failure === 'setAccessLevel') throw Error('access'); }),
  };
  const random = vi.fn(() => 'created');
  const ensureIdentity = installationIdentity(storage, random);
  const first = ensureIdentity();
  expect(ensureIdentity()).toBe(first);
  await expect(first).rejects.toThrow();
  failing = false;
  storage.get.mockClear(); storage.set.mockClear(); storage.setAccessLevel.mockClear(); random.mockClear();
  const retry = ensureIdentity();
  expect(ensureIdentity()).toBe(retry);
  expect(await Promise.all([retry, ensureIdentity(), ensureIdentity()])).toEqual(['created', 'created', 'created']);
  expect(ensureIdentity()).toBe(retry);
  expect(storage.get).toHaveBeenCalledTimes(1);
  expect(storage.set).toHaveBeenCalledTimes(1);
  expect(storage.setAccessLevel).toHaveBeenCalledExactlyOnceWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  expect(random).toHaveBeenCalledTimes(1);
});

it('never creates over unreadable or invalid identity and rereads on recovery', async () => {
  const get = vi.fn().mockRejectedValueOnce(Error('read')).mockResolvedValueOnce({ installationId: 42 }).mockResolvedValueOnce({ installationId: '' }).mockResolvedValue({ installationId: 'preserved' });
  const set = vi.fn();
  const random = vi.fn();
  const ensureIdentity = installationIdentity({ get, set, setAccessLevel: async () => {} }, random);
  await expect(ensureIdentity()).rejects.toThrow('read');
  await expect(ensureIdentity()).rejects.toThrow('Invalid');
  await expect(ensureIdentity()).rejects.toThrow('Invalid');
  expect(await Promise.all([ensureIdentity(), ensureIdentity()])).toEqual(['preserved', 'preserved']);
  expect(await ensureIdentity()).toBe('preserved');
  expect(get).toHaveBeenCalledTimes(4);
  expect(set).not.toHaveBeenCalled();
  expect(random).not.toHaveBeenCalled();
});
