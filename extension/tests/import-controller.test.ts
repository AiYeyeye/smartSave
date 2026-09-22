import { expect, it, vi } from 'vitest';
import { ImportController } from '../panel/import-controller';
import type { ConfirmMutation } from '../schemas/messages';
const root = { installationId: 'i', nativeId: 'bar', kind: 'folder' as const };
const request: ConfirmMutation = {
  version: 1,
  type: 'confirmMutation',
  requestId: 'r',
  installationId: 'i',
  epoch: 'e',
  observedRevision: 0,
  scope: root,
  before: [],
  command: { type: 'create', parent: root, title: 'X', url: 'https://example.test' },
  importContext: 'lease',
  previewId: 'preview',
};
it('callable client previews through dedicated worker message and confirms once without generic re-registration', async () => {
  const close = vi.fn();
  const send = vi.fn(async (raw: unknown) => {
    if ((raw as { type: string }).type === 'registerImportPreview') return { status: 'preview', proposal: request };
    return { requestId: 'r', status: 'completed', needsReconcile: false, completedSteps: 1, remainingSteps: 0 };
  });
  const controller = new ImportController(send, async () => ({ token: 'lease', close }));
  await controller.preview('c', 0, { root, selectedSourceOrdinals: [0], titleEdits: [] });
  expect((await controller.apply()).status).toBe('completed');
  expect(close).toHaveBeenCalledOnce();
  expect(send.mock.calls.map(([r]) => (r as { type: string }).type)).toEqual([
    'registerImportPreview',
    'confirmMutation',
  ]);
  await controller.retry(request);
  expect(send).toHaveBeenCalledTimes(3);
});
it('cancellation closes pending lease and cannot publish a late preview', async () => {
  const close = vi.fn();
  let deliver!: (raw: unknown) => void;
  const send = vi.fn(
    () =>
      new Promise<unknown>(resolve => {
        deliver = resolve;
      }),
  );
  const controller = new ImportController(send, async () => ({ token: 'lease', close }));
  const pending = controller.preview('c', 0, { root, selectedSourceOrdinals: [0], titleEdits: [] });
  await Promise.resolve();
  controller.cancel();
  deliver({ status: 'preview', proposal: request });
  await expect(pending).rejects.toThrow('cancelled');
  expect(close).toHaveBeenCalledOnce();
  await expect(controller.apply()).rejects.toThrow('preview-required');
});
it.each(['rejected', 'dropped', 'read-failed'] as const)(
  'submission ownership distinguishes %s without trusting absent local IDs',
  async mode => {
    const checkpoint = {
      schemaVersion: 1 as const,
      id: 'c',
      revision: 0,
      installationId: 'i',
      root,
      items: [],
      diagnostics: [],
      classified: [],
      newFolders: [],
      phase: 'classified' as const,
    };
    const send = vi.fn(async (raw: unknown) => {
      if ((raw as { type: string }).type === 'registerImportPreview') return { status: 'preview', proposal: request };
      if (mode === 'dropped') throw Error('lost response');
      return {
        requestId: 'r',
        status: 'rejected',
        needsReconcile: false,
        completedSteps: 0,
        remainingSteps: 1,
        reason: 'import-checkpoint-freeze-failed',
      };
    });
    const controller = new ImportController(send, async () => ({ token: 'lease', close() {} }), {
      get: async () => {
        if (mode === 'read-failed') throw Error('unavailable');
        return checkpoint;
      },
    });
    await controller.preview('c', 0, { root, selectedSourceOrdinals: [], titleEdits: [] });
    await controller.apply();
    expect(controller.submission('c').state).toBe(mode === 'rejected' ? 'rejected-before-handoff' : 'uncertain');
    if (mode === 'rejected')
      await expect(
        controller.preview('c', 0, { root, selectedSourceOrdinals: [], titleEdits: [] }),
      ).resolves.toBeDefined();
    else
      await expect(controller.preview('c', 0, { root, selectedSourceOrdinals: [], titleEdits: [] })).rejects.toThrow(
        'recovery-required',
      );
  },
);
it.each(['privacy-excluded', 'invalid-import-folder', 'stale-import-authority'])(
  'register rejection preserves explicit %s instead of schema failure',
  async reason => {
    const close = vi.fn();
    const controller = new ImportController(
      async () => ({ status: 'rejected', reason }),
      async () => ({ token: 'lease', close }),
    );
    await expect(controller.preview('c', 0, { root, selectedSourceOrdinals: [], titleEdits: [] })).rejects.toThrow(
      reason,
    );
    expect(close).toHaveBeenCalledOnce();
    expect(controller.submission('c').state).toBe('idle');
  },
);
