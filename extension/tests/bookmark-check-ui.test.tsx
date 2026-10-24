import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BookmarkCheck } from '../panel/BookmarkCheck';
import { PanelFooter } from '../ui/PanelChrome';
import { LocaleProvider, LANGUAGE_KEY } from '../ui/i18n';
import { organizerTree } from './fixtures/organizer-tree';
import { emptyBookmarkCheck, type BookmarkCheckState } from '../domain/bookmark-check';
import type { TreeState } from '../domain/node-reference';
import type { CheckClient } from '../panel/bookmark-check-client';
import type { SendMutation } from '../panel/mutation-client';
let publish: (state: TreeState) => void;
vi.mock('../panel/tree-client', () => ({
  connectTree: (_runtime: unknown, receive: typeof publish) => {
    publish = receive;
    receive({ status: 'ready', snapshot: organizerTree() });
    return () => {};
  },
}));
beforeEach(() => vi.stubGlobal('chrome', { runtime: {} }));
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  let state: BookmarkCheckState = emptyBookmarkCheck();
  const events: string[] = [];
  const client = vi.fn<CheckClient>(async message => {
    events.push(message.action);
    if (message.action === 'configure')
      state = { ...state, revision: state.revision + 1, scopeId: message.scopeId, weekly: message.weekly };
    return state;
  });
  const permission = vi.fn(async () => {
    events.push('permission');
    return true;
  });
  const send = vi.fn<SendMutation>(async request => ({
    requestId: request.requestId,
    status: 'completed',
    needsReconcile: false,
    completedSteps: 1,
    remainingSteps: 0,
  }));
  const recovery = vi.fn();
  render(
    <LocaleProvider>
      <BookmarkCheck client={client} permission={permission} send={send} onRecovery={recovery} />
    </LocaleProvider>,
  );
  return { client, permission, send, recovery, events };
}
it('uses explicit keep/delete choices, retains them through locale changes and confirms before writing', async () => {
  const f = fixture();
  await waitFor(() => expect(screen.getByRole('button', { name: '立即检查' })).toBeEnabled());
  fireEvent.click(screen.getByRole('tab', { name: /重复收藏/ }));
  fireEvent.change(screen.getByLabelText('b 保留或删除'), { target: { value: 'delete' } });
  fireEvent.click(screen.getByRole('button', { name: '删除所选 1 项' }));
  expect(screen.getByRole('alert')).toHaveTextContent('请先为每组选择至少一项保留');
  expect(f.send).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('a 保留或删除'), { target: { value: 'keep' } });
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_KEY, newValue: 'en' })));
  expect(screen.getByLabelText('Keep or delete b')).toHaveValue('delete');
  fireEvent.click(screen.getByRole('button', { name: 'Delete 1 selected' }));
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(f.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
  await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  expect(f.send.mock.calls[0]![0].command).toMatchObject({
    type: 'batch',
    operations: [{ command: { type: 'remove', target: { nativeId: 'b' } } }],
  });
});
it('invalidates a confirmed preview when native content changes and never replays an unknown outcome', async () => {
  const f = fixture();
  await waitFor(() => expect(screen.getByRole('button', { name: '立即检查' })).toBeEnabled());
  fireEvent.click(screen.getByRole('tab', { name: /重复收藏/ }));
  fireEvent.change(screen.getByLabelText('a 保留或删除'), { target: { value: 'keep' } });
  fireEvent.change(screen.getByLabelText('b 保留或删除'), { target: { value: 'delete' } });
  fireEvent.click(screen.getByRole('button', { name: '删除所选 1 项' }));
  const changed = organizerTree();
  changed.observedRevision = 2;
  act(() => publish({ status: 'ready', snapshot: changed }));
  expect(screen.getByRole('button', { name: '确认删除' })).toBeDisabled();
  expect(f.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  fireEvent.click(screen.getByRole('button', { name: '删除所选 1 项' }));
  f.send.mockRejectedValueOnce(Error('lost reply'));
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '查看恢复记录' })).toBeVisible());
  expect(screen.getByRole('button', { name: '删除所选 1 项' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '查看恢复记录' }));
  expect(f.recovery).toHaveBeenCalledTimes(1);
  expect(f.send).toHaveBeenCalledTimes(1);
});
it('requests website permission directly from the click before scheduling, and exposes a compact sidebar entry', async () => {
  const f = fixture();
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '每周自动检查' })).toBeEnabled());
  f.events.length = 0;
  fireEvent.click(screen.getByRole('checkbox', { name: '每周自动检查' }));
  await waitFor(() => expect(f.events).toEqual(['permission', 'configure']));
  expect(screen.getByLabelText('帮助').closest('details')).not.toHaveAttribute('open');
  const check = vi.fn();
  render(
    <LocaleProvider>
      <PanelFooter onCheck={check} onOrganize={() => {}} onImport={() => {}} onExport={() => {}} onBatch={() => {}} />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '检查' }));
  expect(check).toHaveBeenCalledOnce();
});
