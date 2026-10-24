import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SaveCorrection } from '../panel/SaveCorrection';
import { syntheticConnectionTree } from '../adapters/ai-connection';
import type { CorrectionResponse } from '../domain/save-correction';
import { StrictMode } from 'react';
import { LANGUAGE_KEY, LanguagePicker, LocaleProvider } from '../ui/i18n';

function harness(localized = false) {
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
  const card = <SaveCorrection receiptId="receipt" onClose={vi.fn()} send={send} />;
  const view = render(
    localized ? (
      <LocaleProvider>
        <LanguagePicker />
        {card}
      </LocaleProvider>
    ) : (
      card
    ),
  );
  return { view, send, target, moved, complete: (response: CorrectionResponse) => complete(response) };
}

it('language switches preserve destination, pending move and separate subdomain consent without reopening the session', async () => {
  localStorage.setItem(LANGUAGE_KEY, 'en');
  const h = harness(true);
  await screen.findByLabelText('Move to folder');
  const select = screen.getByLabelText('Move to folder');
  fireEvent.change(select, { target: { value: h.target.ref.nativeId } });
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'zh-CN' } });
  expect(screen.getByLabelText('改到目录')).toBe(select);
  expect(select).toHaveValue(h.target.ref.nativeId);
  fireEvent.click(screen.getByRole('button', { name: '改到这个目录' }));
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(screen.getByText('Moving and checking the result…')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Always save here' })).not.toBeInTheDocument();
  h.complete({ ...h.moved, targetTitle: '改一下' } as CorrectionResponse);
  await screen.findByText('Moved to “改一下”. Save future bookmarks from example.test here too?');
  fireEvent.click(screen.getByLabelText('Also include subdomains'));
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'zh-CN' } });
  expect(screen.getByLabelText('也包含此域名的子域名')).toBeChecked();
  expect(h.send.mock.calls.filter(([message]) => message.action === 'rule')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '以后都放这里' }));
  await screen.findByText('网站规则已保存，可在隐私与规则中修改。');
  expect(h.send.mock.calls.filter(([message]) => message.action === 'begin')).toHaveLength(1);
  expect(h.send.mock.calls.filter(([message]) => message.action === 'move')).toHaveLength(1);
  expect(h.send).toHaveBeenLastCalledWith({
    type: 'nativeSaveCorrection',
    action: 'rule',
    token: 'token',
    includeSubdomains: true,
    confirmed: true,
  });
  h.view.unmount();
  expect(h.send).toHaveBeenLastCalledWith({ type: 'nativeSaveCorrection', action: 'close', token: 'token' });
});

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
it('shows one editable name in general correction and labeled comparison only for name advice', async () => {
  const h = harness();
  const name = await screen.findByLabelText('书签名称');
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
  expect(screen.queryByText((name as HTMLInputElement).value)).not.toBeInTheDocument();
  h.view.unmount();
  const tree = syntheticConnectionTree();
  const source = tree.nodes.find(node => node.ref.kind === 'bookmark')!;
  const send = vi.fn<typeof import('../panel/SaveCorrection').sendCorrection>(async message =>
    message.action === 'begin'
      ? { status: 'ready', token: 'name-token', tree, bookmarkId: source.ref.nativeId, suggestedTitle: 'Specific name' }
      : { status: 'closed' },
  );
  const view = render(<SaveCorrection receiptId="name" nameOnly send={send} onClose={vi.fn()} />);
  expect(await screen.findByLabelText('原名称')).toHaveValue(source.title);
  expect(screen.getByLabelText('原名称')).toHaveAttribute('readonly');
  expect(screen.getByLabelText('书签名称')).toHaveValue('Specific name');
  expect(screen.queryByLabelText('改到目录')).not.toBeInTheDocument();
  view.unmount();
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
