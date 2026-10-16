import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TokenUsage } from '../options/TokenUsage';
import { recordTokenUsage, TOKEN_USAGE_KEY } from '../persistence/token-usage';
import { LanguagePicker, LocaleProvider } from '../ui/i18n';
import { parseOptionsHash, OptionsNav } from '../ui/OptionsNav';
import { ThemeProvider } from '../ui/ThemeProvider';

afterEach(() => vi.unstubAllGlobals());
it('shows literal model names, missing/partial usage and local period totals without remounting on language change', async () => {
  let data: Record<string, unknown> = {};
  const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  const area = {
    get: async () => structuredClone(data),
    set: async (next: Record<string, unknown>) => {
      data = structuredClone(next);
    },
  };
  const at = Date.now();
  await recordTokenUsage(
    {
      id: 'one',
      at,
      adapter: 'anthropic',
      model: 'Token 统计',
      purpose: 'organize',
      counts: { input: 10, output: 20, total: 30 },
      complete: true,
    },
    area,
    op => op(),
  );
  await recordTokenUsage(
    {
      id: 'two',
      at: at - 10 * 86400000,
      adapter: 'openai-compatible',
      model: 'm',
      purpose: 'search',
      counts: {},
      complete: false,
    },
    area,
    op => op(),
  );
  await recordTokenUsage(
    {
      id: 'three',
      at,
      adapter: 'anthropic',
      model: 'Token 统计',
      purpose: 'organize',
      counts: { input: 5 },
      complete: false,
    },
    area,
    op => op(),
  );
  vi.stubGlobal('chrome', {
    storage: {
      local: area,
      onChanged: { addListener: (fn: never) => listeners.add(fn), removeListener: (fn: never) => listeners.delete(fn) },
    },
  });
  const view = render(
    <LocaleProvider>
      <LanguagePicker />
      <TokenUsage />
    </LocaleProvider>,
  );
  await screen.findByRole('table');
  const dashboard = screen.getByRole('region', { name: 'Token 统计' });
  expect(within(dashboard).getByText('1 次未提供用量')).toBeVisible();
  expect(within(dashboard).getByText('1 次用量不完整')).toBeVisible();
  expect(within(dashboard).getByRole('rowheader', { name: /Token 统计\s*anthropic/ })).toBeVisible();
  const totals = dashboard.querySelector('dl')!;
  expect(totals).toHaveTextContent('总Token30输入Token15输出Token20请求次数3');
  fireEvent.click(screen.getByRole('button', { name: '今日' }));
  expect(totals).toHaveTextContent('请求次数2');
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(screen.getByRole('region', { name: 'Token usage' })).toBe(dashboard);
  expect(within(dashboard).getByRole('rowheader', { name: /Token 统计\s*anthropic/ })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true');
  await recordTokenUsage(
    {
      id: 'four',
      at,
      adapter: 'ollama',
      model: 'local',
      purpose: 'connection-test',
      counts: { input: 0, output: 0, total: 0 },
      complete: true,
    },
    area,
    op => op(),
  );
  for (const fn of listeners) fn({ [TOKEN_USAGE_KEY]: { newValue: data[TOKEN_USAGE_KEY] } }, 'local');
  await waitFor(() => expect(within(dashboard).getByText('Connection test')).toBeVisible());
  expect(totals).toHaveTextContent('Requests3');
  view.unmount();
  expect(listeners.size).toBe(0);
});
it('adds the route under AI and keeps an unreadable ledger distinct from empty statistics', async () => {
  expect(parseOptionsHash('#token-usage')).toBe('token-usage');
  const navigate = vi.fn();
  render(
    <ThemeProvider>
      <OptionsNav route="token-usage" onRoute={navigate} />
    </ThemeProvider>,
  );
  const button = screen.getByRole('button', { name: 'Token 统计' });
  expect(button).toHaveAttribute('aria-current', 'page');
  fireEvent.click(button);
  expect(navigate).toHaveBeenCalledWith('token-usage');
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async () => {
          throw Error('storage');
        },
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  render(<TokenUsage />);
  await screen.findByRole('alert');
  expect(screen.queryByText('暂无调用记录')).not.toBeInTheDocument();
});
