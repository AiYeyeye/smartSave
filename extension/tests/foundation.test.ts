import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../ui/App';
import { APPEARANCE_KEY } from '../ui/ThemeProvider';
import { APPEARANCES } from './appearance';

describe('foundation appearance and context', () => {
  it('defaults to system mode + indigo and keeps the search draft across every appearance without effects', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const user = userEvent.setup();
    const { container } = render(createElement(App, { page: 'options' }));
    const root = container.querySelector('.theme-root')!;
    expect(root).toHaveAttribute('data-accent', 'indigo');
    expect(root).toHaveAttribute('data-mode', 'light');
    await user.type(screen.getByRole('searchbox'), '保留搜索');
    await user.click(screen.getByRole('button', { name: /外观/ }));
    for (const name of APPEARANCES) {
      await user.click(screen.getByRole('radio', { name }));
      expect(screen.getByRole('searchbox', { hidden: true })).toHaveValue('保留搜索');
      expect(screen.getByRole('radio', { name })).toBeChecked();
    }
    expect(root).toHaveAttribute('data-accent', 'blue');
    expect(network).not.toHaveBeenCalled();
    // Only the appearance choice is written, under its own key.
    expect(storage.mock.calls.every(([key]) => key === APPEARANCE_KEY)).toBe(true);
    network.mockRestore();
    storage.mockRestore();
  });
  it('keyboard-operable appearance persists to the next page session', async () => {
    const user = userEvent.setup();
    const first = render(createElement(App, { page: 'options' }));
    await user.click(screen.getByRole('button', { name: /外观/ }));
    const dark = screen.getByRole('radio', { name: '深色' });
    dark.focus();
    await user.keyboard(' ');
    expect(dark).toBeChecked();
    first.unmount();
    const second = render(createElement(App, { page: 'panel' }));
    expect(second.container.querySelector('.theme-root')).toHaveAttribute('data-mode', 'dark');
  });
  it('does not invent current-page data or installed example bookmarks', async () => {
    render(createElement(App, { page: 'panel' }));
    expect(screen.getByText('尚未连接书签')).toBeVisible();
    // Browsing has no idle manual-save CTA or invented page data.
    expect(screen.queryByRole('button', { name: '收藏当前页面' })).toBeNull();
    expect(screen.queryByRole('region', { name: '收藏确认卡' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/https?:\/\//);
  });
});

it('shares readable empty, error and loading state semantics in every appearance', async () => {
  const { ThemeProvider, ThemePicker } = await import('../ui/ThemeProvider');
  const { StateMessage } = await import('../ui/StateMessage');
  const user = userEvent.setup();
  render(
    createElement(
      ThemeProvider,
      null,
      createElement(ThemePicker),
      createElement(StateMessage, { kind: 'error', title: '无法读取', children: '请稍后重试' }),
      createElement(StateMessage, { kind: 'loading', title: '正在准备', children: '请稍候' }),
    ),
  );
  for (const name of APPEARANCES) {
    await user.click(screen.getByRole('radio', { name }));
    expect(screen.getByRole('alert')).toHaveTextContent('无法读取');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  }
});
