import { useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsStore } from '../persistence/settings';
import { browserModelAuthority } from '../adapters/model-authority';
import { ModelTransport } from '../adapters/model-transport';
import { RecoveryWorkbench } from '../options/RecoveryWorkbench';
import { OrganizeController, type OrganizeState } from './organize-controller';
import { connectTree } from './tree-client';
import type { TreeSnapshot } from '../domain/node-reference';
import type { DuplicateChoice } from '../domain/exact-duplicates';
type CreateController = (emit: (state: OrganizeState) => void) => OrganizeController;
function pathLabels(tree?: TreeSnapshot) {
  const byId = new Map(tree?.nodes.map(n => [n.ref.nativeId,n]));
  const labels = new Map<string,string>();
  for(const id of byId.keys()) {
    const chain: string[] = []; const seen = new Set<string>(); let current: string | undefined = id;
    while(current !== undefined && !labels.has(current) && byId.has(current)) {
      if(seen.has(current)) break; seen.add(current);chain.push(current);current=byId.get(current)!.parentId;
    }
    let prefix=current===undefined?'':labels.get(current) ?? '';
    for(const child of chain.reverse()) { prefix=[prefix,byId.get(child)!.title || '根目录'].filter(Boolean).join(' / ');labels.set(child,prefix); }
  }
  return labels;
}
export function OrganizeWorkbench({ visible, settings, createController }: { visible: boolean; settings?: SettingsStore; createController?: CreateController }) {
  const [state,setState]=useState<OrganizeState>({tree:{status:'loading'},scopeId:'',selected:[],targets:{},duplicates:[],choices:{},invalid:false,busy:false,message:'正在连接书签服务…'});
  const owner=useRef<OrganizeController | undefined>(undefined);
  useEffect(()=>{
    const authority=!createController && settings && typeof chrome!=='undefined'?browserModelAuthority(settings):undefined;
    const transport=authority?new ModelTransport({fetch:(...args)=>fetch(...args),contains:request=>chrome.permissions.contains(request)},authority):undefined;
    const controller=createController?createController(setState):new OrganizeController(setState,authority,transport);owner.current=controller;
    const stop=!createController && typeof chrome!=='undefined' && typeof chrome.runtime?.connect==='function'?connectTree(chrome.runtime,tree=>controller.setTree(tree)):undefined;
    if(!createController && !stop)controller.setTree({status:'error',message:'书签服务不可用。'});
    return()=>{stop?.();controller.dispose();owner.current=undefined;};
  },[settings,createController]);
  const folders=state.tree.status==='ready'?state.tree.snapshot.nodes.filter(n=>n.childrenWritable):[];
  const proposal=state.proposal;
  const currentTree=state.tree.status==='ready'?state.tree.snapshot:undefined;
  const currentPaths=useMemo(()=>pathLabels(currentTree),[currentTree]);
  const proposalPaths=useMemo(()=>pathLabels(proposal?.tree),[proposal?.tree]);
  const targetOptions=useMemo(()=>proposal?.targetIds.map(id=><option key={id} value={id}>{proposalPaths.get(id) ?? proposal.actions.find(a=>a.kind==='create' && a.sourceId===id)?.title ?? id}</option>),[proposal,proposalPaths]);
  return <section hidden={!visible} className="surface organize-workbench" aria-label="整理工作台" aria-busy={state.busy}>
    <h2>范围内整理与精确去重</h2><p>仅在明确选择的目录内预览；不会重建全树。写入前自动备份，失败停止，不承诺事务回滚。</p>
    <label>整理范围<select aria-label="整理范围" disabled={state.busy} value={state.scopeId} onChange={e=>owner.current?.selectScope(e.target.value)}><option value="">请选择目录</option>{folders.map(n=><option key={n.ref.nativeId} value={n.ref.nativeId}>{currentPaths.get(n.ref.nativeId) ?? n.title}</option>)}</select></label>
    {state.tree.status==='error' && <p role="alert">{state.tree.message}</p>}
    <div className="actions"><button disabled={!state.scopeId || state.busy || state.tree.status!=='ready'} onClick={()=>owner.current?.scan()}>本地扫描精确重复</button><button disabled={!settings || !state.scopeId || state.busy || state.tree.status!=='ready'} onClick={()=>void owner.current?.generate()}>明确请求 AI 生成本范围提案</button><button disabled={!state.busy && !proposal} onClick={()=>owner.current?.cancel()}>{state.busy?'取消生成 / 停止尚未发起步骤':'取消提案授权'}</button></div>
    <p role={state.invalid?'alert':'status'}>{state.message}</p>
    {state.duplicates.map(group=><article key={group.url}><h3>精确重复：{group.url}</h3><p>保留至少一项；未选择的项目不删除。参数、片段和尾斜杠不同不会合并。</p>{group.items.map(node=><label key={node.ref.nativeId}>{node.title} · {proposalPaths.get(node.ref.nativeId) ?? currentPaths.get(node.ref.nativeId) ?? node.ref.nativeId}<select aria-label={`${node.title} 保留或删除`} disabled={state.busy || state.invalid} value={state.choices[node.ref.nativeId] ?? 'unselected'} onChange={e=>owner.current?.choice(node.ref.nativeId,e.target.value as DuplicateChoice)}><option value="unselected">未选择</option><option value="keep">明确保留</option><option value="delete">明确删除</option></select></label>)}</article>)}
    {!!state.duplicates.length && <button disabled={state.busy || state.invalid} onClick={()=>void owner.current?.previewDuplicates()}>预览所选去重</button>}
    {proposal && <article><h3>固定范围：{proposalPaths.get(proposal.scope.nativeId)}</h3><p>理由：AI 局部结构建议或用户选择的精确重复清理；建议不是写入授权。取消选中项不会自动恢复。</p>{proposal.actions.map(action=><div className="surface" key={action.id}><label><input type="checkbox" aria-label={`选择 ${action.id}`} checked={state.selected.includes(action.id)} disabled={state.busy} onChange={e=>owner.current?.toggle(action.id,e.target.checked)}/>{action.kind}：{action.title}</label><p>当前路径：{action.kind==='create'?'新建目录':proposalPaths.get(action.sourceId)}</p>{action.targetId && <label>建议目标<select aria-label={`${action.id} 目标`} disabled={state.busy} value={state.targets[action.id] ?? action.targetId} onChange={e=>owner.current?.target(action.id,e.target.value)}>{targetOptions}</select></label>}{action.kind==='merge' && <><p>先迁移下列直接子项（包含其内容），然后仅移除空目录：{action.title}。任何新增子项都将导致停止。</p><ul>{action.children.map(id=><li key={id}>{proposalPaths.get(id)}</li>)}</ul></>}</div>)}<button disabled={state.busy || state.invalid || !state.selected.length || !!state.result} onClick={()=>void owner.current?.apply()}>一次确认并应用所选操作</button></article>}
    {state.result && <p>请求编号：{state.result.requestId}。状态 {state.result.status}；已完成 {state.result.completedSteps}，未完成 {state.result.remainingSteps}。请读取下方恢复记录核对逐步回执。</p>}
    <RecoveryWorkbench />
  </section>;
}
