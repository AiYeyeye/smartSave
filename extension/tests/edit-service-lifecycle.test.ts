import { createElement } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditServiceOverlay } from '../options/ai-services/EditServiceOverlay';
import type { ConnectedService } from '../options/ai-services/mock-data';
import { LANGUAGE_KEY, LanguagePicker, LocaleProvider } from '../ui/i18n';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../options/ai-services/toast', () => ({ useToast: () => ({ toast }) }));
const service: ConnectedService = {
  id: 's',
  name: 'Draft',
  serviceType: 'Custom',
  kind: 'api',
  detail: '',
  baseUrl: 'https://model.test/v1',
  mode: 'openai-responses',
  status: 'ok',
  letter: 'D',
  avatarClass: 'c-openai',
  enabled: ['first', 'second'],
  catalog: [
    { id: 'first', ctx: '' },
    { id: 'second', ctx: '' },
  ],
  timeoutMs: 1000,
  streaming: false,
};
const answer = () =>
  new Response(
    JSON.stringify({
      status: 'completed',
      output_text: JSON.stringify({
        assignments: [{ itemId: 'test-bookmark', folderId: 'test-docs' }],
        newFolders: [],
      }),
    }),
  );
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
function view(onClose = vi.fn(), onSave = vi.fn()) {
  return render(
    createElement(EditServiceOverlay, { service, initialKey: 'key', onClose, onSave, onChangeService: vi.fn() }),
  );
}
beforeEach(() => {
  toast.mockClear();
  vi.stubGlobal('chrome', {
    permissions: {
      request: vi.fn(async () => true),
      contains: vi.fn(async () => true),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it('language switching preserves an edited service and the in-flight real transport request', async () => {
  localStorage.setItem(LANGUAGE_KEY, 'en');
  const pending = deferred<Response>();
  const fetcher = vi.fn<typeof fetch>(() => pending.promise);
  vi.stubGlobal('fetch', fetcher);
  const save = vi.fn();
  render(
    createElement(
      LocaleProvider,
      null,
      createElement(LanguagePicker),
      createElement(EditServiceOverlay, {
        service,
        initialKey: 'key',
        onClose: vi.fn(),
        onSave: save,
        onChangeService: vi.fn(),
      }),
    ),
  );
  const name = screen.getByLabelText('Name');
  fireEvent.change(name, { target: { value: '已连接' } });
  fireEvent.change(screen.getByLabelText('Maximum output tokens'), { target: { value: '64000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'zh-CN' } });
  expect(screen.getByLabelText('名称')).toBe(name);
  expect(name).toHaveValue('已连接');
  expect(screen.getByLabelText('最大输出 tokens')).toHaveValue(64000);
  expect(screen.getByLabelText('API 密钥')).toHaveValue('key');
  expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(false);
  expect(screen.getByRole('button', { name: '测试中…' })).toBeDisabled();
  await act(async () => pending.resolve(answer()));
  await waitFor(() => expect(toast).toHaveBeenCalledWith('合成分类测试通过：first'));
  expect(fetcher).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});

it('uses the explicit model and restored JSON mode, and saves the transport choice', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => answer());
  vi.stubGlobal('fetch', fetcher);
  const saved = vi.fn();
  view(undefined, saved);
  const user = userEvent.setup();
  const streaming = screen.getByRole('switch', { name: /流式响应/ });
  const outputLimit = screen.getByLabelText('最大输出 tokens');
  expect(outputLimit).toHaveValue(null);
  for (const value of ['0', '-1', '1.5']) {
    fireEvent.change(outputLimit, { target: { value } });
    expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存服务' })).toBeDisabled();
  }
  fireEvent.change(outputLimit, { target: { value: '64000' } });
  expect(streaming).not.toBeChecked();
  await user.selectOptions(screen.getByLabelText('测试模型'), 'second');
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith('合成分类测试通过：second'));
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
    model: 'second',
    stream: false,
    max_output_tokens: 64000,
  });
  await user.click(streaming);
  await user.click(screen.getByRole('button', { name: '保存服务' }));
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({ streaming: true, maxOutputTokens: 64000 }), 'key', true);
});

it('draft edits while permission dialog is pending prevent any request or old toast', async () => {
  const permission = deferred<boolean>();
  vi.stubGlobal('chrome', {
    ...chrome,
    permissions: { ...chrome.permissions, request: vi.fn(() => permission.promise) },
  });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  view();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  await user.type(screen.getByLabelText('接口地址'), '/changed');
  await act(async () => permission.resolve(true));
  expect(fetcher).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled();
});

it('clears a saved explicit output limit for both the draft request and persistence', async () => {
  const save = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async () => answer());
  vi.stubGlobal('fetch', fetcher);
  render(
    createElement(EditServiceOverlay, {
      service: { ...service, maxOutputTokens: 128000 },
      initialKey: 'key',
      onClose: vi.fn(),
      onSave: save,
      onChangeService: vi.fn(),
    }),
  );
  const input = screen.getByLabelText('最大输出 tokens');
  expect(input).toHaveValue(128000);
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).not.toHaveProperty('max_output_tokens');
  await waitFor(() => expect(screen.getByRole('button', { name: '保存服务' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '保存服务' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: undefined }), 'key', true),
  );
});

it('late completion of a superseded request cannot clear the next busy state', async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  vi.stubGlobal('fetch', fetcher);
  view();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  await user.selectOptions(screen.getByLabelText('测试模型'), 'second');
  expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  await act(async () => first.resolve(answer()));
  expect(screen.getByRole('button', { name: /测试中/ })).toBeDisabled();
  expect(toast).not.toHaveBeenCalled();
  await act(async () => second.resolve(answer()));
  await waitFor(() => expect(toast).toHaveBeenCalledWith('合成分类测试通过：second'));
  expect(toast).toHaveBeenCalledTimes(1);
});

it('unmount while permission is pending suppresses generation and results', async () => {
  const permission = deferred<boolean>();
  vi.stubGlobal('chrome', {
    ...chrome,
    permissions: { ...chrome.permissions, request: vi.fn(() => permission.promise) },
  });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const rendered = view();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  rendered.unmount();
  await act(async () => permission.resolve(true));
  expect(fetcher).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it('closing during generation aborts it and suppresses its toast', async () => {
  const result = deferred<Response>();
  const fetcher = vi.fn<typeof fetch>(() => result.promise);
  vi.stubGlobal('fetch', fetcher);
  const close = vi.fn();
  view(close);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await user.click(screen.getByRole('button', { name: '关闭' }));
  expect(close).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  await act(async () => result.resolve(answer()));
  expect(toast).not.toHaveBeenCalled();
});
