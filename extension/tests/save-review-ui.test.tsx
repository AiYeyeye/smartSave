import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SaveReviewForm, SaveReviewLauncher, SaveReviewQueue, pendingSaveReceipts } from '../panel/SaveReview';
import { LanguagePicker, LocaleProvider } from '../ui/i18n';
import type { SaveReceipt } from '../persistence/save-receipts';
import { draftKey, SAVE_CONFIRM_QUEUE_KEY } from '../persistence/save-confirm';
import type { CorrectionMessage, CorrectionResponse } from '../domain/save-correction';
import type { TreeSnapshot } from '../domain/node-reference';

const installationId = 'popup-test';
const folder = (nativeId: string, title: string, parentId: string | undefined, childrenIds: string[]) => ({
  ref: { installationId, nativeId, kind: 'folder' as const },
  title,
  parentId,
  index: 0,
  childrenIds,
  readOnly: false,
  childrenWritable: true,
  observedRevision: 1,
});
/** Five levels below the browser's untitled root, with siblings at each level. */
const tree: TreeSnapshot = {
  installationId,
  epoch: 'test',
  observedRevision: 1,
  roots: ['root'],
  nodes: [
    { ...folder('root', '', undefined, ['bar', 'other']), childrenWritable: false },
    folder('bar', '书签栏', 'root', ['dev', 'read']),
    folder('dev', '开发', 'bar', ['front', 'back']),
    folder('front', '前端', 'dev', ['react']),
    folder('react', 'React', 'front', ['hooks', 'mark']),
    folder('hooks', 'Hooks', 'react', []),
    folder('back', '后端', 'dev', []),
    folder('read', '阅读', 'bar', []),
    folder('other', '其他书签', 'root', []),
    {
      ref: { installationId, nativeId: 'mark', kind: 'bookmark' as const },
      title: 'Original title',
      parentId: 'react',
      index: 1,
      childrenIds: [],
      readOnly: false,
      childrenWritable: false,
      observedRevision: 1,
      url: 'https://example.test/page',
    },
  ],
};
const receipt: SaveReceipt = {
  id: 'first',
  bookmarkId: 'mark',
  installationId,
  title: 'Original title',
  url: 'https://example.test/page',
  at: Date.now(),
  status: 'moved',
  source: 'ai',
  fromParentId: 'bar',
  fromIndex: 0,
  fromPath: '书签栏',
  toId: 'react',
  toPath: '书签栏 / 开发 / 前端 / React',
  suggestedTitle: 'AI title',
  nameStatus: 'ready',
};
const second: SaveReceipt = { ...receipt, id: 'second', bookmarkId: 'mark-2', suggestedTitle: 'Second suggestion' };

function harness({
  receipts = [receipt],
  queue = ['first'],
  suggestions = { first: 'AI title', second: 'Second suggestion' } as Record<string, string | undefined>,
  session = {} as Record<string, unknown>,
} = {}) {
  const local: Record<string, unknown> = { nativeSaveReceipts: receipts };
  const stored: Record<string, unknown> = { [SAVE_CONFIRM_QUEUE_KEY]: queue, ...session };
  type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;
  const listeners = new Set<Listener>();
  const area = (data: Record<string, unknown>) => ({
    get: vi.fn(async (key: string | string[]) =>
      Object.fromEntries(
        (Array.isArray(key) ? key : [key])
          .filter(item => item in data)
          .map(item => [item, structuredClone(data[item])]),
      ),
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, structuredClone(items));
    }),
    remove: vi.fn(async (key: string | string[]) => {
      for (const item of Array.isArray(key) ? key : [key]) delete data[item];
    }),
  });
  const sendMessage = vi.fn<(message: unknown) => Promise<unknown>>(async () => ({ status: 'done' }));
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    storage: {
      local: area(local),
      session: area(stored),
      onChanged: {
        addListener: (fn: Listener) => listeners.add(fn),
        removeListener: (fn: Listener) => listeners.delete(fn),
      },
    },
  });
  const send = vi.fn(async (message: CorrectionMessage): Promise<CorrectionResponse> => {
    if (message.action !== 'begin') return { status: 'closed' };
    const suggestedTitle = suggestions[message.receiptId];
    return {
      status: 'ready',
      token: `${message.receiptId}-token`,
      tree,
      bookmarkId: 'mark',
      ...(suggestedTitle ? { suggestedTitle } : {}),
    };
  });
  const emit = (changes: Record<string, { newValue?: unknown }>, name: string) =>
    act(() => listeners.forEach(fn => fn(changes, name)));
  return {
    send,
    sendMessage,
    stored,
    suggestions,
    reviews: () => send.mock.calls.filter(([message]) => message.action === 'review'),
    done: () =>
      sendMessage.mock.calls
        .map(([message]) => message as { type?: string; receiptId?: string })
        .filter(message => message.type === 'saveConfirmDone')
        .map(message => message.receiptId),
    publishReceipts: (next: SaveReceipt[]) => {
      local.nativeSaveReceipts = next;
      return emit({ nativeSaveReceipts: { newValue: next } }, 'local');
    },
    publishQueue: (next: string[]) => {
      stored[SAVE_CONFIRM_QUEUE_KEY] = next;
      return emit({ [SAVE_CONFIRM_QUEUE_KEY]: { newValue: next } }, 'session');
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

it('offers explicit AI retry after refusal, prevents double clicks and preserves an edited draft', async () => {
  const failed: SaveReceipt = { ...receipt, status: 'failed', reason: 'refused', suggestedTitle: undefined };
  const h = harness({ receipts: [failed], suggestions: {} });
  let fail!: (error: Error) => void;
  const retry = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
  );
  render(
    <SaveReviewForm
      receipt={failed}
      send={h.send}
      retry={retry}
      onComplete={vi.fn()}
      onLater={vi.fn()}
      onDismiss={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
  const name = await screen.findByRole('textbox', { name: '名称' });
  fireEvent.change(name, { target: { value: 'My draft' } });
  const button = screen.getByRole('button', { name: '重新 AI 识别' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(retry).toHaveBeenCalledTimes(1);
  expect(retry).toHaveBeenCalledWith('first');
  expect(name).toBeDisabled();
  expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
  await act(async () => fail(Error('disconnected')));
  expect(screen.getByRole('alert')).toHaveTextContent('未能开始识别');
  expect(button).toBeEnabled();
  expect(name).toHaveValue('My draft');
  expect(h.reviews()).toHaveLength(0);
});

it('shows a pending retry after reopening and keeps uncertain native writes out of the retry entrypoint', async () => {
  const failed: SaveReceipt = {
    ...receipt,
    status: 'failed',
    reason: 'refused',
    aiRetry: { id: 'request', status: 'pending' },
  };
  const h = harness({ receipts: [failed] });
  render(<SaveReviewQueue send={h.send} onOpen={vi.fn()} />);
  expect(await screen.findByText('AI 正在重新识别…')).toBeVisible();
  expect(h.send).not.toHaveBeenCalled();
  h.publishReceipts([{ ...failed, reason: 'native-write-uncertain', aiRetry: undefined }]);
  await screen.findByRole('textbox', { name: /名称/ });
  expect(screen.queryByRole('button', { name: '重新 AI 识别' })).toBeNull();
});

it('removes a stale reminder only after durable acknowledgement and offers retry on failure', async () => {
  const h = harness();
  h.send.mockResolvedValue({ status: 'error', reason: 'stale-correction' });
  const close = vi.fn();
  render(<SaveReviewQueue onOpen={vi.fn()} onClose={close} send={h.send} />);
  const remove = await screen.findByRole('button', { name: '移出列表' });
  h.sendMessage.mockResolvedValueOnce({ status: 'error' });
  fireEvent.click(remove);
  await screen.findByText('未能移出，请重试。');
  expect(close).not.toHaveBeenCalled();
  expect(remove).toBeEnabled();
  let ack!: (value: unknown) => void;
  h.sendMessage.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        ack = resolve;
      }),
  );
  fireEvent.click(remove);
  expect(remove).toBeDisabled();
  expect(close).not.toHaveBeenCalled();
  await act(async () => ack({ status: 'done' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(h.sendMessage).toHaveBeenCalledWith({ type: 'saveConfirmDismiss', receiptId: 'first' });
  expect(h.reviews()).toEqual([]);
  expect(h.done()).toEqual([]);
});

it('an idle popup renews its session on one click and preserves the edited name and folder', async () => {
  const h = harness();
  const close = vi.fn();
  render(<SaveReviewQueue onOpen={vi.fn()} onClose={close} send={h.send} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '名称' }), { target: { value: 'Idle draft' } });
  fireEvent.click(screen.getByRole('button', { name: /^文件夹：/ }));
  fireEvent.click(screen.getByRole('treeitem', { name: '阅读' }));
  // The old worker's token is gone. Unrelated edits and a new epoch must not invalidate this user's choice.
  const freshTree = structuredClone(tree);
  freshTree.epoch = 'restarted';
  freshTree.observedRevision++;
  freshTree.nodes.find(node => node.ref.nativeId === 'back')!.title = 'Unrelated change';
  h.send.mockImplementation(async message => {
    if (message.action === 'begin') return { status: 'ready', token: 'fresh', tree: freshTree, bookmarkId: 'mark' };
    if (message.action === 'review' && message.token !== 'fresh') return { status: 'error', reason: 'session-expired' };
    return { status: 'closed' };
  });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(h.reviews()).toEqual([
    [{ type: 'nativeSaveCorrection', action: 'review', token: 'fresh', title: 'Idle draft', targetId: 'read' }],
  ]);
});

it.each(['mark', 'read', 'bar'])(
  'refreshing detects a changed bookmark or folder path (%s) before writing',
  async id => {
    const h = harness();
    render(<SaveReviewQueue onOpen={vi.fn()} send={h.send} />);
    fireEvent.change(await screen.findByRole('textbox', { name: '名称' }), { target: { value: 'My draft' } });
    fireEvent.click(screen.getByRole('button', { name: /^文件夹：/ }));
    fireEvent.click(screen.getByRole('treeitem', { name: '阅读' }));
    const freshTree = structuredClone(tree);
    freshTree.nodes.find(node => node.ref.nativeId === id)!.title = 'Changed elsewhere';
    h.send.mockImplementationOnce(async () => ({
      status: 'ready',
      token: 'fresh',
      tree: freshTree,
      bookmarkId: 'mark',
    }));
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('书签或目录有变化，请核对后再确认。');
    expect(screen.getByRole('textbox', { name: '名称' })).toHaveValue('My draft');
    expect(screen.getByRole('treeitem', { name: id === 'read' ? 'Changed elsewhere' : '阅读' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('button', { name: '保存修改' })).toBeEnabled();
    expect(h.reviews()).toHaveLength(0);
  },
);

it('a deleted draft destination requires a new selection instead of silently choosing another folder', async () => {
  const h = harness();
  render(<SaveReviewQueue onOpen={vi.fn()} send={h.send} />);
  await screen.findByRole('textbox', { name: '名称' });
  fireEvent.click(screen.getByRole('button', { name: /^文件夹：/ }));
  fireEvent.click(screen.getByRole('treeitem', { name: '阅读' }));
  const freshTree = structuredClone(tree);
  freshTree.nodes = freshTree.nodes.filter(node => node.ref.nativeId !== 'read');
  h.send.mockImplementationOnce(async () => ({ status: 'ready', token: 'fresh', tree: freshTree, bookmarkId: 'mark' }));
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: '文件夹：请明确选择目录' })).toBeVisible();
  expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
  expect(h.reviews()).toHaveLength(0);
});

it.each(['transport-unavailable', 'correction-unavailable', 'correction-unsettled'])(
  'an uncertain review (%s) stays locked and offers recovery without resubmitting',
  async reason => {
    const h = harness();
    const open = vi.fn();
    render(<SaveReviewQueue onOpen={open} send={h.send} />);
    await screen.findByRole('textbox', { name: '名称' });
    const original = h.send.getMockImplementation()!;
    h.send.mockImplementation(async message =>
      message.action === 'review' ? { status: 'error', reason } : original(message),
    );
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '名称' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(h.reviews()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '查看恢复记录' }));
    expect(open).toHaveBeenCalledWith('recovery');
  },
);

it('closing while the fresh session loads never submits a write', async () => {
  const h = harness();
  const view = render(<SaveReviewQueue onOpen={vi.fn()} send={h.send} />);
  await screen.findByRole('textbox', { name: '名称' });
  let answer!: (response: CorrectionResponse) => void;
  h.send.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        answer = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  view.unmount();
  await act(async () => answer({ status: 'ready', token: 'late', tree, bookmarkId: 'mark' }));
  expect(h.reviews()).toHaveLength(0);
  expect(h.send).toHaveBeenCalledWith({ type: 'nativeSaveCorrection', action: 'close', token: 'late' });
});

it('the sidebar launcher contains no receipt editor and only asks the worker to open the popup', async () => {
  const h = harness();
  render(<SaveReviewLauncher />);
  expect(await screen.findByRole('button', { name: '待确认 1 项' })).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(h.sendMessage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '待确认 1 项' }));
  await waitFor(() => expect(h.sendMessage).toHaveBeenCalledWith({ type: 'openSaveDialog' }));
});

it('shows the AI name and folder in a real tree and confirms both in one request', async () => {
  const h = harness();
  const close = vi.fn();
  render(<SaveReviewQueue onOpen={vi.fn()} onClose={close} send={h.send} />);
  expect(await screen.findByRole('textbox', { name: '名称' })).toHaveValue('AI title');
  expect(screen.getByRole('heading', { name: '已收藏 · AI 已归类' })).toBeVisible();
  expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '文件夹：书签栏 / 开发 / 前端 / React' }));
  // Opened on the current folder: every ancestor is expanded, the folder is selected, nothing below it is open.
  for (const name of ['书签栏', '开发', '前端'])
    expect(screen.getByRole('treeitem', { name })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('treeitem', { name: 'React' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('treeitem', { name: 'React' })).toHaveAttribute('aria-level', '4');
  expect(screen.getByRole('treeitem', { name: '阅读' })).toBeVisible();
  expect(screen.queryByRole('treeitem', { name: 'Hooks' })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '展开目录：React' }));
  fireEvent.click(screen.getByRole('treeitem', { name: 'Hooks' }));
  fireEvent.click(screen.getByRole('button', { name: '收起目录：开发' }));
  expect(screen.queryByRole('treeitem', { name: 'Hooks' })).not.toBeInTheDocument();
  expect(h.reviews()).toHaveLength(0);
  const confirm = screen.getByRole('button', { name: '保存修改' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(h.reviews()).toEqual([
    [{ type: 'nativeSaveCorrection', action: 'review', token: 'first-token', title: 'AI title', targetId: 'hooks' }],
  ]);
  expect(h.done()).toEqual(['first']);
});

it('new queue entries and late results never replace edited fields; later moves on without writing', async () => {
  const h = harness();
  render(<SaveReviewQueue onOpen={vi.fn()} send={h.send} />);
  const input = await screen.findByRole('textbox', { name: '名称' });
  fireEvent.change(input, { target: { value: 'My draft' } });
  h.suggestions.first = 'Late advice';
  await h.publishReceipts([second, { ...receipt, suggestedTitle: 'Late advice', nameStatus: 'ready', toPath: 'x' }]);
  await h.publishQueue(['first', 'second']);
  expect(await screen.findByText('1/2')).toBeVisible();
  await waitFor(() => expect(h.send.mock.calls.filter(([m]) => m.action === 'begin').length).toBeGreaterThan(1));
  expect(screen.getByRole('textbox', { name: '名称' })).toBe(input);
  expect(input).toHaveValue('My draft');
  fireEvent.click(screen.getByRole('button', { name: '稍后处理' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '名称' })).toHaveValue('Second suggestion'));
  expect(screen.queryByText('1/2')).not.toBeInTheDocument();
  expect(h.done()).toEqual(['first']);
  expect(h.reviews()).toHaveLength(0);
});

it('untouched fields follow a newer result', async () => {
  const h = harness({ receipts: [{ ...receipt, suggestedTitle: undefined }], suggestions: {} });
  render(<SaveReviewQueue onOpen={vi.fn()} send={h.send} />);
  const input = await screen.findByRole('textbox', { name: '名称' });
  expect(input).toHaveValue('Original title');
  expect(screen.getByRole('button', { name: '完成' })).toBeEnabled();
  h.suggestions.first = 'Fresh advice';
  await h.publishReceipts([{ ...receipt, suggestedTitle: 'Fresh advice' }]);
  await waitFor(() => expect(input).toHaveValue('Fresh advice'));
  expect(screen.getByRole('button', { name: '保存修改' })).toBeEnabled();
});

it('a popup closed mid-edit reopens with the same name, folder and expanded branches', async () => {
  const h = harness();
  const view = render(<SaveReviewQueue onOpen={vi.fn()} send={h.send} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '名称' }), { target: { value: 'Draft name' } });
  fireEvent.click(screen.getByRole('button', { name: /^文件夹：/ }));
  fireEvent.click(screen.getByRole('button', { name: '展开目录：React' }));
  fireEvent.click(screen.getByRole('treeitem', { name: '阅读' }));
  await waitFor(() =>
    expect(h.stored[draftKey('first')]).toMatchObject({
      title: 'Draft name',
      titleEdited: true,
      folderId: 'read',
      folderEdited: true,
      treeOpen: true,
    }),
  );
  view.unmount();
  expect(h.done()).toEqual([]);
  render(<SaveReviewQueue onOpen={vi.fn()} send={h.send} />);
  expect(await screen.findByRole('textbox', { name: '名称' })).toHaveValue('Draft name');
  expect(screen.getByRole('treeitem', { name: '阅读' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('treeitem', { name: 'Hooks' })).toBeVisible();
  expect(screen.getByRole('button', { name: '文件夹：书签栏 / 阅读' })).toHaveAttribute('aria-expanded', 'true');
  expect(h.reviews()).toHaveLength(0);
});

it('confirming without changes only finishes the review', async () => {
  const h = harness({ receipts: [{ ...receipt, suggestedTitle: undefined }], suggestions: {} });
  render(<SaveReviewQueue onOpen={vi.fn()} send={h.send} />);
  await screen.findByRole('textbox', { name: '名称' });
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  await waitFor(() => expect(h.done()).toEqual(['first']));
  expect(h.reviews()[0]![0]).toMatchObject({ title: 'Original title', targetId: 'react' });
});

it('an entry still being classified waits; later shows the next one', async () => {
  const h = harness({
    receipts: [{ ...receipt, id: 'busy', bookmarkId: 'other-mark', status: 'classifying' }, receipt],
    queue: ['busy', 'first'],
  });
  render(<SaveReviewQueue onOpen={vi.fn()} send={h.send} />);
  expect(await screen.findByText('正在自动归类，完成后可确认名称和目录。')).toBeVisible();
  expect(screen.getByRole('heading', { name: '已收藏 · AI 正在归类…' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '稍后处理' }));
  expect(await screen.findByRole('textbox', { name: '名称' })).toHaveValue('AI title');
  expect(h.done()).toEqual(['busy']);
});

it('entries reviewed elsewhere leave the worker queue', async () => {
  const h = harness({
    receipts: [{ ...receipt, id: 'gone', bookmarkId: 'other-mark', reviewedAt: Date.now() }, receipt],
    queue: ['gone', 'first'],
  });
  const close = vi.fn();
  render(<SaveReviewQueue onOpen={vi.fn()} onClose={close} send={h.send} />);
  expect(await screen.findByRole('textbox', { name: '名称' })).toHaveValue('AI title');
  await waitFor(() => expect(h.done()).toEqual(['gone']));
  expect(screen.queryByText('1/2')).not.toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
});

it('a popup holding only stale entries stays open, and the last confirm closes it only after the worker answered', async () => {
  const h = harness({
    receipts: [{ ...receipt, id: 'gone', bookmarkId: 'other-mark', reviewedAt: Date.now() }, receipt],
    queue: ['gone'],
  });
  const close = vi.fn();
  const view = render(<SaveReviewQueue onOpen={vi.fn()} onClose={close} send={h.send} />);
  expect(await screen.findByText('没有待确认的收藏。')).toBeVisible();
  await waitFor(() => expect(h.done()).toEqual(['gone']));
  expect(close).not.toHaveBeenCalled();
  view.unmount();
  let answer!: (value: unknown) => void;
  h.sendMessage.mockImplementation(() => new Promise(resolve => (answer = resolve)));
  await h.publishQueue(['first']);
  render(<SaveReviewQueue onOpen={vi.fn()} onClose={close} send={h.send} />);
  await screen.findByRole('textbox', { name: '名称' });
  fireEvent.click(screen.getByRole('button', { name: '稍后处理' }));
  await waitFor(() => expect(h.done()).toEqual(['gone', 'first']));
  expect(close).not.toHaveBeenCalled();
  await act(async () => answer({ status: 'done', remaining: 0 }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it('language changes keep the field being edited', async () => {
  const send = vi.fn(async (message: CorrectionMessage): Promise<CorrectionResponse> =>
    message.action === 'begin'
      ? { status: 'ready', token: 't', tree, bookmarkId: 'mark', suggestedTitle: 'AI title' }
      : { status: 'closed' },
  );
  render(
    <LocaleProvider>
      <LanguagePicker />
      <SaveReviewForm
        receipt={receipt}
        send={send}
        onComplete={vi.fn()}
        onLater={vi.fn()}
        onDismiss={vi.fn(async () => {})}
        onOpen={vi.fn()}
      />
    </LocaleProvider>,
  );
  const input = await screen.findByRole('textbox', { name: '名称' });
  fireEvent.change(input, { target: { value: 'Edited name' } });
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(screen.getByRole('textbox', { name: 'Name' })).toBe(input);
  expect(input).toHaveValue('Edited name');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Review later' })).toBeEnabled();
});

it('a newer reviewed receipt supersedes older pending records for the same bookmark', () => {
  expect(pendingSaveReceipts([{ ...receipt, id: 'new', reviewedAt: Date.now() }, receipt])).toEqual([]);
});
