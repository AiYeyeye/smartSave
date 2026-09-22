import { describe, expect, it } from 'vitest';
import { parseModelOutput } from '../schemas/model-output';
const context = { task: 'organize', items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], folders: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
describe('organizer model output source identity', () => {
  it('rejects overlap before a merge edge can overwrite a move edge and hide its cycle', () => {
    expect(() => parseModelOutput({ newFolders: [], moves: [{ itemId: 'a', folderId: 'b' }, { itemId: 'b', folderId: 'a' }], merges: [{ sourceId: 'a', targetId: 'c' }] }, context)).toThrow('invalid-output');
  });
  it('rejects even acyclic move/merge overlap', () => {
    expect(() => parseModelOutput({ newFolders: [], moves: [{ itemId: 'a', folderId: 'b' }], merges: [{ sourceId: 'a', targetId: 'c' }] }, context)).toThrow('invalid-output');
  });
  it.each([
    { moves: [{ itemId: 'a', folderId: 'b' }, { itemId: 'a', folderId: 'c' }], merges: [] },
    { moves: [], merges: [{ sourceId: 'a', targetId: 'b' }, { sourceId: 'a', targetId: 'c' }] },
    { moves: [{ itemId: 'a', folderId: 'missing' }], merges: [] },
    { moves: [{ itemId: 'a', folderId: 'b' }], merges: [{ sourceId: 'b', targetId: 'a' }] },
  ])('rejects duplicate, unknown and cyclic references %#', actions => {
    expect(() => parseModelOutput({ newFolders: [], ...actions }, context)).toThrow('invalid-output');
  });
  it('accepts distinct acyclic sources', () => {
    const output = { newFolders: [], moves: [{ itemId: 'a', folderId: 'c' }], merges: [{ sourceId: 'b', targetId: 'c' }] };
    expect(parseModelOutput(output, context)).toEqual(output);
  });
  it('caps new folder chains below the scope root only when the caller supplies policy and root', () => {
    const scoped = { task: 'organize', items: [{ id: 'a', title: 'A' }], folders: [{ id: 'bar', ancestorIds: [] }, { id: 'left', ancestorIds: ['bar'] }] };
    const policy = { ...scoped, rootId: 'bar', policy: { maxNewDepth: 2, allowRename: false } };
    const output = (parentId: string) => ({ newFolders: [{ id: 'n1', parentId, title: 'One' }, { id: 'n2', parentId: 'n1', title: 'Two' }], moves: [{ itemId: 'a', folderId: 'n2' }], merges: [] });
    expect(parseModelOutput(output('bar'), policy)).toEqual(output('bar'));
    expect(() => parseModelOutput(output('left'), policy)).toThrow('invalid-output');
    expect(parseModelOutput(output('left'), scoped)).toEqual(output('left'));
  });
});
