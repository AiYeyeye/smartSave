import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { startMutationService } from '../background/mutation-service';
import { TreeProjection } from '../background/tree-projection';
afterEach(() => vi.unstubAllGlobals());
it('routes only mutation messages through trusted sender/schema validation without native writes', async () => {
  let handler:
    ((message: unknown, sender: chrome.runtime.MessageSender, respond: (v: unknown) => void) => boolean) | undefined;
  const write = vi.fn(async () => {
    throw Error('must not mutate');
  });
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test',
      onMessage: {
        addListener: (cb: typeof handler) => {
          handler = cb;
        },
      },
    },
    bookmarks: { create: write, update: write, move: write, remove: write },
  });
  const projection = new TreeProjection(
    { read: async () => [], listen: () => () => {} },
    async () => 'install',
    'epoch',
  );
  projection.start();
  startMutationService(projection);
  expect(handler!({ type: 'other' }, {}, () => {})).toBe(false);
  const response = await new Promise(resolve => {
    expect(
      handler!(
        { version: 1, type: 'mutationStatus', requestId: 'missing' },
        { id: 'evil', url: 'chrome-extension://test/panel/index.html' },
        resolve,
      ),
    ).toBe(true);
  });
  expect(response).toMatchObject({ status: 'rejected', reason: 'invalid-message-or-sender' });
  const popup = await new Promise(resolve => {
    handler!(
      { version: 1, type: 'reconcileMutation', requestId: 'missing' },
      { id: 'test', url: 'chrome-extension://test/panel/index.html', documentId: 'popup' },
      resolve,
    );
  });
  expect(popup).toMatchObject({ status: 'rejected', reason: 'request-not-found' });
  const trusted = await new Promise(resolve => {
    handler!(
      { version: 1, type: 'reconcileMutation', requestId: 'missing' },
      { id: 'test', url: 'chrome-extension://test/options/index.html' },
      resolve,
    );
  });
  expect(trusted).toMatchObject({ status: 'rejected', reason: 'request-not-found' });
  expect(write).not.toHaveBeenCalled();
});

it('accepts organizer task preview metadata only and rejects foreign senders or executable payloads before preparation', async () => {
  let handler!: (message: unknown, sender: chrome.runtime.MessageSender, respond: (v: unknown) => void) => boolean;
  const write = vi.fn();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test',
      onMessage: {
        addListener: (cb: typeof handler) => {
          handler = cb;
        },
      },
    },
    bookmarks: { create: write, update: write, move: write, remove: write },
  });
  const projection = new TreeProjection(
    { read: async () => [], listen: () => () => {} },
    async () => 'install',
    'epoch',
  );
  const coordinator = startMutationService(projection);
  const prepare = vi.spyOn(coordinator, 'registerOrganizeTaskPreview').mockResolvedValue(undefined);
  const sender = { id: 'test', url: 'chrome-extension://test/options/index.html' };
  const input = {
    version: 1,
    type: 'registerOrganizeTaskPreview',
    organizerContext: 'lease',
    checkpointId: 'task',
    checkpointRevision: 3,
  };
  const send = (message: unknown, source = sender) =>
    new Promise(resolve => {
      handler(message, source, resolve);
    });
  expect(await send(input, { ...sender, id: 'evil' })).toMatchObject({ status: 'rejected' });
  expect(await send({ ...input, command: { type: 'remove' } })).toMatchObject({
    status: 'rejected',
    reason: 'invalid-organize-preview',
  });
  expect(await send({ ...input, checkpointRevision: -1 })).toMatchObject({
    status: 'rejected',
    reason: 'invalid-organize-preview',
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(await send(input)).toEqual({ status: 'empty' });
  expect(prepare).toHaveBeenCalledWith('lease', 'task', 3, sender);
  expect(write).not.toHaveBeenCalled();
});
