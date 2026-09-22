import { type FileOutputCommand } from '../export/file-output-control';
import { createElement } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { ExportSettings } from '../options/ExportSettings';
import { App } from '../ui/App';
import { FileOutputStore, type OutputFileHandle } from '../persistence/file-output';
import { FileOutputSink } from '../background/file-output';
import { TreeProjection } from '../background/tree-projection';

const clone = globalThis.structuredClone;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup(app = false) {
  const handles = new Map<string, OutputFileHandle>();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('structuredClone', (value: unknown) => {
    if (value && typeof value === 'object' && 'handle' in value) {
      const { handle, ...rest } = value as { handle: OutputFileHandle & { name: string } };
      return { ...clone(rest), handle: handles.get(handle.name) };
    }
    return clone(value);
  });
  let notify!: () => void;
  let deleted = false;
  let title = 'Folder';
  const tree = new TreeProjection(
    {
      read: async () => [
        {
          id: '0',
          title: '',
          syncing: false,
          children: deleted ? [] : [{ id: 'bar', parentId: '0', title, syncing: false, children: [] }],
        },
      ],
      listen: fn => {
        notify = fn;
        return () => {};
      },
    },
    async () => 'install',
    'epoch',
  );
  tree.start();
  await tree.fresh();
  const store = new FileOutputStore();
  const sink = new FileOutputSink(tree, store);
  const messages: unknown[] = [];
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {}, setAccessLevel: async () => {} },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    permissions: { onRemoved: { addListener: () => {}, removeListener: () => {} } },
    runtime: {
      connect: () => {
        let receive: (value: unknown) => void = () => {};
        const detach = tree.subscribe(state => receive({ version: 1, state }));
        return {
          onMessage: {
            addListener: (fn: typeof receive) => {
              receive = fn;
            },
          },
          onDisconnect: { addListener: () => {} },
          postMessage: () => receive({ version: 1, state: tree.state }),
          disconnect: detach,
        };
      },
      sendMessage: async (message: FileOutputCommand | { type: string; action: 'status' }) => {
        messages.push(message);
        if (message.type !== 'fileOutput') return undefined;
        if (message.action !== 'status') return sink.command(message);
        return sink.status();
      },
    },
  });
  function handle(name: string) {
    const stream = {
      write: vi.fn(async (text: string) => {
        void text;
      }),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const file = {
      kind: 'file' as const,
      name,
      requestPermission: vi.fn(async (): Promise<PermissionState> => 'granted'),
      queryPermission: vi.fn(async (): Promise<PermissionState> => 'granted'),
      createWritable: vi.fn(async () => stream),
    };
    handles.set(name, file);
    return { file, stream };
  }
  const a = handle('a.json');
  const picker = vi.fn(async () => a.file);
  vi.stubGlobal('showSaveFilePicker', picker);
  const view = render(app ? createElement(App, { page: 'options' }) : createElement(ExportSettings, { visible: true }));
  if (app) fireEvent.click(screen.getByRole('button', { name: /导出与备份/ }));
  await screen.findByRole('checkbox', { name: '导出 Folder' });
  const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
  const select = () => {
    fireEvent.click(screen.getByRole('checkbox', { name: '导出 Folder' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '我同意专用输出覆盖规则' }));
  };
  async function enable() {
    click('选择专用 JSON 文件');
    await screen.findByRole('button', { name: '授权并启用所选文件' });
    click('授权并启用所选文件');
    await waitFor(() => expect(sink.status().status).toBe('success'));
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新输出状态' })).toBeEnabled());
    click('刷新输出状态');
    await screen.findByText(/持久状态：success/);
  }
  return {
    tree,
    store,
    sink,
    a,
    picker,
    messages,
    click,
    select,
    enable,
    handle,
    view,
    remove: () => {
      deleted = true;
      notify();
    },
    change: () => {
      title = 'Latest';
      notify();
    },
    cleanup: () => {
      view.unmount();
      sink.dispose();
      tree.stop();
    },
  };
}
it('production UI gesture ordering, consent, same-origin handle transport, cancellation and durable close status', async () => {
  const h = await setup();
  expect(screen.getByRole('button', { name: '选择专用 JSON 文件' })).toBeDisabled();
  h.select();
  const read = vi.spyOn(h.store, 'read');
  h.click('选择专用 JSON 文件');
  expect(h.picker).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();
  await screen.findByRole('button', { name: '授权并启用所选文件' });
  let close!: () => void;
  h.a.stream.close.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        close = resolve;
      }),
  );
  h.click('授权并启用所选文件');
  expect(h.a.file.requestPermission).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(h.a.stream.close).toHaveBeenCalled());
  expect((await h.store.read())?.lastSuccess).toBeUndefined();
  await act(async () => close());
  await waitFor(() => expect(h.sink.status().status).toBe('success'));
  h.click('刷新输出状态');
  await screen.findByText(/持久状态：success/);
  const before = await h.store.read();
  expect(h.messages.map(message => (message as FileOutputCommand).action)).toEqual(['prepare', 'reload']);
  expect(JSON.stringify(h.messages)).not.toContain('handle');
  h.picker.mockRejectedValueOnce(new DOMException('cancel', 'AbortError'));
  h.click('选择专用 JSON 文件');
  await screen.findByText('已取消选择，现有输出目标不变。');
  expect((await h.store.read())?.generation).toBe(before?.generation);
  h.cleanup();
});
it('denied authorization does not configure, reacquisition catches latest snapshot, root deletion requires reselection', async () => {
  const h = await setup();
  h.select();
  h.a.file.requestPermission.mockResolvedValueOnce('denied');
  h.click('选择专用 JSON 文件');
  await screen.findByRole('button', { name: '授权并启用所选文件' });
  h.click('授权并启用所选文件');
  await screen.findByText('权限未授予，未启用或重试写入。请明确重新授权。');
  expect(await h.store.read()).toBeUndefined();
  h.a.file.queryPermission.mockResolvedValueOnce('denied');
  h.click('授权并启用所选文件');
  await waitFor(() => expect(h.sink.status().status).toBe('needs-permission'));
  h.click('刷新输出状态');
  await screen.findByText(/持久状态：needs-permission/);
  await act(async () => {
    h.change();
    await h.tree.fresh();
  });
  h.click('重新授权并补写当前快照');
  expect(h.a.file.requestPermission).toHaveBeenCalledTimes(3);
  await waitFor(() => expect(h.sink.status().status).toBe('success'));
  expect(h.a.stream.write.mock.calls.at(-1)?.[0]).toContain('Latest');
  await act(async () => {
    h.remove();
    await h.tree.fresh();
  });
  await waitFor(() => expect(h.sink.status().status).toBe('scope-invalid'));
  h.click('刷新输出状态');
  await screen.findByText(/持久状态：scope-invalid/);
  expect(screen.getByRole('button', { name: '重新授权并补写当前快照' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '下载 JSON' })).toBeDisabled();
  h.cleanup();
});
it('manual three formats are user initiated downloads; App navigation and four themes retain drafts and consent', async () => {
  const h = await setup(true);
  h.select();
  const create = vi.fn(() => 'blob:synthetic');
  const revoke = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  for (const theme of ['轻盈原生', '温润纸感', '清爽文具（默认）', '深色精密']) {
    fireEvent.click(screen.getByRole('button', { name: '返回设置' }));
    fireEvent.click(screen.getByRole('button', { name: /外观/ }));
    fireEvent.click(screen.getByRole('radio', { name: theme }));
    fireEvent.click(screen.getByRole('button', { name: '返回设置' }));
    fireEvent.click(screen.getByRole('button', { name: /导出与备份/ }));
    expect(screen.getByRole('checkbox', { name: '导出 Folder' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '我同意专用输出覆盖规则' })).toBeChecked();
  }
  for (const format of ['JSON', 'HTML', 'Markdown']) h.click(`下载 ${format}`);
  expect(download).toHaveBeenCalledTimes(3);
  expect(create).toHaveBeenCalledTimes(3);
  expect(h.a.file.createWritable).not.toHaveBeenCalled();
  expect(h.picker).not.toHaveBeenCalled();
  h.cleanup();
});
it('unsupported capability is honest and manual export remains available', async () => {
  const h = await setup();
  vi.stubGlobal('showSaveFilePicker', undefined);
  h.select();
  expect(screen.getByText(/此环境不支持自动文件选择/)).toBeVisible();
  expect(screen.getByRole('button', { name: '下载 JSON' })).toBeEnabled();
  h.cleanup();
});
it('UI target switch fences an old close and close failure never invents durable lastSuccess', async () => {
  const h = await setup();
  h.select();
  let release!: () => void;
  h.a.stream.close.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
  );
  h.click('选择专用 JSON 文件');
  await screen.findByRole('button', { name: '授权并启用所选文件' });
  h.click('授权并启用所选文件');
  await waitFor(() => expect(h.a.stream.close).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByRole('button', { name: '选择专用 JSON 文件' })).toBeEnabled());
  const b = h.handle('b.json');
  b.stream.close.mockRejectedValueOnce(Error('disk'));
  h.picker.mockResolvedValueOnce(b.file);
  h.click('选择专用 JSON 文件');
  await screen.findByRole('button', { name: '授权并启用所选文件' });
  h.click('授权并启用所选文件');
  await waitFor(async () => expect((await h.store.read())?.handle).toBe(b.file));
  await act(async () => release());
  await waitFor(() => expect(h.sink.status().status).toBe('paused'));
  h.click('刷新输出状态');
  await screen.findByText(/持久状态：paused；最近成功：无/);
  expect((await h.store.read())?.lastSuccess).toBeUndefined();
  expect(b.stream.write).toHaveBeenCalledTimes(1);
  h.click('重新授权并补写当前快照');
  await waitFor(() => expect(h.sink.status().status).toBe('success'));
  h.click('刷新输出状态');
  await screen.findByText(/持久状态：success/);
  expect((await h.store.read())?.lastSuccess).toBeDefined();
  h.cleanup();
});
it('late page storage response cannot replace newer displayed target', async () => {
  const h = await setup();
  h.select();
  await h.enable();
  const old = await h.store.read();
  let release!: (value: typeof old) => void;
  const read = FileOutputStore.prototype.read;
  vi.spyOn(FileOutputStore.prototype, 'read').mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  h.click('刷新输出状态');
  const b = h.handle('b.json');
  h.picker.mockResolvedValueOnce(b.file);
  h.click('选择专用 JSON 文件');
  await screen.findByRole('button', { name: '授权并启用所选文件' });
  h.click('授权并启用所选文件');
  await waitFor(async () => expect((await read.call(h.store))?.handle).toBe(b.file));
  await waitFor(() => expect(screen.getByText('当前文件：b.json')).toBeVisible());
  await act(async () => release(old));
  expect(screen.getByText('当前文件：b.json')).toBeVisible();
  h.cleanup();
});
it('cross-page replacement between UI validation and worker retry cannot resume the replacement', async () => {
  const h = await setup();
  h.select();
  await h.enable();
  const a = await h.store.read();
  const send = chrome.runtime.sendMessage;
  const b = h.handle('b.json');
  vi.stubGlobal('chrome', {
    ...chrome,
    runtime: {
      ...chrome.runtime,
      sendMessage: async (message: { action: string; expectedGeneration?: string }) => {
        if (message.action === 'retry') {
          expect(message.expectedGeneration).toBe(a?.generation);
          await h.sink.control('stop');
          const generation = await h.store.configure(b.file, a!.scope, a!.ancestry, await h.store.issueLease());
          await h.store.update(generation, { status: 'paused' });
          await h.sink.control('reload');
        }
        return send(message);
      },
    },
  });
  h.click('重新授权并补写当前快照');
  await waitFor(() => expect(screen.getByText('当前文件：b.json')).toBeVisible());
  expect((await h.store.read())?.status).toBe('paused');
  expect(b.file.createWritable).not.toHaveBeenCalled();
  h.cleanup();
});

it('a second actual empty-page UI can stop a pending first configuration', async () => {
  const h = await setup();
  h.select();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const prepared = new Promise<void>(resolve => {
    entered = resolve;
  });
  const send = chrome.runtime.sendMessage;
  vi.stubGlobal('chrome', {
    ...chrome,
    runtime: {
      ...chrome.runtime,
      sendMessage: async (command: FileOutputCommand) => {
        const receipt: unknown = await send(command);
        if (command.action === 'prepare') {
          entered();
          await gate;
        }
        return receipt;
      },
    },
  });
  h.click('选择专用 JSON 文件');
  await screen.findByRole('button', { name: '授权并启用所选文件' });
  h.click('授权并启用所选文件');
  await prepared;
  const second = render(createElement(ExportSettings, { visible: true }));
  const pageB = within(second.container);
  await pageB.findByText('当前文件：未配置');
  expect(pageB.getByRole('button', { name: '停止自动输出' })).toBeEnabled();
  fireEvent.click(pageB.getByRole('button', { name: '停止自动输出' }));
  await pageB.findByText('已接受停止请求并撤销待启用配置；已发出的文件关闭无法撤回。');
  await act(async () => release());
  await within(h.view.container).findByText('操作已过期或与其他页面冲突，未接受本次请求。请刷新状态后重新操作。');
  expect(await h.store.read()).toBeUndefined();
  expect(h.a.file.createWritable).not.toHaveBeenCalled();
  second.unmount();
  h.cleanup();
});
it.each(['storage-error', 'stale', 'mismatch'] as const)(
  'actual UI never claims acceptance for a %s reload receipt',
  async failure => {
    const h = await setup();
    h.select();
    const send = chrome.runtime.sendMessage;
    vi.stubGlobal('chrome', {
      ...chrome,
      runtime: {
        ...chrome.runtime,
        sendMessage: async (command: FileOutputCommand) => {
          if (command.action === 'reload') {
            if (failure === 'storage-error') vi.spyOn(h.store, 'read').mockRejectedValueOnce(Error('disk'));
            if (failure === 'stale') await h.sink.control('stop');
            const receipt = await h.sink.command(command);
            return failure === 'mismatch' ? { ...receipt, ticket: 'other-command' } : receipt;
          }
          return send(command);
        },
      },
    });
    h.click('选择专用 JSON 文件');
    await screen.findByRole('button', { name: '授权并启用所选文件' });
    h.click('授权并启用所选文件');
    await screen.findByText(
      failure === 'storage-error'
        ? '存储失败，未确认接受本次请求。请检查存储并刷新状态；不会报告写入成功。'
        : failure === 'stale'
          ? '操作已过期或与其他页面冲突，未接受本次请求。请刷新状态后重新操作。'
          : '后台回执不匹配，无法确认本次请求。请刷新状态核对，不会报告写入成功。',
    );
    expect(screen.queryByText(/后台已接受本次补写请求/)).toBeNull();
    if (failure !== 'mismatch') expect(h.a.file.createWritable).not.toHaveBeenCalled();
    h.cleanup();
  },
);
