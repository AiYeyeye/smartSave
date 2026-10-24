import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { initializeOnboarding, ONBOARDING_KEY } from '../persistence/onboarding';
import { OnboardingSteps } from '../panel/OnboardingSteps';
import { useOnboarding } from '../panel/use-onboarding';
import { LanguagePicker, LocaleProvider } from '../ui/i18n';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function storage(value?: unknown) {
  const data: Record<string, unknown> = { [ONBOARDING_KEY]: value };
  const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  const local = {
    get: vi.fn(async () => ({ ...data })),
    set: vi.fn(async (update: Record<string, unknown>) => {
      Object.assign(data, update);
      listeners.forEach(listener => listener({ [ONBOARDING_KEY]: { newValue: data[ONBOARDING_KEY] } }, 'local'));
    }),
  };
  vi.stubGlobal('chrome', {
    storage: {
      local,
      onChanged: {
        addListener: (listener: Parameters<typeof listeners.add>[0]) => listeners.add(listener),
        removeListener: (listener: Parameters<typeof listeners.add>[0]) => listeners.delete(listener),
      },
    },
  });
  return { local, data };
}

function Guide({ configure = vi.fn(), search = vi.fn(), organize = vi.fn() }) {
  const state = useOnboarding();
  return (
    <LocaleProvider>
      <LanguagePicker />
      <button onClick={state.show}>Reopen</button>
      {state.visible && (
        <OnboardingSteps onConfigure={configure} onSearch={search} onOrganize={organize} onDismiss={state.dismiss} />
      )}
      {state.saveFailed && <p role="status">Could not save dismissal</p>}
      <p>Bookmarks stay available</p>
    </LocaleProvider>
  );
}

it('marks only a fresh install pending; updates and browser restarts preserve completion', async () => {
  const h = storage();
  await initializeOnboarding('install', h.local);
  expect(h.data[ONBOARDING_KEY]).toEqual({ version: 1, pending: true });
  await h.local.set({ [ONBOARDING_KEY]: { version: 1, pending: false } });
  await initializeOnboarding('update', h.local);
  await initializeOnboarding('chrome_update', h.local);
  expect(h.data[ONBOARDING_KEY]).toEqual({ version: 1, pending: false });
  expect(h.local.set).toHaveBeenCalledTimes(2);
});

it('shows on first install, remembers dismissal across remounts and allows reopening', async () => {
  const h = storage({ version: 1, pending: true });
  const view = render(<Guide />);
  await screen.findByRole('heading', { name: '开始使用智栏' });
  expect(within(screen.getByRole('list', { name: '新手操作步骤' })).getAllByRole('listitem')).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: '知道了，开始使用' }));
  await waitFor(() => expect(h.data[ONBOARDING_KEY]).toEqual({ version: 1, pending: false }));
  view.unmount();
  render(<Guide />);
  await act(async () => {});
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
  expect(screen.getByRole('heading', { name: '开始使用智栏' })).toBeVisible();
});

it.each([undefined, { version: 2, pending: true }, { version: 1, pending: 'yes' }])(
  'does not treat missing or invalid state as first install: %j',
  async value => {
    storage(value);
    render(<Guide />);
    await act(async () => {});
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(screen.getByRole('list')).toBeVisible();
  },
);

it('keeps manual dismissal ahead of a late initial read', async () => {
  const h = storage();
  let resolve!: (value: Record<string, unknown>) => void;
  h.local.get.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  render(<Guide />);
  fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
  fireEvent.click(screen.getByRole('button', { name: '知道了，开始使用' }));
  await act(async () => resolve({ [ONBOARDING_KEY]: { version: 1, pending: true } }));
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
});

it('does not block browsing on storage errors and allows manual reopening', async () => {
  const h = storage({ version: 1, pending: true });
  h.local.set.mockRejectedValueOnce(Error('quota'));
  render(<Guide />);
  fireEvent.click(await screen.findByRole('button', { name: '知道了，开始使用' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Could not save');
  expect(screen.getByText('Bookmarks stay available')).toBeVisible();
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
  expect(screen.getByRole('list')).toBeVisible();
});

it('localizes the same guide, routes only explicit clicks, and never requests a page or model', async () => {
  const h = storage({ version: 1, pending: true });
  const configure = vi.fn(),
    search = vi.fn(),
    organize = vi.fn(),
    fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<Guide configure={configure} search={search} organize={organize} />);
  const list = await screen.findByRole('list', { name: '新手操作步骤' });
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(screen.getByRole('list', { name: 'Getting started' })).toBe(list);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(configure).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Set up AI' }));
  fireEvent.click(screen.getByRole('button', { name: 'Go to search' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open organizer' }));
  expect(configure).toHaveBeenCalledOnce();
  expect(search).toHaveBeenCalledOnce();
  expect(organize).toHaveBeenCalledOnce();
  expect(fetcher).not.toHaveBeenCalled();
  expect(h.data[ONBOARDING_KEY]).toEqual({ version: 1, pending: true });
});
