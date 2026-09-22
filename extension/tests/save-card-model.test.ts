import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SaveCard } from '../panel/SaveCard';
import { SettingsStore } from '../persistence/settings';
import { SiteRulesStore } from '../persistence/site-rules';
import type { TreeSnapshot } from '../domain/node-reference';
const tree: TreeSnapshot = {
  installationId: 'i',
  epoch: 'e',
  observedRevision: 0,
  roots: ['root'],
  nodes: [
    {
      ref: { installationId: 'i', nativeId: 'root', kind: 'folder' },
      title: '',
      index: 0,
      childrenIds: ['f'],
      readOnly: true,
      childrenWritable: false,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'i', nativeId: 'f', kind: 'folder' },
      parentId: 'root',
      title: 'Folder',
      index: 0,
      childrenIds: [],
      readOnly: false,
      childrenWritable: true,
      observedRevision: 0,
    },
  ],
};
vi.mock('../panel/tree-client', () => ({
  connectTree: (_runtime: unknown, listener: (state: unknown) => void) => {
    listener({ status: 'ready', snapshot: tree });
    return () => {};
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function harness(deferred = false, bodyEnabled = false) {
  const listeners = new Set<() => void>();
  const event = {
    addListener: (listener: () => void) => listeners.add(listener),
    removeListener: (listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal('chrome', {
    runtime: {},
    storage: { onChanged: event },
    permissions: { onRemoved: event, contains: async () => true },
  });
  const data: Record<string, unknown> = {};
  const storage = {
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (value: Record<string, unknown>) => {
      Object.assign(data, value);
    },
    remove: async (key: string) => {
      delete data[key];
    },
    setAccessLevel: async () => {},
  };
  const settings = new SettingsStore(storage, run => run());
  await settings.load();
  await settings.save(
    { adapter: 'openai-compatible', baseUrl: 'https://model.test', model: 'synthetic', timeoutMs: 10000 },
    { fullUrl: true, bodyEnabled, excludedFolders: [] },
    'session-key',
    false,
  );
  const rules = new SiteRulesStore(storage, run => run());
  let release!: (value: []) => void;
  if (deferred)
    vi.spyOn(rules, 'load').mockReturnValue(
      new Promise(resolve => {
        release = resolve;
      }),
    );
  let finish!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = render(
    createElement(SaveCard, {
      page: { title: 'Page', url: 'https://page.test/' },
      snapshot: tree,
      settings,
      rulesStore: rules,
      extractBody: async () => 'ephemeral-body',
      onClose: vi.fn(),
    }),
  );
  return {
    revoke: () => listeners.forEach(listener => listener()),
    respond: (value: Response) => finish(value),
    fetcher,
    release,
    finish: () => finish(new Response('{}')),
    settings,
    view,
    data,
  };
}
it('configured automatic initialization reaches actual ModelTransport with provenance and no default body', async () => {
  const h = await harness();
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  const options = h.fetcher.mock.calls[0]![1]!;
  const wire = JSON.parse(String(options.body));
  const payload = JSON.parse(wire.messages[1].content);
  expect(payload.items[0]).toMatchObject({ title: 'Page', url: 'https://page.test/' });
  expect(payload.snippet).toBeUndefined();
  expect(wire.messages).toHaveLength(2);
  expect(wire.messages[0].content).toMatch(
    /single best destination folder[\s\S]*at most 3 levels below the target root[\s\S]*rewriting existing titles is not allowed/,
  );
  expect(options.headers).toMatchObject({ Authorization: 'Bearer session-key' });
  fireEvent.click(screen.getByRole('button', { name: '取消AI请求' }));
  expect(options.signal?.aborted).toBe(true);
  h.finish();
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已取消AI请求'));
  expect(JSON.stringify(h.data)).not.toContain('session-key');
  h.view.unmount();
  h.settings.dispose();
});
it('cancel before deferred rules load prevents configured automatic transport request', async () => {
  const h = await harness(true);
  fireEvent.click(screen.getByRole('button', { name: '取消AI请求' }));
  h.release([]);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('可请求AI建议'));
  expect(h.fetcher).not.toHaveBeenCalled();
  h.view.unmount();
  h.settings.dispose();
});
it('manual configured request consumes automatic eligibility before deferred rules resolve', async () => {
  const h = await harness(true);
  fireEvent.click(screen.getByRole('button', { name: '请求AI建议' }));
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  h.release([]);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('可请求AI建议'));
  expect(h.fetcher).toHaveBeenCalledOnce();
  h.view.unmount();
  expect(h.fetcher.mock.calls[0]![1]!.signal?.aborted).toBe(true);
  h.settings.dispose();
});

it('accepted configured AI destination invalidates on authority revocation and title edits do not clear it', async () => {
  const h = await harness();
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  const wire = JSON.parse(String(h.fetcher.mock.calls[0]![1]!.body));
  const item = JSON.parse(wire.messages[1].content).items[0];
  h.respond(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: JSON.stringify({ assignments: [{ itemId: item.id, folderId: 'f' }], newFolders: [] }) },
          },
        ],
      }),
    ),
  );
  await waitFor(() => expect(screen.getByLabelText('收藏目标目录')).toHaveValue('f'));
  h.revoke();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('模型配置已变化'));
  fireEvent.change(screen.getByLabelText('收藏标题'), { target: { value: 'Title only' } });
  fireEvent.click(screen.getByRole('button', { name: '确认收藏保存' }));
  expect(screen.getByRole('status')).toHaveTextContent('未提交');
  fireEvent.change(screen.getByLabelText('收藏目标目录'), { target: { value: 'f' } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  h.view.unmount();
  h.settings.dispose();
});

it('accepted body-assisted suggestion becomes invalid when local body consent is disabled', async () => {
  const h = await harness(true, true);
  fireEvent.click(screen.getByLabelText(/本次允许正文辅助/));
  fireEvent.click(screen.getByRole('button', { name: '请求AI建议' }));
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  const wire = JSON.parse(String(h.fetcher.mock.calls[0]![1]!.body));
  const payload = JSON.parse(wire.messages[1].content);
  expect(payload.snippet).toBe('ephemeral-body');
  h.respond(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                assignments: [{ itemId: payload.items[0].id, folderId: 'f' }],
                newFolders: [],
              }),
            },
          },
        ],
      }),
    ),
  );
  await waitFor(() => expect(screen.getByLabelText('收藏目标目录')).toHaveValue('f'));
  fireEvent.click(screen.getByLabelText(/本次允许正文辅助/));
  expect(screen.getByRole('alert')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '确认收藏保存' }));
  expect(screen.getByRole('status')).toHaveTextContent('未提交');
  expect(JSON.stringify(h.data)).not.toContain('ephemeral-body');
  h.view.unmount();
  h.settings.dispose();
});
