import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { OrganizerAuthority } from '../background/organizer-authority';
import { MutationCoordinator } from '../background/mutation-coordinator';
import { OperationsStore } from '../persistence/operations';
import { ModelTransport } from '../adapters/model-transport';
import { OrganizeController, type OrganizeState } from '../panel/organize-controller';
import { expectedAfter } from '../domain/mutation-effect';
import { organizerTree } from './fixtures/organizer-tree';
import type { ModelAuthority } from '../adapters/model-authority';
import type { BookmarkWriter } from '../adapters/bookmarks-write';
it.each(['success','late-child','partial','backup-failure','privacy-race'])('actual model/controller/coordinator/authority/fakeIDB: %s',async mode=>{
 let tree=organizerTree();let writes=0;let state:OrganizeState;const callbacks=new Set<()=>void>();
 const settings={snapshot:async()=>({version:1 as const,revision:'one',sessionRevision:0,key:'',privacy:{fullUrl:true,bodyEnabled:false,excludedFolders:[]},config:{adapter:'openai-compatible' as const,baseUrl:'https://model.test/v1',model:'test',timeoutMs:1000}}),subscribe:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);}};
 const authority=new OrganizerAuthority(settings,'test');const sender={id:'test',url:'chrome-extension://test/panel/index.html'};
 const modelAuthority:ModelAuthority={read:async()=>({...await settings.snapshot(),tree:structuredClone(tree)}),subscribe:settings.subscribe};
 const transport=new ModelTransport({contains:async()=>true,fetch:async(_url,init)=>{expect(String(init?.body)).not.toContain('outside');return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({moves:[],newFolders:[],merges:[{sourceId:'left',targetId:'right'}]})}}]}));}},modelAuthority);
 const writer:BookmarkWriter={update:async()=>{throw Error('unused');},create:async details=>{writes++;const result={id:'restored-folder',...details,syncing:false};tree={...tree,nodes:expectedAfter(tree,{type:'create',...details,temporaryId:'unused'},result)};return result;},move:async(id,{parentId,index})=>{
  writes++;const node=tree.nodes.find(n=>n.ref.nativeId===id)!;const result={id,parentId,index,title:node.title,url:node.url,syncing:false};
  tree={...tree,nodes:expectedAfter(tree,{type:'move',id,parentId,index},result)};return result;
 },remove:async id=>{writes++;tree={...tree,nodes:expectedAfter(tree,{type:'remove',id},undefined)};}};
 const store=new OperationsStore(new IDBFactory());let puts=0;let reads=0;
 const coordinator=new MutationCoordinator({fresh:async()=>{
   if(mode==='late-child' && writes===2 && ++reads===1){const child={...tree.nodes.find(n=>n.ref.nativeId==='a')!,ref:{installationId:'install',nativeId:'late',kind:'bookmark' as const},parentId:'left'};tree.nodes.push(child);tree.nodes.find(n=>n.ref.nativeId==='left')!.childrenIds.push('late');}
   return structuredClone(tree);
 }},writer,{all:()=>store.all(),put:async record=>{if(mode==='backup-failure')throw Error('quota');await store.put(record);if(mode==='partial' && record.steps.filter(step=>step.state==='receipt').length===2 && !tree.nodes.some(n=>n.ref.nativeId==='late')) {tree.nodes.push({...tree.nodes.find(n=>n.ref.nativeId==='a')!,ref:{installationId:'install',nativeId:'late',kind:'bookmark'},parentId:'left'});tree.nodes.find(n=>n.ref.nativeId==='left')!.childrenIds.push('late');}if(mode==='privacy-race' && ++puts===2)callbacks.forEach(cb=>cb());}},'test',undefined,authority);
 const controller=new OrganizeController(s=>{state=s;},modelAuthority,transport,async()=>{const token=await authority.open(sender);return{token,close:()=>authority.close(token)};},async request=>coordinator.submit(await coordinator.registerOrganizerPreview(request,sender),sender));
 controller.setTree({status:'ready',snapshot:tree});controller.selectScope('bar');await controller.generate();expect(state!.proposal?.actions[0]?.kind).toBe('merge');await controller.apply();
 if(mode==='success'){
 const preview=await coordinator.recovery({version:1,type:'recoveryPreview',requestId:'undo-preview',sourceRequestId:state!.result!.requestId,mode:'undo'},sender);expect(preview.status).toBe('preview');if(preview.status==='preview')expect(preview.proposal?.command.type).toBe('batch');
 expect(state!.result?.status).toBe('completed');expect(writes).toBe(3);expect(tree.nodes.find(n=>n.ref.nativeId==='left')).toBeUndefined();expect(tree.nodes.find(n=>n.ref.nativeId==='outside')?.childrenIds).toEqual(['c']);
 if(preview.status==='preview' && preview.proposal){expect((await coordinator.submit(preview.proposal,sender)).status).toBe('completed');expect(tree.nodes.find(n=>n.ref.nativeId==='a')?.parentId).toBe('restored-folder');}
 }
 else if(mode==='late-child'){expect(state!.result?.needsReconcile).toBe(true);expect(writes).toBe(2);expect(tree.nodes.find(n=>n.ref.nativeId==='left')).toBeDefined();}
 else if(mode==='partial'){expect(state!.result?.status).toBe('partial');expect(state!.result?.completedSteps).toBe(2);expect(writes).toBe(2);expect(tree.nodes.find(n=>n.ref.nativeId==='left')?.childrenIds).toEqual(['late']);}
 else expect(writes).toBe(0);
 const records=await store.all();expect(JSON.stringify(records)).not.toContain('organizerContext');controller.dispose();
});
