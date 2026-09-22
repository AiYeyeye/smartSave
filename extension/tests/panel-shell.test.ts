import { createElement } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../ui/App';
import { TreeRows } from '../panel/BookmarkTree';
import { TREE_PORT, type TreeSnapshot } from '../domain/node-reference';
const tree: TreeSnapshot = {
  installationId: 'i',
  epoch: 'e',
  observedRevision: 0,
  roots: ['r'],
  nodes: [
    {
      ref: { installationId: 'i', nativeId: 'r', kind: 'folder' },
      title: 'Root',
      index: 0,
      childrenIds: ['f', 'g'],
      readOnly: true,
      childrenWritable: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'i', nativeId: 'f', kind: 'folder' },
      title: 'Folder',
      parentId: 'r',
      index: 0,
      childrenIds: ['b'],
      readOnly: false,
      childrenWritable: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'i', nativeId: 'g', kind: 'folder' },
      title: 'Other',
      parentId: 'r',
      index: 1,
      childrenIds: [],
      readOnly: false,
      childrenWritable: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'i', nativeId: 'b', kind: 'bookmark' },
      title: 'Book',
      url: 'https://example.test/',
      parentId: 'f',
      index: 0,
      childrenIds: [],
      readOnly: false,
      observedRevision: 0,
    },
  ],
};

function chromeStub(readyTree = false) {
  vi.stubGlobal('chrome', {
    windows: { getCurrent: async () => ({ id: 1 }) },
    runtime: {
      getURL: (path: string) => `chrome-extension://i${path.startsWith('/') ? path : `/${path}`}`,
      connect: (info?: { name?: string }) => {
        const listeners: Array<(message: unknown) => void> = [];
        return {
          onMessage: {
            addListener: (fn: (message: unknown) => void) => {
              listeners.push(fn);
            },
          },
          onDisconnect: { addListener: () => {} },
          postMessage: () => {
            if (readyTree && info?.name === TREE_PORT)
              listeners.forEach(fn => fn({ version: 1, state: { status: 'ready', snapshot: tree } }));
          },
          disconnect: () => {},
        };
      },
      sendMessage: () => {},
    },
    storage: {
      local: {
        get: async () => ({ 'tree.expanded.i.r': true, 'tree.expanded.i.f': true }),
        set: async () => {},
        remove: async () => {},
        setAccessLevel: async () => {},
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    permissions: { onRemoved: { addListener: () => {}, removeListener: () => {} }, contains: async () => false },
  });
}

async function overflow(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: '更多操作' }));
  await user.click(screen.getByRole('menuitem', { name }));
}
afterEach(() => {
  location.hash = '';
});

it('popup chrome is brand, on-demand search and labeled overflow; long workbenches open in the options page', async () => {
  chromeStub();
  const create = vi.fn(async () => ({ id: 1 }));
  vi.stubGlobal('chrome', { ...chrome, tabs: { create } });
  const user = userEvent.setup();
  render(createElement(App, { page: 'panel' }));
  expect(screen.queryByRole('searchbox')).toBeNull();
  // The header carries no persistent CTA; the explicit capture entry lives in the main area.
  expect(within(screen.getByRole('banner')).queryByRole('button', { name: '收藏当前页面' })).toBeNull();
  expect(screen.getByRole('button', { name: '收藏当前页面' })).toBeEnabled();
  expect(screen.queryByRole('heading', { name: '书签目录' })).toBeNull();
  expect(screen.queryByRole('button', { name: '整理' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '搜索' }));
  expect(screen.getByRole('searchbox')).toBeVisible();
  await overflow(user, '设置');
  expect(screen.getByRole('region', { name: '设置' })).toBeVisible();
  expect(screen.queryByRole('region', { name: '工作台' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '返回书签' }));
  for (const [item, route] of [
    ['AI 整理', 'organize'],
    ['导入', 'import'],
    ['导出', 'export'],
  ] as const) {
    await overflow(user, item);
    expect(create).toHaveBeenLastCalledWith({ url: `chrome-extension://i/options/index.html#${route}` });
    expect(screen.getByRole('button', { name: '更多操作' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '智栏', level: 1 })).toBeVisible();
  }
  expect(create).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole('region', { name: '整理工作台' })).toBeNull();
  expect(screen.queryByRole('region', { name: '导入工作台' })).toBeNull();
  expect(screen.queryByRole('region', { name: '导出设置' })).toBeNull();
});

it('options page hosts the browse, organize and import workbenches through its hub and routing hash', async () => {
  chromeStub();
  const user = userEvent.setup();
  location.hash = '#organize';
  const view = render(createElement(App, { page: 'options' }));
  expect(screen.getByRole('region', { name: '整理工作台' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'AI 整理', level: 1 })).toBeVisible();
  expect(screen.queryByRole('button', { name: '收藏当前页面' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '返回设置' }));
  expect(screen.getByRole('region', { name: '设置' })).toBeVisible();
  expect(screen.queryByRole('region', { name: '整理工作台' })).toBeNull();
  await user.click(within(screen.getByRole('region', { name: '工作台' })).getByRole('button', { name: '导入书签' }));
  expect(screen.getByRole('region', { name: '导入工作台' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '返回设置' }));
  await user.click(within(screen.getByRole('region', { name: '工作台' })).getByRole('button', { name: '书签目录' }));
  expect(screen.getByRole('region', { name: '书签目录' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '搜索' }));
  expect(screen.getByRole('searchbox')).toBeVisible();
  await overflow(user, 'AI 整理');
  expect(screen.getByRole('region', { name: '整理工作台' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '返回设置' }));
  await user.click(screen.getByRole('button', { name: /外观/ }));
  expect(screen.getByRole('radio', { name: '清爽文具（默认）' })).toBeChecked();
  await user.click(screen.getByRole('button', { name: '返回设置' }));
  expect(screen.getByRole('region', { name: '工作台' })).toBeVisible();
  view.unmount();
  location.hash = '#export';
  render(createElement(App, { page: 'options' }));
  expect(await screen.findByRole('region', { name: '导出设置' })).toBeVisible();
  expect(screen.getByRole('region', { name: '备份与恢复' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '导出与备份', level: 1 })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '返回设置' }));
  expect(screen.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
});

it('settings overview drills into one category and keeps previous controls reachable', async () => {
  const user = userEvent.setup();
  render(createElement(App, { page: 'options' }));
  expect(screen.queryByRole('radio', { name: '清爽文具（默认）' })).toBeNull();
  expect(screen.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
  expect(document.querySelector('.brand-kicker')).toBeNull();
  expect(screen.queryByText('个性化与智能')).toBeNull();
  expect(screen.queryByText('数据与安全')).toBeNull();
  await user.click(screen.getByRole('button', { name: /外观/ }));
  expect(screen.getByRole('radio', { name: '清爽文具（默认）' })).toBeChecked();
  await user.click(screen.getByRole('radio', { name: '轻盈原生' }));
  await user.click(screen.getByRole('button', { name: '返回设置' }));
  expect(screen.getByRole('button', { name: '外观' })).toHaveAttribute('title', '四种风格 · 当前为轻盈原生');
  await user.click(screen.getByRole('button', { name: /AI 模型/ }));
  expect(screen.getByLabelText('接口协议')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '返回设置' }));
  await user.click(screen.getByRole('button', { name: /隐私/ }));
  expect(screen.getByRole('checkbox', { name: /发送完整网址/ })).toBeVisible();
  expect(screen.getByRole('region', { name: '网站目录规则' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '返回设置' }));
  await user.click(screen.getByRole('button', { name: /导出与备份/ }));
  expect(screen.getByRole('region', { name: '导出设置' })).toBeVisible();
  expect(screen.getByRole('region', { name: '备份与恢复' })).toBeVisible();
  expect(screen.getAllByRole('button', { name: '返回设置' })).toHaveLength(1);
});

it('row overflow and directory context menu start CRUD without select/open/move-before chrome', async () => {
  chromeStub();
  const user = userEvent.setup();
  const send = vi.fn();
  vi.stubGlobal('chrome', { ...chrome, runtime: { ...chrome.runtime, sendMessage: send } });
  render(createElement(TreeRows, { snapshot: tree }));
  expect(screen.queryByRole('button', { name: '选择 Book' })).toBeNull();
  expect(screen.queryByText('移至此项前')).toBeNull();
  expect(screen.queryByRole('button', { name: '打开' })).toBeNull();
  const folder = await screen.findByRole('button', { name: 'Folder' });
  fireEvent.contextMenu(folder.closest('.bookmark-row')!);
  expect(screen.getByRole('menuitem', { name: '新建书签' })).toBeVisible();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Book 操作' }));
  await user.click(screen.getByRole('menuitem', { name: '编辑 / 重命名' }));
  expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('Book');
  expect(send).not.toHaveBeenCalled();
});

it('folder overflow create names the destination and focuses the form', async () => {
  chromeStub();
  const user = userEvent.setup();
  render(createElement(TreeRows, { snapshot: tree }));
  await user.click(await screen.findByRole('button', { name: 'Folder 操作' }));
  await user.click(screen.getByRole('menuitem', { name: '新建书签' }));
  expect(screen.getByText('目标目录：Folder')).toBeVisible();
  await waitFor(() => expect(screen.getByRole('textbox', { name: '标题' })).toHaveFocus());
});

it('batch mode shows count and exit without writing on select', async () => {
  chromeStub();
  const send = vi.fn();
  vi.stubGlobal('chrome', { ...chrome, runtime: { ...chrome.runtime, sendMessage: send } });
  const user = userEvent.setup();
  render(createElement(TreeRows, { snapshot: tree, batchNonce: 1 }));
  const bar = screen.getByRole('region', { name: '批量管理' });
  expect(within(bar).getByText('已选 0 项')).toBeVisible();
  await user.click(await screen.findByRole('checkbox', { name: '选择 Book' }));
  expect(within(bar).getByText('已选 1 项')).toBeVisible();
  expect(send).not.toHaveBeenCalled();
  expect(within(bar).getByRole('button', { name: '删除' })).toBeEnabled();
  await user.click(within(bar).getByRole('button', { name: '退出选择' }));
  expect(screen.queryByRole('region', { name: '批量管理' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: '选择 Book' })).toBeNull();
});

it('batch mutate actions stay disabled for read-only or multi-select', async () => {
  chromeStub();
  const user = userEvent.setup();
  render(createElement(TreeRows, { snapshot: tree, batchNonce: 1 }));
  const bar = screen.getByRole('region', { name: '批量管理' });
  await user.click(await screen.findByRole('checkbox', { name: '选择 Root' }));
  expect(within(bar).getByRole('button', { name: '删除' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: '选择 Book' }));
  expect(within(bar).getByText('已选 2 项')).toBeVisible();
  expect(within(bar).getByRole('status')).toHaveTextContent(
    '当前版本暂不支持批量修改，请只选择一项进行编辑、移动或删除',
  );
  expect(within(bar).getByRole('button', { name: '编辑 / 重命名' })).toBeDisabled();
  expect(within(bar).getByRole('button', { name: '移动' })).toBeDisabled();
  expect(within(bar).getByRole('button', { name: '删除' })).toBeDisabled();
});

it('overflow batch management shows the batch bar on a ready tree', async () => {
  chromeStub(true);
  const user = userEvent.setup();
  render(createElement(App, { page: 'panel' }));
  await overflow(user, '批量管理');
  expect(await screen.findByRole('region', { name: '批量管理' })).toBeVisible();
  expect(await screen.findByRole('checkbox', { name: '选择 Book' })).toBeVisible();
});

it('search Escape clears then collapses', async () => {
  chromeStub();
  const user = userEvent.setup();
  render(createElement(App, { page: 'panel' }));
  await user.click(screen.getByRole('button', { name: '搜索' }));
  await user.type(screen.getByRole('searchbox'), 'abc');
  await user.keyboard('{Escape}');
  expect(screen.getByRole('searchbox')).toHaveValue('');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('searchbox')).toBeNull();
});

it('stylesheet applies approved Soft UI shared density and no horizontal overflow', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../ui/theme.css'), 'utf8');
  expect(css).toContain('--row:44px');
  expect(css).toContain('overflow-x:hidden');
  expect(css).toContain('.bookmark-tree{list-style:none;padding:0;margin:0}');
  expect(css).toContain('.bookmark-row{min-height:var(--row);');
  expect(css).toContain('.bookmark-row:hover .command-menu,.bookmark-row:focus-within .command-menu{opacity:1}');
  expect(css).toContain('.brand-kicker');
  expect(css).toContain('prefers-reduced-motion');
  expect(css).toContain('.in-panel-select-list');
  expect(css).toContain('.bookmark-favicon');
  expect(css).not.toContain('prefers-color-scheme');
});

it('bookmark rows use the browser favicon URL and fall back locally on error', async () => {
  chromeStub();
  const { container } = render(createElement(TreeRows, { snapshot: tree }));
  const image = await waitFor(() => {
    const node = container.querySelector('img.bookmark-favicon');
    expect(node).not.toBeNull();
    return node as HTMLImageElement;
  });
  expect(image).toHaveAttribute('src', 'chrome-extension://i/_favicon/?pageUrl=https%3A%2F%2Fexample.test%2F&size=16');
  expect(image).toHaveAttribute('alt', '');
  fireEvent.error(image);
  expect(container.querySelector('img.bookmark-favicon')).toBeNull();
  expect(container.querySelector('.bookmark-label svg')).not.toBeNull();
});
