import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SaveCard } from '../panel/SaveCard';
import { SettingsStore } from '../persistence/settings';
import { SiteRulesStore } from '../persistence/site-rules';
import { AiServicesStore } from '../persistence/ai-services';
import type { TreeSnapshot } from '../domain/node-reference';
import { LANGUAGE_KEY, LanguagePicker, LocaleProvider } from '../ui/i18n';
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
async function harness(deferred = false, bodyEnabled = false, trial = false, localized = false) {
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
  const services = trial ? new AiServicesStore(storage, run => run()) : undefined;
  if (services) {
    await services.load();
    await services.upsertService(
      {
        id: 'trial',
        name: 'Synthetic',
        serviceType: 'API',
        kind: 'api',
        detail: '',
        baseUrl: 'https://trial.test',
        mode: 'openai',
        status: 'ok',
        letter: 'T',
        avatarClass: 'custom',
        catalog: [],
        enabled: ['save-model', 'classify-model'],
        streaming: false,
      },
      'trial-key',
      false,
    );
    await services.saveFeatures(
      services
        .snapshotServices()
        .features.map(feature => ({ ...feature, connId: 'trial', modelId: `${feature.id}-model` })),
    );
    const context = await settings.snapshot();
    await settings.save(context.config!, { ...context.privacy, fullUrl: false }, context.key, false);
  }
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
  const send = vi.fn();
  const extractBody = vi.fn(async () => 'ephemeral-body');
  const props = {
    page: { title: 'Page', url: 'https://page.test/private?secret=hidden' },
    snapshot: tree,
    settings,
    rulesStore: rules,
    aiServices: services,
    readOnlyTrial: trial,
    send,
    extractBody,
    onClose: vi.fn(),
  };
  const card = (snapshot: TreeSnapshot) =>
    localized
      ? createElement(
          LocaleProvider,
          null,
          createElement(LanguagePicker),
          createElement(SaveCard, { ...props, snapshot }),
        )
      : createElement(SaveCard, { ...props, snapshot });
  const view = render(card(tree));
  return {
    revoke: () => listeners.forEach(listener => listener()),
    respond: (value: Response) => finish(value),
    fetcher,
    release,
    finish: () => finish(new Response('{}')),
    settings,
    view,
    data,
    send,
    extractBody,
    services,
    rerender: (snapshot: TreeSnapshot) => view.rerender(card(snapshot)),
  };
}
it('language changes retain the save draft, explicit consent and in-flight request without writing', async () => {
  localStorage.setItem(LANGUAGE_KEY, 'en');
  const h = await harness(false, false, false, true);
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  const input = screen.getByLabelText('Bookmark title');
  fireEvent.change(input, { target: { value: '收藏标题 <&>' } });
  fireEvent.change(screen.getByLabelText('Bookmark folder'), { target: { value: 'f' } });
  fireEvent.click(screen.getByLabelText('Save future bookmarks from this website here'));
  fireEvent.click(screen.getByLabelText('Include subdomains'));
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'zh-CN' } });
  expect(screen.getByLabelText('收藏标题')).toBe(input);
  expect(input).toHaveValue('收藏标题 <&>');
  expect(screen.getByLabelText('收藏目标目录')).toHaveValue('f');
  expect(screen.getByLabelText('包含子域名')).toBeChecked();
  expect(screen.getByLabelText('以后此网站默认存到这里')).toBeChecked();
  expect(h.fetcher.mock.calls[0]![1]!.signal?.aborted).toBe(false);
  await acceptSuggestion(h);
  expect(input).toHaveValue('收藏标题 <&>');
  expect(h.fetcher).toHaveBeenCalledOnce();
  expect(h.send).not.toHaveBeenCalled();
  h.view.unmount();
  h.settings.dispose();
});
it('English trial switches language during generation and keeps the preview read-only', async () => {
  localStorage.setItem(LANGUAGE_KEY, 'en');
  const h = await harness(false, true, true, true);
  expect(h.fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Send and try classification' }));
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'zh-CN' } });
  expect(screen.getByRole('button', { name: '正在试分类…' })).toBeDisabled();
  expect(h.fetcher.mock.calls[0]![1]!.signal?.aborted).toBe(false);
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  const wire = JSON.parse(String(h.fetcher.mock.calls[0]![1]!.body));
  const itemId = JSON.parse(wire.messages[1].content).items[0].id;
  h.respond(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                assignments: [{ itemId, folderId: 'f' }],
                newFolders: [],
              }),
            },
          },
        ],
      }),
    ),
  );
  await screen.findByText('Suggested folder: Folder');
  expect(screen.queryByRole('button', { name: 'Confirm bookmark save' })).not.toBeInTheDocument();
  expect(h.fetcher).toHaveBeenCalledOnce();
  expect(h.send).not.toHaveBeenCalled();
  expect(h.extractBody).not.toHaveBeenCalled();
  h.view.unmount();
  h.settings.dispose();
  h.services?.dispose();
});
async function acceptSuggestion(h: Awaited<ReturnType<typeof harness>>, keywords?: string[]) {
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  const wire = JSON.parse(String(h.fetcher.mock.calls[0]![1]!.body));
  const item = JSON.parse(wire.messages[1].content).items[0];
  h.respond(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                assignments: [{ itemId: item.id, folderId: 'f', ...(keywords ? { keywords } : {}) }],
                newFolders: [],
              }),
            },
          },
        ],
      }),
    ),
  );
  await waitFor(() => expect(screen.getByLabelText('收藏目标目录')).toHaveValue('f'));
}
it('read-only trial waits for a click, uses the save route and privacy projection, and never exposes a write', async () => {
  const h = await harness(false, true, true);
  expect(screen.getByRole('heading', { name: '当前网页试分类' })).toBeVisible();
  expect(h.fetcher).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '确认收藏保存' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '发送并试分类' }));
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  const [url, init] = h.fetcher.mock.calls[0]!;
  const wire = JSON.parse(String(init!.body));
  expect(url).toBe('https://trial.test/v1/chat/completions');
  expect(wire.model).toBe('save-model');
  expect(init!.headers).toMatchObject({ Authorization: 'Bearer trial-key' });
  const payload = JSON.parse(wire.messages[1].content);
  expect(payload.items[0].url).toBe('https://page.test/private');
  expect(JSON.stringify(payload)).not.toMatch(/secret|ephemeral-body/);
  expect(h.extractBody).not.toHaveBeenCalled();
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
  await waitFor(() => expect(screen.getByText('建议目录：Folder')).toBeVisible());
  expect(h.send).not.toHaveBeenCalled();
  expect(JSON.stringify(h.data)).not.toContain('trial-key');
  h.revoke();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('建议已失效'));
  expect(screen.queryByText('建议目录：Folder')).not.toBeInTheDocument();
  h.view.unmount();
  h.settings.dispose();
  h.services?.dispose();
});

it.each(['completed', 'unknown', 'edited-title'] as const)(
  'attaches keywords only to proven unchanged completed saves: %s',
  async outcome => {
    const h = await harness();
    const completed = (requestId: string) => ({
      requestId,
      status: 'completed',
      needsReconcile: false,
      completedSteps: 1,
      remainingSteps: 0,
      evidence: [{ stepIndex: 0, state: 'checkpointed', nativeId: 'new-native-bookmark', currentMatchesReceipt: true }],
    });
    const sendMessage = vi.fn(async (message: { type: string; requestId: string }) =>
      message.type === 'reconcileMutation' ? completed(message.requestId) : { status: 'ok' },
    );
    vi.stubGlobal('chrome', { ...chrome, runtime: { ...chrome.runtime, sendMessage } });
    h.send.mockImplementation(async request =>
      outcome === 'unknown'
        ? {
            requestId: request.requestId,
            status: 'unknown',
            needsReconcile: true,
            completedSteps: 0,
            remainingSteps: 1,
          }
        : completed(request.requestId),
    );
    await acceptSuggestion(h, ['diagramming', '流程图', '工作流']);
    expect(sendMessage).not.toHaveBeenCalled();
    if (outcome === 'edited-title')
      fireEvent.change(screen.getByLabelText('收藏标题'), { target: { value: 'Changed topic' } });
    fireEvent.click(screen.getByRole('button', { name: '确认收藏保存' }));
    await waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    if (outcome === 'completed') {
      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
      expect(sendMessage).toHaveBeenLastCalledWith({
        type: 'rememberBookmarkKeywords',
        version: 1,
        record: {
          installationId: 'i',
          nativeId: 'new-native-bookmark',
          title: 'Page',
          url: 'https://page.test/private?secret=hidden',
          keywords: ['diagramming', '流程图', '工作流'],
        },
      });
    } else expect(sendMessage).not.toHaveBeenCalled();
    expect(h.fetcher).toHaveBeenCalledOnce();
    h.view.unmount();
    h.settings.dispose();
  },
);

it('cancelled trial ignores a late successful response and cannot write', async () => {
  const h = await harness(false, true, true);
  fireEvent.click(screen.getByRole('button', { name: '发送并试分类' }));
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  const init = h.fetcher.mock.calls[0]![1]!;
  const itemId = JSON.parse(JSON.parse(String(init.body)).messages[1].content).items[0].id;
  fireEvent.click(screen.getByRole('button', { name: '取消试分类' }));
  expect(init.signal?.aborted).toBe(true);
  h.respond(
    new Response(
      JSON.stringify({
        choices: [
          { message: { content: JSON.stringify({ assignments: [{ itemId, folderId: 'f' }], newFolders: [] }) } },
        ],
      }),
    ),
  );
  await waitFor(() => expect(screen.getByRole('button', { name: '发送并试分类' })).toBeEnabled());
  expect(screen.queryByText('建议目录：Folder')).not.toBeInTheDocument();
  expect(screen.getByText('已取消试分类。')).toBeVisible();
  expect(h.send).not.toHaveBeenCalled();
  h.view.unmount();
  h.settings.dispose();
  h.services?.dispose();
});
it('an accepted AI destination survives unrelated tree changes and is revoked only when its folder changes', async () => {
  const h = await harness();
  await acceptSuggestion(h);
  const grown = structuredClone(tree);
  grown.observedRevision = 1;
  grown.epoch = 'restarted';
  grown.nodes.push({
    ref: { installationId: 'i', nativeId: 'g', kind: 'folder' },
    parentId: 'root',
    title: 'Other folder',
    index: 1,
    childrenIds: [],
    readOnly: false,
    childrenWritable: true,
    observedRevision: 1,
  });
  grown.nodes[0]!.childrenIds = ['f', 'g'];
  h.rerender(grown);
  await waitFor(() => expect(screen.getByRole('option', { name: 'Other folder（g）' })).toBeInTheDocument());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByLabelText('收藏目标目录')).toHaveValue('f');
  expect(h.fetcher).toHaveBeenCalledOnce();
  const renamed = structuredClone(grown);
  renamed.observedRevision = 2;
  renamed.nodes[1]!.title = 'Renamed folder';
  h.rerender(renamed);
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('模型配置已变化'));
  expect(screen.getByLabelText('收藏目标目录')).toHaveValue('f');
  fireEvent.click(screen.getByRole('button', { name: '确认收藏保存' }));
  expect(screen.getByRole('status')).toHaveTextContent('未提交');
  h.view.unmount();
  h.settings.dispose();
});
it('a deleted destination folder must be reselected after the tree changes', async () => {
  const h = await harness();
  await acceptSuggestion(h);
  const removed = structuredClone(tree);
  removed.observedRevision = 3;
  removed.nodes = removed.nodes.filter(n => n.ref.nativeId !== 'f');
  removed.nodes[0]!.childrenIds = [];
  h.rerender(removed);
  await waitFor(() => expect(screen.getByLabelText('收藏目标目录')).toHaveValue(''));
  expect(screen.getByText('目标目录已不可用，请重新选择')).toBeVisible();
  expect(screen.getByRole('button', { name: '确认收藏保存' })).toBeDisabled();
  h.view.unmount();
  h.settings.dispose();
});
it('configured automatic initialization reaches actual ModelTransport with provenance and no default body', async () => {
  const h = await harness();
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  const options = h.fetcher.mock.calls[0]![1]!;
  const wire = JSON.parse(String(options.body));
  const payload = JSON.parse(wire.messages[1].content);
  expect(payload.items[0]).toMatchObject({ title: 'Page', url: 'https://page.test/private?secret=hidden' });
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
