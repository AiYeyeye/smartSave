import { createElement } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { SaveReceiptCard } from '../panel/SaveReceiptCard';
import { SAVE_RECEIPTS_KEY, type SaveReceipt } from '../persistence/save-receipts';
import {
  createDebugLog,
  DEBUG_SETTINGS_KEY,
  DEBUG_TRAIL_KEY,
  resetDebugLogForTests,
  type DebugEntry,
} from '../domain/debug-log';

function stubStorage(initial: Record<string, unknown>, sendMessage = vi.fn()) {
  const data: Record<string, unknown> = { ...initial };
  const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  vi.stubGlobal('chrome', {
    runtime: { sendMessage, lastError: undefined },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: data[key] }),
        set: async (patch: Record<string, unknown>) => {
          Object.assign(data, patch);
          const changes = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { newValue: v }]));
          listeners.forEach(listener => listener(changes, 'local'));
        },
      },
      onChanged: {
        addListener: (fn: never) => listeners.add(fn),
        removeListener: (fn: never) => listeners.delete(fn),
      },
    },
  });
  return data;
}

const base: SaveReceipt = {
  id: 'r1',
  bookmarkId: 'b1',
  title: 'Vite 文档',
  url: 'https://vite.dev/',
  at: Date.now(),
  status: 'skipped',
  reason: 'save-feature-unconfigured',
  fromParentId: '1',
  fromIndex: 0,
  fromPath: '书签栏',
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetDebugLogForTests();
});

it('says plainly when a native save did not call AI and links to the model assignment', async () => {
  stubStorage({ [SAVE_RECEIPTS_KEY]: [base] });
  const open = vi.fn();
  const user = userEvent.setup();
  render(createElement(SaveReceiptCard, { onOpen: open }));
  expect(await screen.findByText('收藏成功，但没有调用 AI')).toBeVisible();
  expect(screen.getByText('还没给「智能收藏」选择模型，未调用 AI')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '给「智能收藏」选模型' }));
  expect(open).toHaveBeenCalledWith('ai-services/features');
});

it('shows where AI put the bookmark and undoes through the worker', async () => {
  const send = vi.fn((_message: unknown, reply: (response: unknown) => void) => reply({ status: 'undone' }));
  stubStorage(
    {
      [SAVE_RECEIPTS_KEY]: [
        {
          ...base,
          status: 'moved',
          reason: undefined,
          toId: '9',
          toPath: '书签栏 / 开发',
          model: 'gpt-4o-mini · OpenRouter',
        },
      ],
    },
    send,
  );
  const user = userEvent.setup();
  render(createElement(SaveReceiptCard, { onOpen: vi.fn() }));
  expect(await screen.findByText('已自动归类')).toBeVisible();
  expect(screen.getByText('书签栏 / 开发')).toBeVisible();
  expect(screen.getByText(/gpt-4o-mini · OpenRouter/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: '撤销' }));
  expect(send).toHaveBeenCalledWith({ type: 'nativeSaveUndo', receiptId: 'r1' }, expect.any(Function));
});

it('dismissal hides the card and is remembered for that receipt', async () => {
  const data = stubStorage({ [SAVE_RECEIPTS_KEY]: [{ ...base, status: 'moved', toPath: '开发' }] });
  const user = userEvent.setup();
  render(createElement(SaveReceiptCard, { onOpen: vi.fn() }));
  await user.click(await screen.findByRole('button', { name: '关闭提示' }));
  expect(screen.queryByText('已自动归类')).toBeNull();
  await waitFor(() => expect(data.nativeSaveReceiptSeen).toBe('r1'));
});

it('debug trail stays empty by default and records sanitized entries once enabled', async () => {
  vi.useFakeTimers();
  const data = stubStorage({});
  const log = createDebugLog('test');
  log('call-start', { host: 'api.test', apiKey: 'sk-secret' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(data[DEBUG_TRAIL_KEY]).toBeUndefined();

  resetDebugLogForTests();
  data[DEBUG_SETTINGS_KEY] = { enabled: true };
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  log('call-start', { host: 'api.test', apiKey: 'sk-secret', status: 'completed' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  const trail = data[DEBUG_TRAIL_KEY] as DebugEntry[];
  expect(trail).toHaveLength(1);
  expect(trail[0]).toMatchObject({
    src: 'test',
    event: 'call-start',
    detail: { host: 'api.test', status: 'completed' },
  });
  expect(JSON.stringify(trail)).not.toContain('sk-secret');
  debug.mockRestore();
  vi.useRealTimers();
});
