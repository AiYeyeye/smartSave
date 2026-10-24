import { searchTree } from './search-tree';

/** Synthetic categorized catalog with one recursively excluded bookmark. */
export function searchFolders() {
  const tree = searchTree(240);
  const root = tree.nodes[0]!;
  root.title = 'Bookmarks';
  const ids = ['early', 'useful', 'misc', 'private'];
  root.childrenIds = ids;
  for (const [index, id] of ids.entries()) {
    const children =
      index < 3
        ? tree.nodes.slice(1 + index * 80, 1 + (index + 1) * 80)
        : [{ ...tree.nodes[1]!, ref: { ...tree.nodes[1]!.ref, nativeId: 'secret' }, title: 'PRIVATE_SAMPLE' }];
    for (const node of children) node.parentId = id;
    tree.nodes.push({
      ...root,
      ref: { ...root.ref, nativeId: id },
      parentId: '0',
      title: id,
      index,
      childrenIds: children.map(node => node.ref.nativeId),
    });
    if (index === 3) tree.nodes.push(...children);
  }
  tree.nodes.find(node => node.ref.nativeId === '230')!.title = 'diagrams.net';
  return tree;
}
