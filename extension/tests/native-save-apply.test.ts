import { expect, it } from 'vitest';
import { planNativeSaveApply } from '../domain/native-save-apply';
import type { TreeSnapshot } from '../domain/node-reference';

const tree: TreeSnapshot = {
  installationId: 'i',
  epoch: 'e',
  observedRevision: 0,
  roots: ['root'],
  nodes: [
    {
      ref: { installationId: 'i', nativeId: 'root', kind: 'folder' },
      title: '',
      index: 0,
      childrenIds: ['bar', 'other'],
      readOnly: true,
      childrenWritable: false,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'i', nativeId: 'bar', kind: 'folder' },
      parentId: 'root',
      title: 'Bar',
      index: 0,
      childrenIds: ['b1'],
      readOnly: false,
      childrenWritable: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'i', nativeId: 'other', kind: 'folder' },
      parentId: 'root',
      title: 'Other',
      index: 1,
      childrenIds: [],
      readOnly: false,
      childrenWritable: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'i', nativeId: 'b1', kind: 'bookmark' },
      parentId: 'bar',
      title: 'Page',
      url: 'https://page.test/',
      index: 0,
      childrenIds: [],
      readOnly: false,
      observedRevision: 0,
    },
  ],
};

it('noops when the bookmark already sits in the suggested existing folder', () => {
  expect(planNativeSaveApply(tree, 'b1', 'bar', [])).toEqual({ status: 'noop', reason: 'already-there' });
});

it('plans a move into another existing writable folder', () => {
  expect(planNativeSaveApply(tree, 'b1', 'other', [])).toMatchObject({
    status: 'apply',
    anchorParentId: 'other',
    createTitles: [],
    destinationFolderId: 'other',
    bookmarkId: 'b1',
  });
});

it('plans create chain then move for newFolders suggestions', () => {
  expect(
    planNativeSaveApply(tree, 'b1', 'new-leaf', [
      { id: 'new-mid', parentId: 'other', title: 'Tech' },
      { id: 'new-leaf', parentId: 'new-mid', title: 'JS' },
    ]),
  ).toMatchObject({
    status: 'apply',
    anchorParentId: 'other',
    createTitles: ['Tech', 'JS'],
    destinationFolderId: 'new-leaf',
    bookmarkId: 'b1',
  });
});

it('rejects colliding or cyclic new folder ids', () => {
  expect(planNativeSaveApply(tree, 'b1', 'bar', [{ id: 'bar', parentId: 'other', title: 'X' }]).status).toBe('invalid');
  expect(
    planNativeSaveApply(tree, 'b1', 'a', [
      { id: 'a', parentId: 'b', title: 'A' },
      { id: 'b', parentId: 'a', title: 'B' },
    ]).status,
  ).toBe('invalid');
});
