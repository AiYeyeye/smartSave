import { expect, it } from 'vitest';
import { searchScope, searchFolderOptions } from '../domain/search-scope';
import { serializeAiPayload, type AiRequest } from '../domain/ai-payload';
import { dependencyDigest } from '../domain/context-dependencies';
import { searchFolders } from './fixtures/search-folders';

it('includes readable protected folders and descendants, with native ordered path labels', () => {
  const tree = searchFolders();
  const early = tree.nodes.find(node => node.ref.nativeId === 'early')!;
  const useful = tree.nodes.find(node => node.ref.nativeId === 'useful')!;
  useful.parentId = 'early';
  early.childrenIds.push('useful');
  tree.nodes[0]!.childrenIds = tree.nodes[0]!.childrenIds.filter(id => id !== 'useful');
  tree.nodes[0]!.title = '';
  const scoped = searchScope(tree, early.ref);
  expect(scoped.ids.has('1')).toBe(true);
  expect(scoped.ids.has('160')).toBe(true);
  expect(scoped.ids.has('161')).toBe(false);
  expect(scoped.ancestorIds).toEqual(new Set(['0']));
  expect(searchFolderOptions(tree, 'Root').map(option => option.label)).toEqual([
    'early',
    'early / useful',
    'misc',
    'private',
  ]);
});

it.each(['missing', 'foreign', 'bookmark', 'cycle', 'missing-parent'] as const)('fails closed for %s scope', kind => {
  const tree = searchFolders();
  const scope = { ...tree.nodes.find(node => node.ref.nativeId === 'early')!.ref };
  if (kind === 'missing') scope.nativeId = 'missing';
  if (kind === 'foreign') scope.installationId = 'foreign';
  if (kind === 'bookmark') scope.nativeId = '1';
  if (kind === 'cycle') tree.nodes[0]!.parentId = 'early';
  if (kind === 'missing-parent') tree.nodes[0]!.parentId = 'missing';
  expect(() => searchScope(tree, scope)).toThrow('invalid-search-folder');
});

it.each(['search-plan', 'search-batch'] as const)(
  'enforces the %s sending boundary and binds empty-scope identity',
  task => {
    const tree = searchFolders();
    const scope = tree.nodes.find(node => node.ref.nativeId === 'early')!.ref;
    const privacy = { fullUrl: false, bodyEnabled: false, excludedFolders: [] };
    const request = {
      task,
      query: 'tools',
      folderScope: scope,
      itemIds: ['1'],
      folderIds: ['early'],
    } satisfies AiRequest;
    expect(serializeAiPayload(tree, privacy, request)).toContain('重庆大学');
    expect(() => serializeAiPayload(tree, privacy, { ...request, itemIds: ['81'] })).toThrow('outside-scope');
    expect(() => serializeAiPayload(tree, privacy, { ...request, folderIds: ['useful'] })).toThrow('outside-scope');
    const empty = { ...request, itemIds: [], folderIds: [] };
    const digest = dependencyDigest(tree, empty);
    tree.nodes.find(node => node.ref.nativeId === 'early')!.title = 'renamed';
    expect(dependencyDigest(tree, empty)).not.toBe(digest);
    expect(() =>
      serializeAiPayload(tree, privacy, { ...empty, folderScope: { ...scope, installationId: 'other' } }),
    ).toThrow('invalid-search-folder');
  },
);
