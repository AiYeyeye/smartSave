import { useRef } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NavigationMemory, navigationKey, readPosition, type NavigationPosition } from '../panel/navigation-memory';
import { useNavigationMemory } from '../panel/use-navigation-memory';
import { searchTree } from './fixtures/search-tree';

const snapshot = searchTree(100);
const position: NavigationPosition = {
  version: 1,
  installationId: 'test',
  anchor: '12',
  fallback: ['0', '11'],
  offset: -10,
  scrollTop: 450,
  at: 1,
};
function fixture() {
  const data: Record<string, unknown> = { [navigationKey('test')]: position };
  const get = vi.fn(async (key: string) => ({ [key]: data[key] }));
  const set = vi.fn(async (next: Record<string, unknown>) => {
    Object.assign(data, next);
  });
  vi.stubGlobal('chrome', { storage: { local: { get, set } } });
  return { data, get, set };
}
function Directory({
  ready = true,
  active = true,
  missing = '',
}: {
  ready?: boolean;
  active?: boolean;
  missing?: string;
}) {
  const list = useRef<HTMLUListElement>(null);
  useNavigationMemory(list, snapshot, active, ready);
  return (
    <div className="shell panel">
      <button>Settings</button>
      <main>
        <section hidden={!active}>
          <ul ref={list}>
            {snapshot.nodes
              .filter(node => node.ref.nativeId !== missing)
              .map(node => (
                <li key={node.ref.nativeId} data-node-id={node.ref.nativeId}>
                  <button>{node.title}</button>
                </li>
              ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
function layout(container: HTMLElement) {
  const host = container.querySelector('main')!;
  Object.defineProperties(host, { clientHeight: { value: 400 }, scrollHeight: { value: 3200 } });
  host.getBoundingClientRect = () => ({ top: 100, bottom: 500 }) as DOMRect;
  container.querySelectorAll<HTMLElement>('li').forEach(row => {
    row.getBoundingClientRect = () =>
      ({
        top: 180 + Number(row.dataset.nodeId) * 30 - host.scrollTop,
        bottom: 210 + Number(row.dataset.nodeId) * 30 - host.scrollTop,
      }) as DOMRect;
  });
  return host;
}
afterEach(() => vi.unstubAllGlobals());

it('waits for expansion, restores the anchor and never writes the initial zero or its own restore', async () => {
  const store = fixture();
  const view = render(<Directory ready={false} />);
  const host = layout(view.container);
  await waitFor(() => expect(store.get).toHaveBeenCalled());
  expect(host.scrollTop).toBe(0);
  expect(store.set).not.toHaveBeenCalled();
  view.rerender(<Directory />);
  await waitFor(() => expect(host.scrollTop).toBe(450));
  fireEvent.scroll(host);
  fireEvent(window, new Event('pagehide'));
  expect(store.set).not.toHaveBeenCalled();
  host.scrollTop = 755;
  fireEvent.scroll(host);
  await waitFor(() => expect(store.set).toHaveBeenCalledOnce());
  expect(readPosition(store.data[navigationKey('test')], 'test')).toMatchObject({
    anchor: '22',
    offset: -15,
    scrollTop: 755,
  });
});

it('user scrolling wins over a late initial read', async () => {
  const store = fixture();
  let finish!: (data: Record<string, unknown>) => void;
  store.get.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const view = render(<Directory />);
  const host = layout(view.container);
  await waitFor(() => expect(store.get).toHaveBeenCalled());
  fireEvent.wheel(host);
  host.scrollTop = 820;
  fireEvent.scroll(host);
  await act(async () => finish({ [navigationKey('test')]: position }));
  await waitFor(() => expect(store.set).toHaveBeenCalled());
  expect(host.scrollTop).toBe(820);
  expect(readPosition(store.data[navigationKey('test')], 'test')?.scrollTop).toBe(820);
});

it('snapshots before leaving the directory and restores it on return instead of saving hidden zero', async () => {
  const store = fixture();
  const view = render(<Directory />);
  const host = layout(view.container);
  await waitFor(() => expect(host.scrollTop).toBe(450));
  host.scrollTop = 910;
  fireEvent.click(view.getByText('Settings'));
  view.rerender(<Directory active={false} />);
  host.scrollTop = 0;
  fireEvent.scroll(host);
  await waitFor(() => expect(readPosition(store.data[navigationKey('test')], 'test')?.scrollTop).toBe(910));
  view.rerender(<Directory />);
  await waitFor(() => expect(host.scrollTop).toBe(910));
});

it('falls back to a visible ancestor when the anchor was deleted; foreign installation state is ignored', async () => {
  fixture();
  const view = render(<Directory missing="12" />);
  const host = layout(view.container);
  await waitFor(() => expect(host.scrollTop).toBe(90));
  expect(readPosition(position, 'another-installation')).toBeUndefined();
  expect(readPosition({ ...position, scrollTop: Infinity }, 'test')).toBeUndefined();
  expect(readPosition({ ...position, url: 'https://private.invalid' }, 'test')).toBeUndefined();
});

it('does not overwrite unreadable storage and keeps local browsing usable', async () => {
  const store = fixture();
  store.get.mockRejectedValue(Error('unavailable'));
  const view = render(<Directory />);
  const host = layout(view.container);
  await waitFor(() => expect(store.get).toHaveBeenCalled());
  await act(async () => new Promise(resolve => setTimeout(resolve, 25)));
  host.scrollTop = 600;
  fireEvent.wheel(host);
  fireEvent.scroll(host);
  expect(host.scrollTop).toBe(600);
  expect(store.set).not.toHaveBeenCalled();
});

it('serializes writes and discards an older visit without notifying other panels to scroll', async () => {
  const store = fixture();
  const memory = new NavigationMemory(store as unknown as typeof chrome.storage.local);
  await Promise.all([memory.save({ ...position, at: 20, scrollTop: 800 }), memory.save({ ...position, at: 10 })]);
  expect(store.set).toHaveBeenCalledOnce();
  expect((await memory.load('test'))?.scrollTop).toBe(800);
});
