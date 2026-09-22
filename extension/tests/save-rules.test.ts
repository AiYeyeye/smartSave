import { expect, it, vi } from 'vitest';
import { matchSiteRule, ruleFolder, type SiteRule } from '../domain/site-rules';
import { SiteRulesStore } from '../persistence/site-rules';
import type { TreeSnapshot } from '../domain/node-reference';
const rule = (host: string, includeSubdomains = false): SiteRule => ({
  host,
  includeSubdomains,
  folder: { installationId: 'i', nativeId: 'f', kind: 'folder' },
});
it('matches precise hosts and closest ancestor, never sibling or suffix lookalikes', () => {
  expect(matchSiteRule('https://docs.example.test/', [rule('example.test')])).toBeUndefined();
  const rules = [rule('test', true), rule('example.test', true), rule('docs.example.test')];
  expect(matchSiteRule('https://docs.example.test/', rules)?.host).toBe('docs.example.test');
  expect(matchSiteRule('https://deep.docs.example.test/', rules)?.host).toBe('example.test');
  expect(matchSiteRule('https://evil-example.test/', [rule('example.test', true)])).toBeUndefined();
});
it('follows identity, not folder path, and refuses deleted or other-installation targets', () => {
  const folder = {
    ref: rule('example.test').folder,
    title: 'Renamed',
    index: 0,
    childrenIds: [],
    readOnly: false,
    childrenWritable: true,
    observedRevision: 0,
  };
  const tree: TreeSnapshot = { installationId: 'i', epoch: 'e', observedRevision: 0, roots: ['f'], nodes: [folder] };
  expect(ruleFolder(rule('example.test'), tree)).toBe(folder);
  expect(
    ruleFolder(rule('example.test'), {
      ...tree,
      nodes: [{ ...folder, ref: { ...folder.ref, nativeId: 'replacement' } }],
    }),
  ).toBeUndefined();
  expect(
    ruleFolder(rule('example.test'), {
      ...tree,
      nodes: [{ ...folder, ref: { ...folder.ref, installationId: 'other' } }],
    }),
  ).toBeUndefined();
});
it('persists only explicit rule fields and preserves unknown schema on rejection', async () => {
  const data: Record<string, unknown> = {};
  const set = vi.fn(async (value: Record<string, unknown>) => {
    Object.assign(data, value);
  });
  const store = new SiteRulesStore(
    { get: async key => ({ [key]: data[key] }), set, setAccessLevel: async () => {} },
    run => run(),
  );
  expect(await store.load()).toEqual([]);
  expect(set).not.toHaveBeenCalled();
  await store.set(rule('example.test'));
  expect(await store.load()).toEqual([rule('example.test')]);
  await store.remove('example.test');
  expect(await store.load()).toEqual([]);
  data.siteRules = { version: 99, rules: [] };
  set.mockClear();
  await expect(store.set(rule('example.test'))).rejects.toThrow();
  expect(set).not.toHaveBeenCalled();
});
