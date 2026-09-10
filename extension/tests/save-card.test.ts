import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SaveCard } from '../panel/SaveCard';
import { SiteRulesStore } from '../persistence/site-rules';
import type { TreeSnapshot } from '../domain/node-reference';
const tree: TreeSnapshot = { installationId: 'i', epoch: 'e', observedRevision: 0, roots: ['root'], nodes: [
  { ref: { installationId: 'i', nativeId: 'root', kind: 'folder' }, title: '', index: 0, childrenIds: ['f'], readOnly: true, childrenWritable: false, observedRevision: 0 },
  { ref: { installationId: 'i', nativeId: 'f', kind: 'folder' }, parentId: 'root', title: 'Folder', index: 0, childrenIds: [], readOnly: false, childrenWritable: true, observedRevision: 0 },
] };
function store() { return new SiteRulesStore({ get: async () => ({}), set: async () => {}, setAccessLevel: async () => {} }, run => run()); }
it('deferred rule hydration preserves title and explicit consent; cancellation sends nothing', async () => {
  const rules = store(); let resolve!: (rules: []) => void; vi.spyOn(rules, 'load').mockReturnValue(new Promise(done => { resolve = done; }));
  const send = vi.fn(); const close = vi.fn();
  render(createElement(SaveCard, { page: { title: 'Original', url: 'https://example.test/' }, snapshot: tree, rulesStore: rules, onClose: close, send }));
  fireEvent.change(screen.getByLabelText('收藏标题'), { target: { value: 'Hand edited' } });
  fireEvent.click(screen.getByLabelText('以后此网站默认存到这里')); fireEvent.click(screen.getByLabelText('包含子域名'));
  resolve([]);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('手动'));
  expect(screen.getByLabelText('收藏标题')).toHaveValue('Hand edited'); expect(screen.getByLabelText('以后此网站默认存到这里')).toBeChecked(); expect(screen.getByLabelText('包含子域名')).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '取消收藏' })); expect(close).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
});
it('completed bookmark rule failure retries only rule storage, never mutation, with no default body capture', async () => {
  const rules = store(); const set = vi.spyOn(rules, 'set').mockRejectedValueOnce(Error('quota')).mockResolvedValueOnce();
  const send = vi.fn(async request => ({ requestId: request.requestId, status: 'completed', completedSteps: 1, remainingSteps: 0, needsReconcile: false })); const body = vi.fn();
  render(createElement(SaveCard, { page: { title: 'Original', url: 'https://example.test/' }, snapshot: tree, rulesStore: rules, onClose: vi.fn(), send, extractBody: body }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('手动'));
  fireEvent.change(screen.getByLabelText('收藏目标目录'), { target: { value: 'f' } }); fireEvent.click(screen.getByLabelText('以后此网站默认存到这里'));
  expect(send).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '确认收藏保存' }));
  fireEvent.click(await screen.findByRole('button', { name: '仅重试保存规则' }));
  await waitFor(() => expect(set).toHaveBeenCalledTimes(2)); expect(send).toHaveBeenCalledTimes(1); expect(body).not.toHaveBeenCalled();
});
it('unknown composite never reconciles automatically or writes rules and blocks repeat save', async () => {
  const rules = store(); const set = vi.spyOn(rules, 'set'); const reconcile = vi.fn();
  const send = vi.fn(async request => ({ requestId: request.requestId, status: 'unknown', completedSteps: 1, remainingSteps: 1, needsReconcile: true }));
  render(createElement(SaveCard, { page: { title: 'Original', url: 'https://example.test/' }, snapshot: tree, rulesStore: rules, onClose: vi.fn(), send, reconcile }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('手动'));
  fireEvent.change(screen.getByLabelText('收藏目标目录'), { target: { value: 'f' } }); fireEvent.click(screen.getByLabelText('明确创建新目录'));
  fireEvent.change(screen.getByLabelText('新目录名称'), { target: { value: 'Child' } }); fireEvent.click(screen.getByLabelText('以后此网站默认存到这里'));
  fireEvent.click(screen.getByRole('button', { name: '确认收藏保存' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('结果未知'));
  expect(set).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: '确认收藏保存' })).toBeDisabled();
});
it('cancel during pending rules initialization consumes automatic-request eligibility', async () => {
  const rules = store(); let resolve!: (rules: []) => void; vi.spyOn(rules, 'load').mockReturnValue(new Promise(done => { resolve = done; }));
  const fetch = vi.spyOn(globalThis, 'fetch');
  render(createElement(SaveCard, { page: { title: 'Original', url: 'https://example.test/' }, snapshot: tree, rulesStore: rules, onClose: vi.fn() }));
  fireEvent.click(screen.getByRole('button', { name: '取消AI请求' }));
  resolve([]); await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('可请求AI建议'));
  expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore();
});
it('retains edited SaveCard fields and unchecked consent across all four themes', async () => {
  const { ThemeProvider, ThemePicker } = await import('../ui/ThemeProvider');
  const send = vi.fn();
  render(createElement(ThemeProvider, null, createElement(ThemePicker), createElement(SaveCard, { page: { title: 'Original', url: 'https://example.test/' }, snapshot: tree, rulesStore: store(), onClose: vi.fn(), send })));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('手动'));
  fireEvent.change(screen.getByLabelText('收藏标题'), { target: { value: 'Edited' } });
  fireEvent.change(screen.getByLabelText('收藏目标目录'), { target: { value: 'f' } });
  for (const radio of screen.getAllByRole('radio')) { fireEvent.click(radio); expect(screen.getByLabelText('收藏标题')).toHaveValue('Edited'); expect(screen.getByLabelText('收藏目标目录')).toHaveValue('f'); expect(screen.getByLabelText('以后此网站默认存到这里')).not.toBeChecked(); }
  expect(send).not.toHaveBeenCalled();
});
