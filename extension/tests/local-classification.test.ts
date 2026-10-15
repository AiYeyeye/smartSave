import { expect, it } from 'vitest';
import { localClassification } from '../domain/local-classification';
import { organizerTree } from './fixtures/organizer-tree';
const privacy = { fullUrl: false, bodyEnabled: false, excludedFolders: [] };

function fixture() {
  const tree = organizerTree();
  const template = tree.nodes.find(n => n.ref.nativeId === 'a')!;
  tree.nodes.push(
    ...Array.from({ length: 4 }, (_, i) => ({
      ...template,
      ref: { ...template.ref, nativeId: `peer-${i}` },
      parentId: 'right',
      url: `https://same.test/${i}`,
    })),
  );
  template.url = 'https://same.test/new';
  return tree;
}
it('requires a strong exact-host majority and gives explicit valid rules priority', () => {
  const tree = fixture();
  expect(localClassification(tree, 'a', privacy, []).choice).toEqual({ source: 'domain', folderId: 'right' });
  const rule = {
    host: 'same.test',
    includeSubdomains: false,
    folder: tree.nodes.find(n => n.ref.nativeId === 'left')!.ref,
  };
  expect(localClassification(tree, 'a', privacy, [rule]).choice).toEqual({ source: 'rule', folderId: 'left' });
  tree.nodes.find(n => n.ref.nativeId === 'peer-3')!.parentId = 'left';
  expect(localClassification(tree, 'a', privacy, []).choice).toBeUndefined();
  tree.nodes.find(n => n.ref.nativeId === 'peer-3')!.url = 'https://sub.same.test/';
  expect(localClassification(tree, 'a', privacy, []).choice).toEqual({ source: 'domain', folderId: 'right' });
});
it('excludes private and foreign/missing rule destinations from both votes and candidate input', () => {
  const tree = fixture();
  const right = tree.nodes.find(n => n.ref.nativeId === 'right')!;
  const hidden = { ...privacy, excludedFolders: [right.ref] };
  const rule = { host: 'same.test', includeSubdomains: true, folder: right.ref };
  const result = localClassification(tree, 'a', hidden, [rule]);
  expect(result.choice).toBeUndefined();
  expect(result.folderIds).not.toContain('right');
  expect(
    localClassification(
      tree,
      'a',
      { ...privacy, excludedFolders: [tree.nodes.find(n => n.ref.nativeId === 'bar')!.ref] },
      [],
    ).sourceAllowed,
  ).toBe(false);
  expect(
    localClassification(tree, 'b', privacy, [{ ...rule, folder: { ...right.ref, installationId: 'other' } }]).choice,
  ).toBeUndefined();
});
it('reduces AI candidates while preserving top-level fallback and candidate ancestry', () => {
  const tree = organizerTree();
  const template = tree.nodes.find(n => n.ref.nativeId === 'left')!;
  tree.nodes.push(
    ...Array.from({ length: 100 }, (_, i) => ({
      ...template,
      ref: { ...template.ref, nativeId: `f${i}` },
      parentId: 'left',
      title: i === 99 ? '前端工具' : `Archive ${i}`,
    })),
  );
  tree.nodes.find(n => n.ref.nativeId === 'a')!.title = '前端工具';
  const result = localClassification(tree, 'a', privacy, []);
  expect(result.folderIds).toContain('f99');
  expect(result.folderIds).toContain('left');
  expect(result.folderIds).toContain('bar');
  expect(result.folderIds).toContain('outside');
  expect(result.folderIds.length).toBeLessThan(36);
});
