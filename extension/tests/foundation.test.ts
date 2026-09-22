import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../ui/App';

describe('foundation appearance and context', () => {
  it('defaults to stationery and preserves search, title and selection across all four themes without effects', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const user = userEvent.setup();
    const { container } = render(createElement(App, { page: 'panel' }));
    expect(container.querySelector('[data-theme="stationery"]')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await user.type(screen.getByRole('searchbox'), '保留搜索');
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '设置' }));
    await user.click(screen.getByRole('button', { name: /外观/ }));
    for (const name of ['轻盈原生', '温润纸感', '清爽文具（默认）', '深色精密']) {
      await user.click(screen.getByRole('radio', { name }));
      expect(screen.getByRole('searchbox', { hidden: true })).toHaveValue('保留搜索');
      expect(screen.getByRole('radio', { name })).toBeChecked();
    }
    expect(network).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    network.mockRestore(); storage.mockRestore();
  });
  it('exposes keyboard-operable appearance settings and resets only on a new page session', async () => {
    const user = userEvent.setup();
    const first = render(createElement(App, { page: 'options' }));
    await user.click(screen.getByRole('button', { name: /外观/ }));
    const native = screen.getByRole('radio', { name: '轻盈原生' });
    native.focus();
    await user.keyboard(' ');
    expect(native).toBeChecked();
    first.unmount();
    render(createElement(App, { page: 'options' }));
    await user.click(screen.getByRole('button', { name: /外观/ }));
    expect(screen.getByRole('radio', { name: '清爽文具（默认）' })).toBeChecked();
    expect(screen.getByText(/仅在当前页面会话生效/)).toBeVisible();
  });
  it('does not invent current-page data or installed example bookmarks', async () => {
    render(createElement(App, { page: 'panel' }));
    expect(screen.getByText('尚未连接书签')).toBeVisible();
    expect(screen.queryByRole('button', { name: '收藏当前页面' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '收藏确认卡' })).not.toBeInTheDocument();
  });
});

it('shares readable empty, error and loading state semantics in every theme', async () => {
  const { ThemeProvider, ThemePicker } = await import('../ui/ThemeProvider');
  const { StateMessage } = await import('../ui/StateMessage');
  const user = userEvent.setup();
  render(createElement(ThemeProvider, null,
    createElement(ThemePicker),
    createElement(StateMessage, { kind: 'error', title: '无法读取', children: '请稍后重试' }),
    createElement(StateMessage, { kind: 'loading', title: '正在准备', children: '请稍候' }),
  ));
  for (const name of ['轻盈原生', '温润纸感', '清爽文具（默认）', '深色精密']) {
    await user.click(screen.getByRole('radio', { name }));
    expect(screen.getByRole('alert')).toHaveTextContent('无法读取');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  }
});
