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
  let emit!: (value: unknown) => void, notify!: (value: unknown) => void;
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
        onDisconnect: { addListener: () => {} },
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
