import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SiteRulesSettings } from '../options/SiteRulesSettings';
import { SiteRulesStore } from '../persistence/site-rules';
it('invalid rule never adopts a same-title replacement; edit requires explicit selection and confirmation', async () => {
  const data: Record<string, unknown> = { siteRules: { version: 1, rules: [{ host: 'example.test', includeSubdomains: false, folder: { installationId: 'i', nativeId: 'deleted', kind: 'folder' } }] } };
  const set = vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, value); });
  const store = new SiteRulesStore({ get: async key => ({ [key]: data[key] }), set, setAccessLevel: async () => {} }, run => run());
  render(createElement(SiteRulesSettings, { store, tree: { status: 'ready', snapshot: { installationId: 'i', epoch: 'e', observedRevision: 0, roots: ['replacement'], nodes: [{ ref: { installationId: 'i', nativeId: 'replacement', kind: 'folder' }, title: 'Same title', index: 0, childrenIds: [], readOnly: false, childrenWritable: true, observedRevision: 0 }] } } }));
  fireEvent.click(await screen.findByRole('button', { name: '修改 example.test' }));
  expect(screen.getByLabelText('规则目标目录')).toHaveValue('');
  expect(screen.getByRole('button', { name: '确认修改规则' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('规则目标目录'), { target: { value: 'replacement' } });
  expect(set).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认修改规则' }));
  await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
  expect((await store.load())[0]?.folder.nativeId).toBe('replacement');
});
