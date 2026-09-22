import { createElement } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { RecoveryWorkbench } from '../options/RecoveryWorkbench';
import { ThemePicker, ThemeProvider } from '../ui/ThemeProvider';
import { confirmSchema, type Command, type ConfirmMutation } from '../schemas/messages';

type Sent = { type: string; requestId: string; [key: string]: unknown };
const root = { installationId: 'i', nativeId: 'root', kind: 'folder' } as const;
const create: Command = { type: 'create', parent: root, title: 'Restored' };
const organize: Command = {
  type: 'batch',
  operations: [
    {
      id: 'm',
      dependsOn: [],
      command: { type: 'move', target: { ...root, nativeId: 'a', kind: 'bookmark' }, parent: root, index: 0 },
    },
    {
      id: 'u',
      dependsOn: [],
      command: { type: 'update', target: { ...root, nativeId: 'b', kind: 'bookmark' }, changes: { title: 'B' } },
    },
  ],
  selectedOperationIds: ['m', 'u'],
};
function request(requestId: string, command: Command, recovery?: ConfirmMutation['recovery']): ConfirmMutation {
  return confirmSchema.parse({
    version: 1,
    type: 'confirmMutation',
    requestId,
    installationId: 'i',
    epoch: 'e',
    observedRevision: 0,
    scope: root,
    before: [],
    command,
    recovery,
  });
}
const receipt = {
  step: { type: 'create', parentId: 'root', title: 'Restored', temporaryId: 't' },
  state: 'receipt',
  returnedNativeId: 'n1',
};
const completed = (requestId: string) => ({
  requestId,
  status: 'completed',
  completedSteps: 1,
  remainingSteps: 0,
  needsReconcile: false,
});
/** A settled v1 record with one receipt: the shape the undo shortlist lists. */
function settled(requestId: string, command: Command = create, createdAt?: string) {
  return {
    schemaVersion: 1,
    requestId,
    request: request(requestId, command),
    affected: [],
    steps: [receipt],
    mapping: {},
    result: completed(requestId),
    createdAt,
  };
}
/** An unknown-outcome v1 record: interrupted (no result) or explicitly unknown (result that still needs reconcile). */
function unsettled(requestId: string, withResult: boolean) {
  return {
    schemaVersion: 1,
    requestId,
    request: request(requestId, create),
    affected: [],
    steps: [{ ...receipt, state: 'intent', returnedNativeId: undefined }],
    mapping: {},
    result: withResult
      ? { requestId, status: 'unknown', needsReconcile: true, completedSteps: 0, remainingSteps: 1, reason: 'readback' }
      : undefined,
  };
}
function ready(requestId: string, records: unknown[], destinations: unknown[] = []) {
  return { status: 'ready', requestId, records, destinations };
}
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
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('传输或响应不可用'));
  expect(calls).toBe(1);
  for (const radio of screen.getAllByRole('radio')) {
    fireEvent.click(radio);
    expect(screen.getByRole('alert')).toHaveTextContent('写入结果可能未知');
  }
  expect(calls).toBe(1);
  expect(screen.getByText('暂无可撤销的操作。')).toBeInTheDocument();
  expect(screen.getByText('没有需要处理的异常。')).toBeInTheDocument();
});
it('loads the journal once when first visible, not while hidden, and only the refresh button re-reads it', async () => {
  const sent: Sent[] = [];
  const send = async (raw: unknown) => {
    const message = raw as Sent;
    sent.push(message);
    return ready(message.requestId, []);
  };
  const view = render(createElement(RecoveryWorkbench, { send, visible: false }));
  await act(async () => {});
  expect(sent).toHaveLength(0);
  view.rerender(createElement(RecoveryWorkbench, { send, visible: true }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]!.type).toBe('recoveryList');
  view.rerender(createElement(RecoveryWorkbench, { send, visible: false }));
  view.rerender(createElement(RecoveryWorkbench, { send, visible: true }));
  await act(async () => {});
  expect(sent).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '刷新恢复记录' }));
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]!.type).toBe('recoveryList');
  view.unmount();
  // Hosts mount the workbench inside hidden containers without passing visible: the hidden ancestor defers the load.
  const hosted = (hidden: boolean) => createElement('div', { hidden }, createElement(RecoveryWorkbench, { send }));
  const host = render(hosted(true));
  await act(async () => {});
  expect(sent).toHaveLength(2);
  host.rerender(hosted(false));
  await waitFor(() => expect(sent).toHaveLength(3));
});
it('lists completed batches newest first under undo and previews them with mode undo', async () => {
  const sent: Sent[] = [];
  const proposal = request('apply', create, { sourceRequestId: 'organize', mode: 'undo', conflicts: [] });
  render(
    createElement(RecoveryWorkbench, {
      send: async (raw: unknown) => {
        const message = raw as Sent;
        sent.push(message);
        if (message.type === 'recoveryList')
          return ready(message.requestId, [
            settled('saved', create, '2026-09-22T01:00:00.000Z'),
            settled('organize', organize, '2026-09-22T02:00:00.000Z'),
            unsettled('interrupted', false),
          ]);
        return { status: 'preview', requestId: message.requestId, proposal, conflicts: [], warning: 'Safe items only' };
      },
    }),
  );
  const region = await screen.findByRole('region', { name: '撤销最近操作' });
  const items = within(region).getAllByRole('listitem');
  expect(items).toHaveLength(2);
  expect(items[0]).toHaveTextContent('整理批次');
  expect(items[0]).toHaveTextContent('已完成 · 1/1 步有回执');
  expect(items[1]).toHaveTextContent('收藏');
  expect(within(region).queryByText(/interrupted/)).toBeNull();
  fireEvent.click(within(items[0]!).getByRole('button', { name: '预览撤销' }));
  const preview = await screen.findByRole('region', { name: '恢复预览' });
  expect(sent.at(-1)).toMatchObject({ type: 'recoveryPreview', mode: 'undo', sourceRequestId: 'organize' });
  expect(within(preview).getByRole('heading', { name: '撤销影响预览' })).toBeInTheDocument();
  expect(within(preview).getByText('新建「Restored」 → 目录 root')).toBeInTheDocument();
  expect(within(preview).getByRole('button', { name: '应用撤销' })).toBeDisabled();
  fireEvent.click(within(preview).getByRole('button', { name: '取消预览' }));
  expect(screen.queryByRole('region', { name: '恢复预览' })).toBeNull();
  expect(sent.at(-1)).toMatchObject({ type: 'recoveryDiscard', proposalRequestId: 'apply' });
});
it('lists unknown records under attention with reconcile, stop-only-when-interrupted and quarantine', async () => {
  const sent: Sent[] = [];
  render(
    createElement(RecoveryWorkbench, {
      send: async (raw: unknown) => {
        const message = raw as Sent;
        sent.push(message);
        if (message.type === 'recoveryList')
          return ready(message.requestId, [
            unsettled('interrupted', false),
            unsettled('unknown', true),
            {
              ...unsettled('quarantined', true),
              quarantine: { acknowledgedAt: '2026-09-22T00:00:00.000Z', epoch: 'e', observedRevision: 1 },
            },
            settled('done'),
          ]);
        return {
          requestId: message.requestId,
          status: 'unknown',
          needsReconcile: true,
          completedSteps: 0,
          remainingSteps: 1,
        };
      },
    }),
  );
  const region = await screen.findByRole('region', { name: '需要你处理' });
  const items = within(region).getAllByRole('listitem');
  expect(items).toHaveLength(2);
  for (const item of items) expect(item).toHaveTextContent('结果未知，需人工核对');
  expect(within(region).queryByText(/quarantined/)).toBeNull();
  expect(within(region).queryByText(/done/)).toBeNull();
  const interrupted = items.find(item => item.textContent?.includes('interrupted'))!;
  const unknown = items.find(item => item.textContent?.includes('unknown'))!;
  expect(within(interrupted).getByRole('button', { name: '停止未发起步骤' })).toBeEnabled();
  expect(within(unknown).queryByRole('button', { name: '停止未发起步骤' })).toBeNull();
  expect(unknown).toHaveTextContent('原因：readback');
  fireEvent.click(within(interrupted).getByRole('button', { name: '核对当前状态（不重放）' }));
  await waitFor(() => expect(sent.at(-1)).toMatchObject({ type: 'recoveryList' }));
  expect(sent.at(-2)).toMatchObject({ type: 'reconcileMutation', requestId: 'interrupted' });
  expect(screen.getByRole('alert')).toHaveTextContent('interrupted：执行子计划 unknown');
  fireEvent.click(within(interrupted).getByRole('button', { name: '停止未发起步骤' }));
  await waitFor(() => expect(sent.some(m => m.type === 'cancelMutation' && m.requestId === 'interrupted')).toBe(true));
  fireEvent.click(within(unknown).getByRole('button', { name: '人工核对后隔离' }));
  const risk = screen.getByRole('region', { name: '恢复风险确认' });
  expect(within(risk).getByRole('button', { name: '确认' })).toBeDisabled();
  fireEvent.click(within(risk).getByRole('checkbox', { name: '我已核对并理解风险' }));
  fireEvent.click(within(risk).getByRole('button', { name: '确认' }));
  await waitFor(() =>
    expect(sent.some(m => m.type === 'quarantineMutation' && m.requestId === 'unknown' && m.confirmed === true)).toBe(
      true,
    ),
  );
  expect(screen.queryByRole('region', { name: '恢复风险确认' })).toBeNull();
});
it('keeps merge, copy and cleanup behind a collapsed advanced section that still drives every message', async () => {
  const sent: Sent[] = [];
  const folder = {
    ref: { installationId: 'i', nativeId: 'f', kind: 'folder' },
    parentId: 'root',
    index: 0,
    title: 'Folder',
    childrenIds: [],
    readOnly: false,
    childrenWritable: true,
    observedRevision: 0,
  };
  const destination = { ...folder, ref: root, parentId: undefined, title: 'Root', readOnly: true };
  const { container } = render(
    createElement(RecoveryWorkbench, {
      send: async (raw: unknown) => {
        const message = raw as Sent;
        sent.push(message);
        if (message.type === 'recoveryList')
          return ready(
            message.requestId,
            [{ ...settled('done'), backup: { installationId: 'i', nodes: [folder] } }],
            [destination],
          );
        if (message.type === 'recoveryPreview')
          return { status: 'preview', requestId: message.requestId, conflicts: [], warning: 'Nothing eligible' };
        return { status: 'cleaned', requestId: message.requestId };
      },
    }),
  );
  await screen.findByRole('region', { name: '完整恢复记录' });
  const details = container.querySelector('details.recovery-advanced')!;
  expect(details).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('高级：合并恢复、副本恢复、清理快照与完整记录'));
  expect(details).toHaveAttribute('open');
  const advanced = screen.getByRole('region', { name: '完整恢复记录' });
  expect(within(advanced).getByText('新建：有回执，ID n1')).toBeInTheDocument();
  fireEvent.click(within(advanced).getByRole('button', { name: '独立预览合并恢复' }));
  await screen.findByRole('region', { name: '恢复预览' });
  expect(sent.at(-1)).toMatchObject({ type: 'recoveryPreview', mode: 'merge', sourceRequestId: 'done' });
  expect(screen.getByRole('heading', { name: '合并恢复影响预览' })).toBeInTheDocument();
  expect(screen.getByText('没有可安全应用的项目；当前数据保持不变。')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '取消预览' }));
  fireEvent.click(within(advanced).getByRole('button', { name: '恢复为新副本（可能重复）' }));
  const copy = screen.getByRole('region', { name: '副本恢复选择' });
  expect(within(copy).getByRole('button', { name: '预览新副本' })).toBeDisabled();
  fireEvent.change(within(copy).getByLabelText('当前目标目录'), { target: { value: 'root' } });
  fireEvent.click(within(copy).getByRole('checkbox', { name: 'Folder · f（目录包含子树）' }));
  fireEvent.click(within(copy).getByRole('button', { name: '预览新副本' }));
  await screen.findByRole('heading', { name: '新副本影响预览' });
  expect(sent.at(-1)).toMatchObject({
    type: 'recoveryPreview',
    mode: 'copy',
    sourceRequestId: 'done',
    destination: root,
    selectedNativeIds: ['f'],
  });
  fireEvent.click(screen.getByRole('button', { name: '取消预览' }));
  fireEvent.click(within(advanced).getByRole('button', { name: '清理恢复快照' }));
  const risk = screen.getByRole('region', { name: '恢复风险确认' });
  expect(risk).toHaveTextContent('清理将失去本批次撤销与备份恢复能力');
  fireEvent.click(within(risk).getByRole('checkbox', { name: '我已核对并理解风险' }));
  fireEvent.click(within(risk).getByRole('button', { name: '确认' }));
  await waitFor(() => expect(screen.getByText(/已清理恢复快照/)).toBeInTheDocument());
  expect(sent.some(m => m.type === 'recoveryCleanup' && m.sourceRequestId === 'done' && m.confirmed === true)).toBe(
    true,
  );
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
  const conflicts = [{ nativeId: 'unsafe', reason: 'unsupported-recovery-url' }];
  const restored = {
    ...settled('restored'),
    request: request('restored', create, { sourceRequestId: 'source', mode: 'undo', conflicts }),
  };
  render(
    createElement(RecoveryWorkbench, {
      send: async raw => {
        const message = raw as Sent;
        if (message.type === 'recoveryList') return ready(message.requestId, [restored]);
        return completed('restored');
      },
    }),
  );
  // A recovery operation is history, not undoable: it lives in the advanced record list.
  const advanced = await screen.findByRole('region', { name: '完整恢复记录' });
  expect(within(advanced).getByText(/恢复未完整/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '预览撤销' })).toBeNull();
  fireEvent.click(screen.getByText('高级：合并恢复、副本恢复、清理快照与完整记录'));
  fireEvent.click(within(advanced).getByRole('button', { name: '核对当前状态（不重放）' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('恢复未完整：保留 / 跳过 1 项'));
  expect(screen.getByRole('alert')).toHaveTextContent('unsupported-recovery-url');
});
it('retains skipped coverage when applying and clearing the preview', async () => {
  const conflicts = [{ nativeId: 'unsafe', reason: 'unsupported-recovery-url' }];
  const proposal = request('apply', create, { sourceRequestId: 'source', mode: 'undo', conflicts });
  render(
    createElement(RecoveryWorkbench, {
      send: async raw => {
        const message = raw as Sent;
        if (message.type === 'recoveryList') return ready(message.requestId, [settled('source')]);
        if (message.type === 'recoveryPreview')
          return { status: 'preview', requestId: message.requestId, proposal, conflicts, warning: 'Safe items only' };
        return completed('apply');
      },
    }),
  );
  fireEvent.click(await screen.findByRole('button', { name: '预览撤销' }));
  expect(await screen.findByText('保留 / 跳过 unsafe：unsupported-recovery-url')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: '确认以上影响范围' }));
  fireEvent.click(screen.getByRole('button', { name: '应用撤销' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('恢复未完整：保留 / 跳过 1 项'));
  expect(screen.queryByRole('region', { name: '恢复预览' })).not.toBeInTheDocument();
});
it('preview consent and risk consent are independent: checking one never unlocks the other', async () => {
  const proposal = request('apply', create, { sourceRequestId: 'source', mode: 'undo', conflicts: [] });
  render(
    createElement(RecoveryWorkbench, {
      send: async raw => {
        const message = raw as Sent;
        if (message.type === 'recoveryList')
          return ready(message.requestId, [settled('source'), unsettled('unknown', true)]);
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
  fireEvent.click(await screen.findByRole('button', { name: '预览撤销' }));
  const apply = await screen.findByRole('button', { name: '应用撤销' });
  fireEvent.click(screen.getByRole('button', { name: '人工核对后隔离' }));
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
