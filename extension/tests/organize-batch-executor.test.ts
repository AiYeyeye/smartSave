import { expect, it, vi } from 'vitest';
import { OrganizeBatchExecutor } from '../panel/organize-batch-executor';
import type { ModelResult } from '../adapters/model-transport';

it('does not automatically replay an out-of-order network failure or dispatch beyond a known failure', async () => {
  const queue = [['a'], ['b'], ['c']];
  const accepted = new Map<string[], ModelResult>();
  const resolvers = new Map<string, (result: ModelResult) => void>();
  const execute = vi.fn(
    (ids: string[]) =>
      new Promise<ModelResult>(resolve => {
        resolvers.set(ids[0]!, resolve);
      }),
  );
  const executor = new OrganizeBatchExecutor(accepted, execute, 2, new AbortController().signal, vi.fn());
  const first = executor.next(queue);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  resolvers.get('b')!({ status: 'failed', reason: 'network-error' });
  resolvers.get('a')!({ status: 'completed', output: { rankedIds: [] } });
  expect((await first).status).toBe('completed');
  executor.consume(queue.shift()!);
  expect(await executor.next(queue)).toEqual({ status: 'failed', reason: 'network-error' });
  expect(execute).toHaveBeenCalledTimes(2);
  expect(resolvers.has('c')).toBe(false);
  executor.stop();
});

it('cancels immediately even if a synthetic boundary ignores abort and never retains its late answer', async () => {
  const accepted = new Map<string[], ModelResult>();
  let finish!: (result: ModelResult) => void;
  const signal = new AbortController();
  const ready = vi.fn();
  const executor = new OrganizeBatchExecutor(
    accepted,
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
    2,
    signal.signal,
    ready,
  );
  const pending = executor.next([['a']]);
  await Promise.resolve();
  signal.abort();
  await expect(pending).rejects.toThrow('cancelled');
  finish({ status: 'completed', output: { rankedIds: [] } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(accepted.size).toBe(0);
  expect(ready).not.toHaveBeenCalled();
});
