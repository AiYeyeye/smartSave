import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CurrentPageSave } from '../panel/CurrentPageSave';

vi.mock('../panel/tree-client', () => ({
  connectTree: (_runtime: unknown, listener: (state: unknown) => void) => {
    listener({ status: 'ready', snapshot: { nodes: [], roots: [] } });
    return () => {};
  },
}));
vi.mock('../panel/SaveCard', () => ({
  SaveCard: ({ readOnlyTrial, onClose }: { readOnlyTrial: boolean; onClose: () => void }) => (
    <section aria-label={readOnlyTrial ? 'trial' : 'save'}>
      <button onClick={onClose}>Close</button>
    </section>
  ),
}));
afterEach(() => vi.unstubAllGlobals());

function harness() {
  let emit!: (value: unknown) => void;
  const postMessage = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: {
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
  const view = render(<CurrentPageSave />);
  const page = { tabId: 12, token: 'captured', title: 'Page', url: 'https://page.test/' };
  return { view, postMessage, page, emit: (value: unknown) => act(() => emit(value)) };
}

it('captures only after an explicit trial request, keeps the card read-only and removes it on navigation', () => {
  const h = harness();
  expect(h.postMessage.mock.calls).toEqual([[{ type: 'register' }]]);
  h.view.rerender(<CurrentPageSave trialNonce={1} />);
  expect(h.postMessage).toHaveBeenLastCalledWith({ type: 'capture' });
  h.emit({ type: 'page', page: h.page });
  expect(screen.getByRole('region', { name: 'trial' })).toBeVisible();
  h.emit({ type: 'invalidated' });
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  expect(h.postMessage).toHaveBeenCalledTimes(2);
  h.view.unmount();
});

it('preserves an existing save draft, then allows a trial after it is closed', () => {
  const h = harness();
  h.emit({ type: 'page', page: h.page });
  h.view.rerender(<CurrentPageSave trialNonce={1} />);
  expect(screen.getByRole('region', { name: 'save' })).toBeVisible();
  expect(h.postMessage).toHaveBeenCalledOnce();
  expect(screen.getByRole('status')).toHaveTextContent('请先关闭当前卡片');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  h.view.rerender(<CurrentPageSave trialNonce={2} />);
  h.emit({ type: 'page', page: { ...h.page, token: 'trial' } });
  expect(screen.getByRole('region', { name: 'trial' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  h.emit({ type: 'page', page: { ...h.page, token: 'save-again' } });
  expect(screen.getByRole('region', { name: 'save' })).toBeVisible();
  h.view.unmount();
});
