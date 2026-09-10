import type { TreeSnapshot } from '../../domain/node-reference';
export function organizerTree(): TreeSnapshot {
  const rows = [ ['0', undefined, ['bar','outside'], true], ['bar','0',['left','right'],true], ['left','bar',['a','b'],false], ['right','bar',[],false], ['a','left',[],false,'https://x.test/?a#b'], ['b','left',[],false,'https://x.test/?a#b'], ['outside','0',['c'],true], ['c','outside',[],false,'https://x.test/?a#b'] ] as const;
  return { installationId:'install',epoch:'epoch',observedRevision:1,roots:['0'],nodes:rows.map(([id,parentId,children,readOnly,url]) => ({ref:{installationId:'install',nativeId:id,kind:url?'bookmark':'folder'},parentId,index: id === 'outside' || id === 'right' || id === 'b' ? 1 : 0,title:id,url,childrenIds:[...children],readOnly,childrenWritable: !url && id !== '0',observedRevision:1})) };
}
