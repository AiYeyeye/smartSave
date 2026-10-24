import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CurrentPageSave } from '../panel/CurrentPageSave';

vi.mock('../panel/tree-client', () => ({
  connectTree: (_runtime: unknown, listener: (state: unknown) => void) => {
    listener({ status: 'ready', snapshot: { nodes: [], roots: [] } });
    return () => {};
  },
}));
vi.mock('../panel/SaveCard', () => ({
  SaveCard: ({ page, onClose }: { page: { title: string }; onClose: () => void }) => (
    <section aria-label="save">
      <h2>{page.title}</h2>
      <button onClick={onClose}>Close</button>
    </section>
  ),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function harness() {
  let emit!: (value: unknown) => void, notify!: (value: unknown) => void, lose!: () => void;
  const postMessage = vi.fn(),
    disconnect = vi.fn(),
    onActive = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: (fn: typeof notify) => {
          notify = fn;
        },
        removeListener: vi.fn(),
      },
      connect: () => ({
        postMessage,
        disconnect,
        onMessage: {
          addListener: (listener: typeof emit) => {
            emit = listener;
          },
        },
        onDisconnect: {
          addListener: (fn: () => void) => {
            lose = fn;
          },
        },
      }),
    },
    storage: { local: {} },
  });
  const view = render(<CurrentPageSave dialog onActive={onActive} />);
  const page = { tabId: 12, token: 'captured', title: 'Page', url: 'https://page.test/' };
  return {
    view,
    postMessage,
    disconnect,
    onActive,
    page,
    emit: (value: unknown) => act(() => emit(value)),
    notify: () => act(() => notify({ type: 'saveDialogUpdated' })),
    lose: () => act(() => lose()),
  };
}

it('registers without recapturing; displays the frozen source and removes it on invalidation', () => {
  const h = harness();
  expect(h.postMessage.mock.calls).toEqual([[{ type: 'register' }]]);
  h.emit({ type: 'page', page: h.page });
  expect(screen.getByRole('heading', { name: 'Page' })).toBeVisible();
  expect(h.onActive).toHaveBeenLastCalledWith(true);
  h.notify();
  expect(h.postMessage).toHaveBeenCalledOnce();
  h.emit({ type: 'invalidated' });
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  expect(h.onActive).toHaveBeenLastCalledWith(false);
  h.view.unmount();
  expect(h.disconnect).toHaveBeenCalledOnce();
});

it('an idle receipt popup stays quiet on disconnect and registers a new connection on a later save', () => {
  const h = harness();
  h.lose();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(h.onActive).toHaveBeenLastCalledWith(false);
  h.notify();
  expect(h.postMessage.mock.calls).toEqual([[{ type: 'register' }], [{ type: 'register' }]]);
  h.emit({ type: 'page', page: { ...h.page, token: 'new-explicit-save' } });
  expect(screen.getByRole('heading', { name: 'Page' })).toBeVisible();
});

it('a disconnected explicit capture is invalidated and never recaptured automatically', () => {
  const h = harness();
  h.emit({ type: 'page', page: h.page });
  h.lose();
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('收藏入口连接已关闭');
  h.notify();
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  expect(h.postMessage.mock.calls.every(([message]) => message.type === 'register')).toBe(true);
  h.view.unmount();
  h.lose();
  expect(h.disconnect).toHaveBeenCalledOnce();
});

it('closes the capture and accepts a later explicit save without a trial mode', () => {
  const h = harness();
  h.emit({ type: 'page', page: h.page });
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(h.postMessage).toHaveBeenLastCalledWith({ type: 'close' });
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  h.notify();
  expect(h.postMessage).toHaveBeenLastCalledWith({ type: 'register' });
  h.emit({ type: 'page', page: { ...h.page, token: 'next-save', title: 'Next page' } });
  expect(screen.getByRole('heading', { name: 'Next page' })).toBeVisible();
});
