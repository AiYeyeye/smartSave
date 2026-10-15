import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SaveCorrection } from '../panel/SaveCorrection';
import { syntheticConnectionTree } from '../adapters/ai-connection';
import type { CorrectionResponse } from '../domain/save-correction';
import { StrictMode } from 'react';

function harness() {
  const tree = syntheticConnectionTree();
  const source = tree.nodes.find(node => node.ref.kind === 'bookmark')!;
  const target = tree.nodes.find(node => node.childrenWritable && node.ref.nativeId !== source.parentId)!;
  const moved: CorrectionResponse = {
    status: 'moved',
    requestId: 'request',
    host: 'example.test',
    target: target.ref,
    targetTitle: target.title,
    previousRule: null,
  };
  let complete!: (response: CorrectionResponse) => void;
  const send = vi.fn<
    (message: Parameters<typeof import('../panel/SaveCorrection').sendCorrection>[0]) => Promise<CorrectionResponse>
  >(async message => {
    if (message.action === 'begin') return { status: 'ready', token: 'token', tree, bookmarkId: source.ref.nativeId };
    if (message.action === 'move')
      return new Promise(resolve => {
        complete = resolve;
      });
    if (message.action === 'rule') return { status: 'rule-saved' };
    return { status: 'closed' };
  });
  const view = render(<SaveCorrection receiptId="receipt" onClose={vi.fn()} send={send} />);
  return { view, send, target, moved, complete: (response: CorrectionResponse) => complete(response) };
}

it('asks about rules only after confirmed movement; default excludes subdomains and retries only rules', async () => {
  const h = harness();
  await waitFor(() => expect(screen.getByLabelText('改到目录')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('改到目录'), { target: { value: h.target.ref.nativeId } });
  fireEvent.click(screen.getByRole('button', { name: '改到这个目录' }));
  expect(screen.queryByRole('button', { name: '以后都放这里' })).not.toBeInTheDocument();
  h.complete(h.moved);
  await waitFor(() => expect(screen.getByRole('button', { name: '以后都放这里' })).toBeEnabled());
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  h.send.mockResolvedValueOnce({ status: 'error', reason: 'correction-unavailable' });
  fireEvent.click(screen.getByRole('button', { name: '以后都放这里' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '重试保存规则' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '重试保存规则' }));
  await waitFor(() => expect(screen.getByText('网站规则已保存，可在隐私与规则中修改。')).toBeVisible());
  expect(h.send.mock.calls.filter(([message]) => message.action === 'move')).toHaveLength(1);
  expect(h.send.mock.calls.filter(([message]) => message.action === 'rule').map(([message]) => message)).toEqual(
    Array.from({ length: 2 }, () => ({
      type: 'nativeSaveCorrection',
      action: 'rule',
      token: 'token',
      confirmed: true,
      includeSubdomains: false,
    })),
  );
  h.view.unmount();
});

it('unknown mutation outcome has no rule prompt or retry-move button', async () => {
  const h = harness();
  await waitFor(() => expect(screen.getByLabelText('改到目录')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('改到目录'), { target: { value: h.target.ref.nativeId } });
  fireEvent.click(screen.getByRole('button', { name: '改到这个目录' }));
  h.complete({
    status: 'result',
    result: { requestId: 'request', status: 'unknown', needsReconcile: true, completedSteps: 0, remainingSteps: 1 },
  });
  await waitFor(() => expect(screen.queryByText('正在纠正并核对结果…')).not.toBeInTheDocument());
  expect(screen.queryByRole('button', { name: '以后都放这里' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '改到这个目录' })).not.toBeInTheDocument();
  h.view.unmount();
  expect(h.send).toHaveBeenLastCalledWith({ type: 'nativeSaveCorrection', action: 'close', token: 'token' });
});

it('retires a late begin response from a cleaned-up effect instead of replacing the active token', async () => {
  const tree = syntheticConnectionTree();
  const source = tree.nodes.find(node => node.ref.kind === 'bookmark')!;
  const replies: ((value: CorrectionResponse) => void)[] = [];
  const send = vi.fn<typeof import('../panel/SaveCorrection').sendCorrection>(message =>
    message.action === 'begin' ? new Promise(resolve => replies.push(resolve)) : Promise.resolve({ status: 'closed' }),
  );
  const view = render(
    <StrictMode>
      <SaveCorrection receiptId="receipt" onClose={vi.fn()} send={send} />
    </StrictMode>,
  );
  expect(replies).toHaveLength(2);
  replies[1]!({ status: 'ready', token: 'current', tree, bookmarkId: source.ref.nativeId });
  await waitFor(() => expect(screen.getByLabelText('改到目录')).toBeEnabled());
  replies[0]!({ status: 'ready', token: 'old', tree, bookmarkId: source.ref.nativeId });
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith({ type: 'nativeSaveCorrection', action: 'close', token: 'old' }),
  );
  view.unmount();
  expect(send).toHaveBeenLastCalledWith({ type: 'nativeSaveCorrection', action: 'close', token: 'current' });
});
