import { afterEach, expect, it, vi } from 'vitest';
import type { TreeSnapshot } from '../domain/node-reference';
import { prepareMove } from '../panel/TreeDragController';
import { submitMutation } from '../panel/mutation-client';
const tree: TreeSnapshot = {
  installationId: 'i',
  epoch: 'e',
  observedRevision: 0,
  roots: ['r'],
  nodes: [
    {
      ref: { installationId: 'i', nativeId: 'r', kind: 'folder' },
      title: 'Root',
      index: 0,
      childrenIds: ['f', 'g'],
      readOnly: true,
      childrenWritable: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'i', nativeId: 'f', kind: 'folder' },
      title: 'Folder',
      parentId: 'r',
      index: 0,
      childrenIds: ['b'],
      readOnly: false,
      childrenWritable: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'i', nativeId: 'g', kind: 'folder' },
      title: 'Other',
      parentId: 'r',
      index: 1,
      childrenIds: [],
      readOnly: false,
      childrenWritable: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'i', nativeId: 'b', kind: 'bookmark' },
      title: 'Book',
      url: 'https://example.test/',
      parentId: 'f',
      index: 0,
      childrenIds: [],
      readOnly: false,
      observedRevision: 0,
    },
  ],
};
const request = prepareMove(tree, 'b', 'g', 0);
const proposal = { ...request, previewId: 'preview' };
const lostPort = { message: 'The message port closed before a response was received.' };
type Reply = (value: unknown) => void;
/** Chrome exposes runtime.lastError only for the duration of the callback; the stub keeps exactly that window. */
function runtime(
  register: (reply: Reply) => void,
  confirm: (message: unknown, reply: Reply) => void = () => {
    throw Error('confirm must not be sent');
  },
) {
  const stub = {
    lastError: undefined as { message: string } | undefined,
    sendMessage: vi.fn((message: { type?: string }, reply: Reply) => {
      if (message.type === 'registerMutationPreview') register(reply);
      else confirm(message, reply);
    }),
  };
  vi.stubGlobal('chrome', { runtime: stub });
  return stub;
}
const lost = (stub: { lastError?: { message: string } }, reply: Reply) => {
  stub.lastError = lostPort;
  try {
    reply(undefined);
  } finally {
    stub.lastError = undefined;
  }
};
afterEach(() => vi.unstubAllGlobals());
it('explicit worker refusal to register a preview is a retryable rejection and never sends the confirm message', async () => {
  for (const registered of [{ status: 'rejected' }, undefined, { status: 'preview', proposal: { garbage: true } }]) {
    const stub = runtime(reply => reply(registered));
    expect(await submitMutation(request)).toEqual({
      requestId: request.requestId,
      status: 'rejected',
      needsReconcile: false,
      completedSteps: 0,
      remainingSteps: 0,
      reason: 'preview-unavailable',
    });
    expect(stub.sendMessage).toHaveBeenCalledTimes(1);
  }
});
it('lastError on the confirm callback stays unknown/needsReconcile because the request may have reached the worker', async () => {
  const stub = runtime(
    reply => reply({ status: 'preview', proposal }),
    (_message, reply) => lost(stub, reply),
  );
  expect(await submitMutation(request)).toEqual({
    requestId: request.requestId,
    status: 'unknown',
    needsReconcile: true,
    completedSteps: 0,
    remainingSteps: 0,
    reason: 'transport-unavailable',
  });
  expect(stub.sendMessage).toHaveBeenCalledTimes(2);
});
it('lastError on the preview registration callback also stays unknown without any automatic retry', async () => {
  const stub = runtime(reply => lost(stub, reply));
  expect(await submitMutation(request)).toMatchObject({
    status: 'unknown',
    needsReconcile: true,
    reason: 'transport-unavailable',
  });
  expect(stub.sendMessage).toHaveBeenCalledTimes(1);
});
it('a correlated worker result passes through unchanged once the registered proposal is confirmed', async () => {
  const completed = {
    requestId: request.requestId,
    status: 'completed',
    needsReconcile: false,
    completedSteps: 1,
    remainingSteps: 0,
  };
  const stub = runtime(
    reply => reply({ status: 'preview', proposal }),
    (message, reply) => {
      expect(message).toEqual(proposal);
      reply(completed);
    },
  );
  expect(await submitMutation(request)).toEqual(completed);
  expect(stub.sendMessage).toHaveBeenCalledTimes(2);
});
