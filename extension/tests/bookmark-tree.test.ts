import { createElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { TreeRows } from '../panel/BookmarkTree';
import { ThemePicker, ThemeProvider } from '../ui/ThemeProvider';
import type { TreeSnapshot } from '../domain/node-reference';
const snapshot: TreeSnapshot = { installationId: 'i', epoch: 'e', observedRevision: 0, roots: ['r'], nodes: [
  { ref: { installationId: 'i', nativeId: 'r', kind: 'folder' }, index: 0, title: 'Root', childrenIds: ['b'], readOnly: true, observedRevision: 0 },
  { ref: { installationId: 'i', nativeId: 'b', kind: 'bookmark' }, parentId: 'r', index: 0, title: '<script>unsafe</script>', url: 'javascript:alert(1)', childrenIds: [], readOnly: false, observedRevision: 0 },
] };
it('renders native titles and URLs only as text, retains expansion across themes and reopening', async () => {
  const values: Record<string, unknown> = {};
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ ...values }), set: async (patch: Record<string, unknown>) => { Object.assign(values, patch); } }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
  const user = userEvent.setup();
  const first = render(createElement(ThemeProvider, null, createElement(ThemePicker), createElement(TreeRows, { snapshot })));
  await user.click(screen.getByRole('button', { name: 'Root只读' }));
  for (const name of ['轻盈原生', '温润纸感', '清爽文具（默认）', '深色精密']) {
    await user.click(screen.getByRole('radio', { name }));
    expect(screen.getByText('javascript:alert(1)')).toBeVisible();
    expect(screen.getByText('<script>unsafe</script>')).toBeVisible();
  }
  expect(first.container.querySelector('script')).toBeNull(); expect(screen.queryByRole('link')).toBeNull();
  first.unmount(); const second = render(createElement(TreeRows, { snapshot }));
  expect(await screen.findByText('javascript:alert(1)')).toBeVisible();
  second.unmount(); vi.unstubAllGlobals();
});
it('records a synthetic 5000-bookmark expanded DOM baseline, not a browser performance gate', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ 'tree.expanded.i.r': true }) }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
  const nodes = Array.from({ length: 5000 }, (_, index) => ({ ...snapshot.nodes[1]!, ref: { installationId: 'i', nativeId: String(index), kind: 'bookmark' as const }, title: `Sample ${index}`, url: `https://example.test/${index}`, index }));
  const large = { ...snapshot, nodes: [{ ...snapshot.nodes[0]!, childrenIds: nodes.map(n => n.ref.nativeId) }, ...nodes] };
  const start = performance.now();
  const view = render(createElement(TreeRows, { snapshot: large }));
  await waitFor(() => expect(view.container.querySelectorAll('.bookmark-row')).toHaveLength(5001), { timeout: 20000 });
  console.info(`BASELINE jsdom React render + storage expansion + 5000 bookmark DOM rows: ${(performance.now() - start).toFixed(1)}ms; no pass threshold; ${navigator.userAgent}`);
  view.unmount(); vi.unstubAllGlobals();
}, 30000);

it('loads only explicit expansion keys, never the model secret envelope', async () => {
  const get = vi.fn(async (keys: string[]) => { expect(keys).toEqual(['tree.expanded.i.r', 'tree.expanded.i.b']); return {}; });
  vi.stubGlobal('chrome', { storage: { local: { get }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
  const view = render(createElement(TreeRows, { snapshot }));
  await waitFor(() => expect(get).toHaveBeenCalledOnce()); view.unmount(); vi.unstubAllGlobals();
});
