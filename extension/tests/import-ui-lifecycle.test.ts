import { ThemeProvider, ThemePicker } from '../ui/ThemeProvider';
import { APPEARANCES } from './appearance';
import { createElement, useState } from 'react';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { ImportWorkbench } from '../panel/ImportWorkbench';
import { ImportPersistenceStore } from '../persistence/import-persistence';
import { SettingsStore } from '../persistence/settings';
import { TreeProjection } from '../background/tree-projection';
import { ImportAuthority } from '../background/import-authority';
import { MutationCoordinator } from '../background/mutation-coordinator';
import { parseImport } from '../import/parsers';
import type { ImportFormat } from '../import/contracts';
import type { ImportPreviewSelection } from '../domain/import-preview';
import type { ConfirmMutation } from '../schemas/messages';

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 50));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup(mode: 'completed' | 'rejected' | 'dropped' | 'unknown' | 'partial' = 'completed') {
  const factory = new IDBFactory();
  vi.stubGlobal('indexedDB', factory);
  const persistence = new ImportPersistenceStore(factory);
  const native: chrome.bookmarks.BookmarkTreeNode[] = [
    {
      id: '0',
      title: '',
      syncing: false,
      children: [{ id: 'bar', parentId: '0', title: 'Bar', syncing: false, children: [] }],
    },
  ];
  const changes = new Set<() => void>();
  let afterCreateReads = 0;
  let projection = new TreeProjection(
    {
      read: async () => {
        if (mode === 'partial' && native[0]!.children![0]!.children!.length && ++afterCreateReads === 3)
          native[0]!.children![0]!.title = 'Externally changed';
        return structuredClone(native);
      },
      listen: cb => {
        changes.add(cb);
        return () => changes.delete(cb);
      },
    },
    async () => 'install',
    'epoch',
  );
  projection.start();
  await projection.fresh();
  const data: Record<string, unknown> = {};
  const settings = new SettingsStore(
    {
      get: async key => ({ [key]: data[key] }),
      set: async value => {
        Object.assign(data, value);
      },
      remove: async key => {
        delete data[key];
      },
      setAccessLevel: async () => {},
    },
    run => run(),
  );
  await settings.load();
  await settings.save(
    { adapter: 'openai-compatible', baseUrl: 'https://synthetic.test', model: 'm', timeoutMs: 10000 },
    { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
    '',
    false,
  );
  let authority = new ImportAuthority(settings, projection, persistence.importCheckpoints, 'test');
  const sender = { id: 'test', url: 'chrome-extension://test/options/index.html' };
  let beforeCreate: ((call: number) => Promise<void>) | undefined;
  const create = vi.fn(async (details: { parentId: string; title: string; url?: string }) => {
    if (mode === 'unknown') throw Error('native response lost');
    await beforeCreate?.(create.mock.calls.length);
    const node = { ...details, id: `new${create.mock.calls.length}`, syncing: false };
    native[0]!.children![0]!.children!.push(node);
    changes.forEach(cb => cb());
    return node;
  });
  let coordinator = new MutationCoordinator(
    projection,
    {
      create,
      update: async () => {
        throw Error('forbidden');
      },
      move: async () => {
        throw Error('forbidden');
      },
      remove: async () => {
        throw Error('forbidden');
      },
    },
    persistence,
    'test',
    undefined,
    undefined,
    authority,
  );
  if (mode === 'rejected') vi.spyOn(persistence, 'handoffImport').mockRejectedValue(Error('quota'));
  const event = () => ({ addListener() {}, removeListener() {} });
  const sent: string[] = [];
  const runtime = {
    id: 'test',
    connect: ({ name }: { name: string }) => {
      const messages = new Set<(raw: unknown) => void>();
      const disconnects = new Set<() => void>();
      const token = name === 'zhilan-import-authority-v1' ? authority.open(sender) : undefined;
      const deliver = async () => {
        const raw = token
          ? { version: 1, importContext: token }
          : { version: 1, state: { status: 'ready', snapshot: await projection.fresh() } };
        messages.forEach(cb => cb(raw));
      };
      if (token) queueMicrotask(() => void deliver());
      // The tree port behaves like the worker service: every published state reaches the connected page.
      const detach = token
        ? undefined
        : projection.subscribe(state => messages.forEach(cb => cb({ version: 1, state })));
      return {
        onMessage: { addListener: (cb: (raw: unknown) => void) => messages.add(cb) },
        onDisconnect: { addListener: (cb: () => void) => disconnects.add(cb) },
        postMessage: () => void deliver(),
        disconnect: () => {
          detach?.();
          if (token) authority.close(token);
        },
      };
    },
    sendMessage: (
      raw: ConfirmMutation & { checkpointId: string; checkpointRevision: number; selection: ImportPreviewSelection },
      callback: (value: unknown) => void,
    ) => {
      sent.push(String(raw.type));
      void (async () => {
        if (String(raw.type) === 'registerImportPreview') {
          const proposal = await coordinator.registerImportPreview(
            raw.importContext!,
            raw.checkpointId,
            raw.checkpointRevision,
            raw.selection,
            sender,
          );
          return proposal ? { status: 'preview', proposal } : { status: 'empty' };
        }
        if (String(raw.type) === 'cancelMutation') return undefined;
        const result = await coordinator.submit(raw, sender);
        return mode === 'dropped' ? undefined : result;
      })().then(callback, error =>
        callback({ status: 'rejected', reason: error instanceof Error ? error.message : 'import-preview-rejected' }),
      );
    },
  };
  vi.stubGlobal('chrome', {
    runtime,
    storage: { onChanged: event() },
    permissions: { contains: async () => true, onRemoved: event() },
  });
  class WorkerBoundary {
    onmessage?: (event: { data: unknown }) => void;
    terminate() {}
    postMessage(request: { bytes: ArrayBuffer; format: ImportFormat }) {
      queueMicrotask(() =>
        this.onmessage?.({ data: { ok: true, result: parseImport(new Uint8Array(request.bytes), request.format) } }),
      );
    }
  }
  vi.stubGlobal('Worker', WorkerBoundary);
  let failAt = 0;
  let holdAt = 0;
  let quotaAt = 0;
  let gateAt = 0;
  let openGate = () => {};
  let gate = Promise.resolve();
  const payloads: { task: string; items: { id: string }[] }[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    payloads.push(payload);
    if (payloads.length === failAt) throw Error('synthetic provider interruption');
    if (payloads.length === holdAt) return new Promise<Response>(() => {});
    if (payloads.length === gateAt) await gate;
    if (payloads.length === quotaAt)
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function () {
        throw new DOMException('synthetic quota', 'QuotaExceededError');
      });
    const output =
      payload.task === 'import-map'
        ? {
            urlPath: payload.fields.find((f: { path: string[] }) => f.path.at(-1) === 'link').path,
            titlePath: payload.fields.find((f: { path: string[] }) => f.path.at(-1) === 'label')?.path ?? null,
          }
        : {
            assignments: payload.items.map((item: { id: string }) => ({
              itemId: item.id,
              folderId: 'bar',
              title: 'Suggested',
            })),
            newFolders: [],
          };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
  });
  vi.stubGlobal('fetch', fetcher);
  function Page() {
    const [visible, setVisible] = useState(true);
    return createElement(
      ThemeProvider,
      null,
      createElement(ThemePicker),
      createElement('button', { onClick: () => setVisible(!visible) }, '切换导入导航'),
      createElement(ImportWorkbench, { visible, settings }),
    );
  }
  const mount = () => render(createElement(Page));
  mount();
  const user = userEvent.setup();
  const upload = async (
    text: string,
    format: ImportFormat = 'txt',
    outcome: 'classified' | 'paused' | 'pending' = 'classified',
  ) => {
    await waitFor(() =>
      expect(screen.getByLabelText('导入目标根').querySelector('option[value="bar"]')).not.toBeNull(),
    );
    await user.selectOptions(screen.getByLabelText('导入格式'), format);
    const file = new File([text], 'synthetic');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(text).buffer });
    fireEvent.change(screen.getByLabelText('导入文件'), { target: { files: [file] } });
    await screen.findByText(/文件已读取/);
    await user.click(screen.getByRole('button', { name: '下一步：选择目标目录' }));
    await user.selectOptions(screen.getByLabelText('导入目标根'), 'bar');
    await user.click(screen.getByRole('button', { name: '下一步：AI 分类并预览' }));
    if (outcome !== 'pending') await screen.findByText(outcome === 'classified' ? /全量分类完成/ : /已暂停/);
    if (outcome === 'classified') await user.click(screen.getByText('任务和跳过项详情'));
  };
  return {
    user,
    upload,
    create,
    persistence,
    fetcher,
    mount,
    settings,
    native,
    payloads,
    sent,
    notify: () => changes.forEach(cb => cb()),
    onCreate: (hook: (call: number) => Promise<void>) => {
      beforeCreate = hook;
    },
    gate: (n: number) => {
      gateAt = n;
      gate = new Promise<void>(resolve => {
        openGate = resolve;
      });
    },
    release: () => openGate(),
    fail: (n: number) => {
      failAt = n;
    },
    hold: (n: number) => {
      holdAt = n;
    },
    quota: (n: number) => {
      quotaAt = n;
    },
    restart: async () => {
      cleanup();
      projection.stop();
      projection = new TreeProjection(
        {
          read: async () => structuredClone(native),
          listen: cb => {
            changes.add(cb);
            return () => changes.delete(cb);
          },
        },
        async () => 'install',
        'restarted-epoch',
      );
      projection.start();
      await projection.fresh();
      authority = new ImportAuthority(settings, projection, persistence.importCheckpoints, 'test');
      coordinator = new MutationCoordinator(
        projection,
        {
          create,
          update: async () => {
            throw Error('forbidden');
          },
          move: async () => {
            throw Error('forbidden');
          },
          remove: async () => {
            throw Error('forbidden');
          },
        },
        persistence,
        'test',
        undefined,
        undefined,
        authority,
      );
      mount();
    },
  };
}
it.each(['completed', 'rejected', 'dropped', 'unknown'] as const)(
  'real UI pipeline/controller/authority/coordinator %s handoff preserves ownership',
  async mode => {
    const h = await setup(mode);
    await h.upload('https://source.test/');
    await h.user.click(screen.getByText('下一步：确认导入'));
    await screen.findByText(/实际新建书签 1/);
    await h.user.click(screen.getByRole('button', { name: '确认并导入书签' }));
    await waitFor(() =>
      expect(screen.getByText(new RegExp(`请求 .*：${mode === 'dropped' ? 'unknown' : mode}`))).toBeVisible(),
    );
    expect(h.create).toHaveBeenCalledTimes(mode === 'rejected' ? 0 : 1);
    const saved = (await h.persistence.importCheckpoints.all())[0]!;
    if (mode === 'rejected') {
      expect(saved.requestId).toBeUndefined();
      expect(screen.getByText('下一步：确认导入')).toBeEnabled();
      await h.user.click(screen.getByText('下一步：确认导入'));
      await screen.findByText(/实际新建书签 1/);
    } else {
      expect(saved.requestId).toBeTruthy();
      expect(screen.getByText('下一步：确认导入')).toBeDisabled();
      await h.user.click(screen.getByRole('button', { name: '读取同一请求结果（日志去重，不新建请求）' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '读取同一请求结果（日志去重，不新建请求）' })).toBeEnabled(),
      );
      expect(h.create).toHaveBeenCalledTimes(1);
      if (mode === 'completed') {
        await h.user.click(screen.getByRole('button', { name: '导入另一个文件' }));
        expect(screen.getByRole('button', { name: '下一步：选择目标目录' })).toBeDisabled();
        expect(screen.getByLabelText('导入文件')).toHaveValue('');
        expect(h.create).toHaveBeenCalledTimes(1);
        expect((await h.persistence.importCheckpoints.all())[0]!.requestId).toBe(saved.requestId);
      }
    }
  },
);
it('real UI maps original fields, reloads manually, preserves empty drafts on same-job load and emits zero writes', async () => {
  const h = await setup();
  await h.upload('[{"link":"https://source.test/a"},{"link":"https://source.test/b"}]', 'json');
  expect(h.fetcher).toHaveBeenCalledTimes(2);
  cleanup();
  h.mount();
  if (!(screen.getByText('继续以前的导入任务').parentElement as HTMLDetailsElement).open)
    await h.user.click(screen.getByText('继续以前的导入任务'));
  await h.user.click(screen.getByRole('button', { name: '读取导入任务列表' }));
  await h.user.click(await screen.findByRole('button', { name: '加载任务' }));
  expect(h.fetcher).toHaveBeenCalledTimes(2);
  await screen.findByText(/已加载|此任务已交给/);
  for (const checkbox of screen.getAllByRole('checkbox')) await h.user.click(checkbox);
  await h.user.clear(screen.getByLabelText('明确编辑标题 0'));
  await h.user.selectOptions(screen.getByLabelText('明确调整目标 0'), '');
  await h.user.click(screen.getByRole('button', { name: '加载任务' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '加载任务' })).toBeEnabled());
  expect(screen.getByLabelText('明确编辑标题 0')).toHaveValue('');
  expect(screen.getByLabelText('明确调整目标 0')).toHaveValue('');
  expect(screen.getAllByRole('checkbox').every(node => !(node as HTMLInputElement).checked)).toBe(true);
  await h.user.click(screen.getByText('下一步：确认导入'));
  await screen.findByText('所选内容已存在，无需导入。');
  expect(h.create).not.toHaveBeenCalled();
});

it('real UI all-duplicate source shows identifiable skip evidence with zero model/native calls', async () => {
  const h = await setup();
  h.native[0]!.children![0]!.children!.push({
    id: 'duplicate',
    parentId: 'bar',
    title: 'Existing',
    url: 'https://existing.test/',
    syncing: false,
  });
  cleanup();
  h.mount();
  await h.upload(`https://existing.test/
https://existing.test/
ftp://unsupported.test/`);
  expect(screen.getAllByText(/https:\/\/existing.test\/ · 原始标题：.*existing-url/)).toHaveLength(2);
  expect(
    screen.getAllByText(/ftp:\/\/unsupported.test\/.*unsupported-protocol/).some(node => !node.closest('[hidden]')),
  ).toBe(true);
  await h.user.click(screen.getByText('下一步：确认导入'));
  await screen.findByText('所选内容已存在，无需导入。');
  expect(h.fetcher).not.toHaveBeenCalled();
  expect(h.create).not.toHaveBeenCalled();
});

it('selected empty destination visibly blocks preview until chosen or deselected', async () => {
  const h = await setup();
  await h.upload('https://source.test/');
  await h.user.selectOptions(screen.getByLabelText('明确调整目标 0'), '');
  expect(screen.getByText('下一步：确认导入')).toBeDisabled();
  expect(screen.getByText(/空目标草稿不会发送预览请求/)).toBeVisible();
  await h.user.selectOptions(screen.getByLabelText('明确调整目标 0'), 'bar');
  await h.user.click(screen.getByText('下一步：确认导入'));
  await screen.findByText(/实际新建书签 1/);
  expect(h.create).not.toHaveBeenCalled();
});

it('recognized rows skip mapping: ignored field count and deterministic duplicate/invalid rows display original identity', async () => {
  const h = await setup();
  await h.upload(
    JSON.stringify([
      { url: 'https://mapped.test/', title: 'First' },
      { url: 'https://mapped.test/', title: 'Duplicate source' },
      { url: 'ftp://invalid.test/', title: 'Invalid source' },
      { link: 'https://unmapped.test/', label: 'Ignored' },
    ]),
    'json',
  );
  expect(h.payloads.map(p => p.task)).toEqual(['import-classify']);
  expect(screen.getByText(/忽略了 2 个未映射字段：unmapped-candidates/)).toBeVisible();
  expect(screen.queryByText(/unmapped\.test/)).toBeNull();
  expect(
    screen.getByText(
      /https:\/\/mapped.test\/ · 原始标题：Duplicate source · 原目录：\[\].*来源路径：\[1,"url"\].*来源 1：file-duplicate；保留来源 0/,
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      /ftp:\/\/invalid.test\/ · 原始标题：Invalid source · 原目录：\[\].*来源路径：\[2,"url"\].*来源 2：unsupported-protocol/,
    ),
  ).toBeVisible();
  expect(screen.getByLabelText('明确编辑标题 0')).toHaveValue('First');
  expect(h.create).not.toHaveBeenCalled();
});

// Actual production byte budget, not a patched transport/fits method: three large source rows force three batches.
const multiBatchSource = () =>
  JSON.stringify(
    Array.from({ length: 3 }, (_, i) => ({
      url: `https://large.test/${i}/${'x'.repeat(550000)}`,
      title: `Locked ${i}`,
    })),
  );
async function loadTask(h: Awaited<ReturnType<typeof setup>>) {
  if (!(screen.getByText('继续以前的导入任务').parentElement as HTMLDetailsElement).open)
    await h.user.click(screen.getByText('继续以前的导入任务'));
  await h.user.click(screen.getByRole('button', { name: '读取导入任务列表' }));
  await h.user.click(await screen.findByRole('button', { name: '加载任务' }));
  await screen.findByText(/已加载|此任务已交给/);
}
it('real UI completes every byte batch and four actual themes/navigation retain edited empty drafts and unselected entries', async () => {
  const h = await setup();
  await h.upload(multiBatchSource(), 'json');
  expect(h.payloads.map(p => p.items.length)).toEqual([1, 1, 1]);
  expect((await h.persistence.importCheckpoints.all())[0]!.classified).toHaveLength(3);
  await h.user.clear(screen.getByLabelText('明确编辑标题 0'));
  await h.user.selectOptions(screen.getByLabelText('明确调整目标 0'), '');
  await h.user.click(screen.getAllByRole('checkbox')[1]!);
  for (const theme of APPEARANCES) {
    await h.user.click(screen.getByLabelText(theme));
    expect(screen.getByLabelText(theme)).toBeChecked();
    await h.user.click(screen.getByRole('button', { name: '切换导入导航' }));
    expect(screen.queryByRole('region', { name: '导入工作台' })).toBeNull();
    await h.user.click(screen.getByRole('button', { name: '切换导入导航' }));
    expect(screen.getByLabelText('明确编辑标题 0')).toHaveValue('');
    expect(screen.getByLabelText('明确调整目标 0')).toHaveValue('');
    expect(screen.getAllByRole('checkbox')[1]).not.toBeChecked();
  }
  await loadTask(h);
  expect(screen.getByLabelText('明确编辑标题 0')).toHaveValue('');
  expect(screen.getByLabelText('明确调整目标 0')).toHaveValue('');
  expect(h.fetcher).toHaveBeenCalledTimes(3);
  expect(h.create).not.toHaveBeenCalled();
}, 30000);

it.each(['remount', 'worker-restart'] as const)(
  'real UI manual continuation after %s only sends uncommitted rows',
  async action => {
    const h = await setup();
    h.fail(2);
    await h.upload(multiBatchSource(), 'json', 'paused');
    const saved = (await h.persistence.importCheckpoints.all())[0]!;
    expect(saved.classified).toHaveLength(1);
    const committed = h.payloads[0]!.items[0]!.id;
    if (action === 'worker-restart') await h.restart();
    else {
      cleanup();
      h.mount();
    }
    await loadTask(h);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    await h.user.clear(screen.getByLabelText('明确编辑标题 0'));
    await h.user.selectOptions(screen.getByLabelText('明确调整目标 0'), '');
    await h.user.click(screen.getAllByRole('checkbox')[1]!);
    // A new worker epoch is not classification evidence: the same button continues after a restart.
    await h.user.click(screen.getByRole('button', { name: '继续分类' }));
    await screen.findByText(/全量分类完成/);
    expect(h.payloads.slice(2).flatMap(p => p.items.map(i => i.id))).not.toContain(committed);
    expect((await h.persistence.importCheckpoints.all())[0]!.classified).toHaveLength(3);
    expect(h.create).not.toHaveBeenCalled();
    expect(screen.getByLabelText('明确编辑标题 0')).toHaveValue('');
    expect(screen.getByLabelText('明确调整目标 0')).toHaveValue('');
    expect(screen.getAllByRole('checkbox')[1]).not.toBeChecked();
    await h.user.selectOptions(screen.getByLabelText('明确调整目标 0'), 'bar');
    await h.user.click(screen.getByText('下一步：确认导入'));
    await screen.findByText(/实际新建书签 2/);
    await h.settings.save(
      { adapter: 'openai-compatible', baseUrl: 'https://synthetic.test', model: 'changed', timeoutMs: 10000 },
      { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
      '',
      false,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '确认并导入书签' })).toBeDisabled());
    expect(screen.getByText(/模型设置或权限已变化/)).toBeVisible();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.sent).not.toContain('cancelMutation');
  },
  30000,
);

it.each(['root', 'privacy'] as const)(
  'real UI %s changes inside the scope refuse continuation and preserve prior evidence',
  async change => {
    const h = await setup();
    h.fail(2);
    await h.upload(multiBatchSource(), 'json', 'paused');
    const before = (await h.persistence.importCheckpoints.all())[0]!;
    if (change === 'root') h.native[0]!.children![0]!.title = 'Changed root';
    else
      await h.settings.save(
        { adapter: 'openai-compatible', baseUrl: 'https://synthetic.test', model: 'm', timeoutMs: 10000 },
        {
          fullUrl: true,
          bodyEnabled: false,
          excludedFolders: [{ installationId: 'install', nativeId: 'bar', kind: 'folder' }],
        },
        '',
        false,
      );
    await h.restart();
    await loadTask(h);
    await h.user.click(screen.getByRole('button', { name: '继续分类' }));
    await screen.findByText(change === 'root' ? /已暂停：stale-context/ : /已暂停：privacy-excluded/);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.create).not.toHaveBeenCalled();
    expect((await h.persistence.importCheckpoints.all())[0]).toEqual(before);
  },
  30000,
);

it('real UI: native changes outside the scope neither cancel classification nor drop a registered preview', async () => {
  const h = await setup();
  h.gate(2);
  await h.upload(multiBatchSource(), 'json', 'pending');
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(2));
  h.native[0]!.children!.push({ id: 'other', parentId: '0', title: 'Other', syncing: false, children: [] });
  h.notify();
  await waitFor(() =>
    expect(screen.getByLabelText('导入目标根').querySelector('option[value="other"]')).not.toBeNull(),
  );
  h.release();
  await screen.findByText(/全量分类完成/);
  expect(h.fetcher).toHaveBeenCalledTimes(3);
  expect((await h.persistence.importCheckpoints.all())[0]!.classified).toHaveLength(3);
  await h.user.click(screen.getByText('下一步：确认导入'));
  await screen.findByText(/实际新建书签 3/);
  h.native[0]!.children![1]!.title = 'Other renamed';
  h.notify();
  await waitFor(() => expect(screen.getByText(/Other renamed/)).toBeInTheDocument());
  expect(screen.getByText(/实际新建书签 3/)).toBeVisible();
  expect(screen.getByRole('button', { name: '确认并导入书签' })).toBeEnabled();
  expect(screen.getByText(/预览已核对/)).toBeVisible();
  expect(h.sent).not.toContain('cancelMutation');
  expect(h.create).not.toHaveBeenCalled();
}, 30000);

it('real UI: a settings change cancels in-flight classification and keeps committed rows', async () => {
  const h = await setup();
  h.gate(2);
  await h.upload(multiBatchSource(), 'json', 'pending');
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(2));
  await h.settings.save(
    { adapter: 'openai-compatible', baseUrl: 'https://synthetic.test', model: 'changed', timeoutMs: 10000 },
    { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
    '',
    false,
  );
  await screen.findByText(/已暂停：cancelled/);
  h.release();
  expect((await h.persistence.importCheckpoints.all())[0]!.classified).toHaveLength(1);
  expect(h.fetcher).toHaveBeenCalledTimes(2);
  expect(h.create).not.toHaveBeenCalled();
}, 30000);

it('real UI: a settings change while applying never sends cancelMutation and the handed-off batch completes', async () => {
  const h = await setup();
  await h.upload('https://source.test/one\nhttps://source.test/two');
  await h.user.click(screen.getByText('下一步：确认导入'));
  await screen.findByText(/实际新建书签 2/);
  h.onCreate(async call => {
    if (call === 1)
      await h.settings.save(
        { adapter: 'openai-compatible', baseUrl: 'https://synthetic.test', model: 'changed', timeoutMs: 10000 },
        { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
        '',
        false,
      );
  });
  await h.user.click(screen.getByRole('button', { name: '确认并导入书签' }));
  await screen.findByText(/请求 .*：completed/);
  expect(h.create).toHaveBeenCalledTimes(2);
  expect(h.sent.filter(type => type === 'cancelMutation')).toEqual([]);
  expect((await h.persistence.importCheckpoints.all())[0]!.requestId).toBeTruthy();
  expect(screen.getByText('下一步：确认导入')).toBeDisabled();
}, 30000);

it('real UI cancel aborts current batch and manual resume preserves committed prefix', async () => {
  const h = await setup();
  h.hold(2);
  await h.upload(multiBatchSource(), 'json', 'pending');
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(2));
  await h.user.click(screen.getByRole('button', { name: '暂停当前任务' }));
  await screen.findByText(/已暂停：cancelled/);
  expect((await h.persistence.importCheckpoints.all())[0]!.classified).toHaveLength(1);
  await h.user.click(screen.getByRole('button', { name: '继续分类' }));
  await screen.findByText(/全量分类完成/);
  expect(h.payloads.slice(2).flatMap(p => p.items.map(i => i.id))).not.toContain(h.payloads[0]!.items[0]!.id);
  expect(h.create).not.toHaveBeenCalled();
}, 30000);

it('real UI checkpoint quota stops batching and manual resume repeats only uncommitted response', async () => {
  const h = await setup();
  h.quota(2);
  await h.upload(multiBatchSource(), 'json', 'paused');
  expect(h.fetcher).toHaveBeenCalledTimes(2);
  expect((await h.persistence.importCheckpoints.all())[0]!.classified).toHaveLength(1);
  vi.restoreAllMocks();
  h.quota(0);
  await h.user.click(screen.getByRole('button', { name: '继续分类' }));
  await screen.findByText(/全量分类完成/);
  expect(h.payloads[2]!.items).toEqual(h.payloads[1]!.items);
  expect(h.create).not.toHaveBeenCalled();
}, 30000);

it('real UI partial native outcome stays journal-owned and never replays successful creates', async () => {
  const h = await setup('partial');
  await h.upload('https://source.test/one\nhttps://source.test/two');
  await h.user.click(screen.getByText('下一步：确认导入'));
  await screen.findByText(/实际新建书签 2/);
  await h.user.click(screen.getByRole('button', { name: '确认并导入书签' }));
  await screen.findByText(/请求 .*：partial/);
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(screen.getByText('下一步：确认导入')).toBeDisabled();
  await h.user.click(screen.getByRole('button', { name: '读取同一请求结果（日志去重，不新建请求）' }));
  expect(h.create).toHaveBeenCalledTimes(1);
  cleanup();
  h.mount();
  await loadTask(h);
  expect(screen.getByText('继续分类', { selector: 'button' })).toBeDisabled();
  expect(h.create).toHaveBeenCalledTimes(1);
});
it('real authority privacy rejection appears precisely in UI without handoff or transport outage', async () => {
  const h = await setup();
  h.native[0]!.children![0]!.children!.push({
    id: 'private',
    parentId: 'bar',
    title: 'Private',
    syncing: false,
    children: [],
  });
  await h.settings.save(
    { adapter: 'openai-compatible', baseUrl: 'https://synthetic.test', model: 'm', timeoutMs: 10000 },
    {
      fullUrl: true,
      bodyEnabled: false,
      excludedFolders: [{ installationId: 'install', nativeId: 'private', kind: 'folder' }],
    },
    '',
    false,
  );
  cleanup();
  h.mount();
  await h.upload('https://source.test/');
  await h.user.selectOptions(screen.getByLabelText('明确调整目标 0'), 'private');
  await h.user.click(screen.getByText('下一步：确认导入'));
  await screen.findByText(/privacy-excluded：/);
  expect(screen.queryByText(/import-transport-unavailable/)).toBeNull();
  expect(h.create).not.toHaveBeenCalled();
  expect(await h.persistence.all()).toEqual([]);
});
