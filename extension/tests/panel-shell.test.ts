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

afterEach(() => {
  location.hash = '';
});

it('popup: brand, always-on search, pinned tool dock; long workbenches open in the options page', async () => {
  chromeStub();
  const create = vi.fn(async () => ({ id: 1 }));
  vi.stubGlobal('chrome', { ...chrome, tabs: { create } });
  vi.stubGlobal('close', vi.fn());
  const user = userEvent.setup();
  render(createElement(App, { page: 'panel' }));
  expect(screen.getByRole('heading', { name: '智栏', level: 1 })).toBeVisible();
  expect(screen.getByRole('searchbox')).toBeVisible();
  // The header carries no persistent CTA; the explicit capture entry lives in the main area.
  expect(within(screen.getByRole('banner')).queryByRole('button', { name: '收藏当前页面' })).toBeNull();
  expect(screen.getByRole('button', { name: '收藏当前页面' })).toBeEnabled();
  const dock = screen.getByRole('contentinfo', { name: '书签工具' });
  for (const [item, route] of [
    ['整理', 'organize'],
    ['导入', 'import'],
    ['导出', 'export'],
  ] as const) {
    await user.click(within(dock).getByRole('button', { name: item }));
    expect(create).toHaveBeenLastCalledWith({ url: `chrome-extension://i/options/index.html#${route}` });
  }
  expect(create).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole('region', { name: '整理工作台' })).toBeNull();
  expect(screen.queryByRole('region', { name: '导入工作台' })).toBeNull();
  expect(screen.queryByRole('region', { name: '导出设置' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '设置' }));
  expect(screen.getByRole('heading', { name: '快速设置', level: 1 })).toBeVisible();
  expect(screen.getByRole('region', { name: '外观' })).toBeVisible();
  await user.click(
    within(screen.getByRole('region', { name: '完整设置' })).getByRole('button', { name: /隐私与规则/ }),
  );
  expect(create).toHaveBeenLastCalledWith({ url: 'chrome-extension://i/options/index.html#privacy' });
  await user.click(screen.getByRole('button', { name: '返回书签' }));
  expect(screen.getByRole('searchbox')).toBeVisible();
});

it('options page: one side navigation hosts every workbench and settings page, routed by hash', async () => {
  chromeStub();
  const user = userEvent.setup();
  location.hash = '#organize';
  const view = render(createElement(App, { page: 'options' }));
  const nav = screen.getByRole('navigation', { name: '设置导航' });
  expect(screen.getByRole('region', { name: '整理工作台' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'AI 整理', level: 1 })).toBeVisible();
  expect(within(nav).getByRole('button', { name: 'AI 整理' })).toHaveAttribute('aria-current', 'page');
  expect(screen.queryByRole('button', { name: '收藏当前页面' })).toBeNull();
  await user.click(within(nav).getByRole('button', { name: '导入书签' }));
  expect(screen.getByRole('region', { name: '导入工作台' })).toBeVisible();
  expect(screen.queryByRole('region', { name: '整理工作台' })).toBeNull();
  expect(location.hash).toBe('#import');
  await user.click(within(nav).getByRole('button', { name: '书签目录' }));
  expect(screen.getByRole('region', { name: '书签目录' })).toBeVisible();
  expect(screen.getByRole('searchbox')).toBeVisible();
  await user.click(within(nav).getByRole('button', { name: '外观' }));
  expect(screen.getByRole('radio', { name: '跟随系统' })).toBeChecked();
  view.unmount();
  location.hash = '#export';
  render(createElement(App, { page: 'options' }));
  expect(await screen.findByRole('region', { name: '导出设置' })).toBeVisible();
  expect(screen.getByRole('region', { name: '备份与恢复' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '导出与备份', level: 1 })).toBeVisible();
});

it('settings pages: privacy, records & debug (off by default) and the legacy model form stay reachable', async () => {
  const user = userEvent.setup();
  render(createElement(App, { page: 'options' }));
  const nav = screen.getByRole('navigation', { name: '设置导航' });
  expect(screen.getByRole('heading', { name: '书签目录', level: 1 })).toBeVisible();
  await user.click(within(nav).getByRole('button', { name: '隐私与规则' }));
  expect(screen.getByRole('checkbox', { name: /发送完整网址/ })).toBeVisible();
  expect(screen.getByRole('region', { name: '网站目录规则' })).toBeVisible();
  await user.click(within(nav).getByRole('button', { name: '收藏记录与调试' }));
  expect(screen.getByRole('switch', { name: '开启 Debug 日志' })).not.toBeChecked();
  expect(screen.getByRole('region', { name: '收藏记录' })).toBeVisible();
  await user.click(screen.getByText('旧版单连接模型配置（兼容）'));
  await user.click(screen.getByText('高级：协议、地址与超时'));
  expect(screen.getByLabelText('接口协议')).toBeVisible();
  await user.click(within(nav).getByRole('button', { name: '导出与备份' }));
  expect(screen.getByRole('region', { name: '导出设置' })).toBeVisible();
  expect(screen.getByRole('region', { name: '备份与恢复' })).toBeVisible();
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
  await user.click(screen.getByRole('menuitem', { name: '重命名' }));
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

it('dock batch button shows the batch bar on a ready tree', async () => {
  chromeStub(true);
  const user = userEvent.setup();
  render(createElement(App, { page: 'panel' }));
  await user.click(within(screen.getByRole('contentinfo', { name: '书签工具' })).getByRole('button', { name: '批量' }));
  expect(await screen.findByRole('region', { name: '批量管理' })).toBeVisible();
  expect(await screen.findByRole('checkbox', { name: '选择 Book' })).toBeVisible();
});

it('search Escape clears the query and the tree comes back', async () => {
  chromeStub(true);
  const user = userEvent.setup();
  render(createElement(App, { page: 'panel' }));
  await user.type(screen.getByRole('searchbox'), 'abc');
  expect(screen.queryByRole('region', { name: '书签目录' })).toBeNull();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('searchbox')).toHaveValue('');
  expect(screen.getByRole('region', { name: '书签目录' })).toBeVisible();
});

it('stylesheet: shared tokens for light/dark/accent, pinned popup dock, styled scrollbars, reduced motion', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../ui/theme.css'), 'utf8');
  expect(css).toContain(".theme-root[data-mode='dark']");
  expect(css).toContain(".theme-root[data-accent='teal']");
  // The popup root fills the fixed 580px viewport so the dock stays at the bottom.
  expect(css).toMatch(/body\.popup #root,\s*body\.popup \.theme-root \{\s*height: 100%;/);
  expect(css).toContain('scrollbar-width: thin');
  expect(css).toContain('::-webkit-scrollbar-thumb');
  // Chrome injects body { font-size: 75% } into extension pages.
  expect(css).toMatch(/body \{\s*font-size: 14px;/);
  expect(css).toContain('.bookmark-row:hover .command-menu,');
  expect(css).toContain('prefers-reduced-motion');
  expect(css).toContain('.in-panel-select-list');
  expect(css).toContain('.bookmark-favicon');
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
