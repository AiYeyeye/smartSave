import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { RecoveryWorkbench } from '../options/RecoveryWorkbench';
import { ThemePicker, ThemeProvider } from '../ui/ThemeProvider';
it('recovery errors are explicit; changing all themes retains workbench state and does not send requests', async () => {
  let calls = 0;
  render(
    createElement(
      ThemeProvider,
      null,
      createElement(ThemePicker),
      createElement(RecoveryWorkbench, {
        send: async () => {
          calls++;
          throw Error('transport');
        },
      }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: '读取恢复记录' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('传输或响应不可用'));
  const originalCalls = calls;
  for (const radio of screen.getAllByRole('radio')) {
    fireEvent.click(radio);
    expect(screen.getByRole('alert')).toHaveTextContent('写入结果可能未知');
  }
  expect(calls).toBe(originalCalls);
});
it('completed recovery subplan with skipped items remains visibly incomplete on reconcile', async () => {
  const { summarizeRecovery } = await import('../domain/recovery-summary');
  const result = {
    requestId: 'restored',
    status: 'completed' as const,
    completedSteps: 1,
    remainingSteps: 0,
    needsReconcile: false,
  };
  const recovery = {
    sourceRequestId: 'source',
    mode: 'undo' as const,
    conflicts: [{ nativeId: 'unsafe', reason: 'unsupported-recovery-url' }],
  };
  expect(summarizeRecovery(result, recovery)).toMatchObject({ incomplete: true });
  expect(summarizeRecovery(result, recovery).text).toContain('unsafe：unsupported-recovery-url');
  expect(summarizeRecovery(result, { sourceRequestId: 'legacy', mode: 'undo' }).text).toContain('覆盖范围未知');
  expect(summarizeRecovery(result, { ...recovery, conflicts: [] }).incomplete).toBe(false);
});
it('renders persisted skipped coverage as an alert after state reconciliation', async () => {
  const { confirmSchema } = await import('../schemas/messages');
  const ref = { installationId: 'i', nativeId: 'root', kind: 'folder' };
  const request = confirmSchema.parse({
    version: 1,
    type: 'confirmMutation',
    requestId: 'restored',
    installationId: 'i',
    epoch: 'e',
    observedRevision: 0,
    scope: ref,
    before: [],
    command: { type: 'create', parent: ref, title: 'Restored' },
    recovery: {
      sourceRequestId: 'source',
      mode: 'undo',
      conflicts: [{ nativeId: 'unsafe', reason: 'unsupported-recovery-url' }],
    },
  });
  const result = {
    requestId: 'restored',
    status: 'completed',
    completedSteps: 1,
    remainingSteps: 0,
    needsReconcile: false,
  };
  render(
    createElement(RecoveryWorkbench, {
      send: async raw => {
        const message = raw as { type: string; requestId: string };
        if (message.type === 'recoveryList')
          return {
            status: 'ready',
            requestId: message.requestId,
            records: [
              { schemaVersion: 1, requestId: 'restored', request, affected: [], steps: [], mapping: {}, result },
            ],
            destinations: [],
          };
        return result;
      },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: '读取恢复记录' }));
  await waitFor(() => expect(screen.getByText(/恢复未完整/)).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: '核对当前状态（不重放）' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('恢复未完整：保留 / 跳过 1 项'));
  expect(screen.getByRole('alert')).toHaveTextContent('unsupported-recovery-url');
});
it('retains skipped coverage when applying and clearing the preview', async () => {
  const { confirmSchema } = await import('../schemas/messages');
  const ref = { installationId: 'i', nativeId: 'root', kind: 'folder' };
  const conflicts = [{ nativeId: 'unsafe', reason: 'unsupported-recovery-url' }];
  const proposal = confirmSchema.parse({
    version: 1,
    type: 'confirmMutation',
    requestId: 'apply',
    installationId: 'i',
    epoch: 'e',
    observedRevision: 0,
    scope: ref,
    before: [],
    command: { type: 'create', parent: ref, title: 'Restored' },
    recovery: { sourceRequestId: 'source', mode: 'undo', conflicts },
  });
  const source = {
    schemaVersion: 1,
    requestId: 'source',
    request: { ...proposal, requestId: 'source', recovery: undefined },
    affected: [],
    steps: [],
    mapping: {},
  };
  render(
    createElement(RecoveryWorkbench, {
      send: async raw => {
        const message = raw as { type: string; requestId: string };
        if (message.type === 'recoveryList')
          return { status: 'ready', requestId: message.requestId, records: [source], destinations: [] };
        if (message.type === 'recoveryPreview')
          return { status: 'preview', requestId: message.requestId, proposal, conflicts, warning: 'Safe items only' };
        return { requestId: 'apply', status: 'completed', completedSteps: 1, remainingSteps: 0, needsReconcile: false };
      },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: '读取恢复记录' }));
  fireEvent.click(await screen.findByRole('button', { name: '预览撤销本批次' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: '确认以上影响范围' }));
  fireEvent.click(screen.getByRole('button', { name: '应用恢复预览' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('恢复未完整：保留 / 跳过 1 项'));
  expect(screen.queryByRole('region', { name: '恢复预览' })).not.toBeInTheDocument();
});
it('preview consent and risk consent are independent: checking one never unlocks the other', async () => {
  const { confirmSchema } = await import('../schemas/messages');
  const ref = { installationId: 'i', nativeId: 'root', kind: 'folder' };
  const proposal = confirmSchema.parse({
    version: 1,
    type: 'confirmMutation',
    requestId: 'apply',
    installationId: 'i',
    epoch: 'e',
    observedRevision: 0,
    scope: ref,
    before: [],
    command: { type: 'create', parent: ref, title: 'Restored' },
    recovery: { sourceRequestId: 'source', mode: 'undo', conflicts: [] },
  });
  const source = {
    schemaVersion: 1,
    requestId: 'source',
    request: { ...proposal, requestId: 'source', recovery: undefined },
    affected: [],
    steps: [],
    mapping: {},
  };
  render(
    createElement(RecoveryWorkbench, {
      send: async raw => {
        const message = raw as { type: string; requestId: string };
        if (message.type === 'recoveryList')
          return { status: 'ready', requestId: message.requestId, records: [source], destinations: [] };
        if (message.type === 'recoveryPreview')
          return {
            status: 'preview',
            requestId: message.requestId,
            proposal,
            conflicts: [],
            warning: 'Safe items only',
          };
        throw Error('no write may be sent while consent is being toggled');
      },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: '读取恢复记录' }));
  fireEvent.click(await screen.findByRole('button', { name: '预览撤销本批次' }));
  const apply = await screen.findByRole('button', { name: '应用恢复预览' });
  fireEvent.click(screen.getByRole('button', { name: '人工核对后隔离未知尝试' }));
  const confirmRisk = screen.getByRole('button', { name: '确认' });
  expect(apply).toBeDisabled();
  expect(confirmRisk).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: '确认以上影响范围' }));
  expect(apply).toBeEnabled();
  expect(confirmRisk).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: '我已核对并理解风险' }));
  expect(confirmRisk).toBeEnabled();
  fireEvent.click(screen.getByRole('checkbox', { name: '确认以上影响范围' }));
  expect(apply).toBeDisabled();
  expect(confirmRisk).toBeEnabled();
});
