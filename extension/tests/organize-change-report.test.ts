import { expect, it } from 'vitest';
import { organizeChangeSummary, organizeChanges } from '../domain/organize-change-report';
import { organizerTree } from './fixtures/organizer-tree';

it('names each change in the user’s terms', () => {
  const before = organizerTree();
  const after = organizerTree();
  after.nodes.find(n => n.ref.nativeId === 'right')!.title = '学习';
  after.nodes.find(n => n.ref.nativeId === 'a')!.parentId = 'right';
  after.nodes = after.nodes.filter(n => n.ref.nativeId !== 'b');
  after.nodes.find(n => n.ref.nativeId === 'left')!.parentId = 'outside';
  expect(organizeChanges(before, after, 'bar')).toEqual([
    '目录「left」被移出了整理范围',
    '目录「right」被改名为「学习」',
    '书签「a」被移到了「学习」',
    '书签「b」被删除',
  ]);
});

it('only reports bookmarks that belong to the run, and summarises long lists', () => {
  const before = organizerTree();
  const after = organizerTree();
  after.nodes.find(n => n.ref.nativeId === 'a')!.parentId = 'right';
  after.nodes.find(n => n.ref.nativeId === 'b')!.title = 'renamed';
  expect(organizeChanges(before, after, 'bar', [])).toEqual([]);
  expect(organizeChanges(before, after, 'bar', ['a'])).toEqual(['书签「a」被移到了「right」']);
  expect(organizeChangeSummary(['一', '二', '三', '四', '五'])).toBe('一；二；三；等 5 处改动');
});
