import { expect, it, vi } from 'vitest';
import { OrganizeController, type OrganizeState } from '../panel/organize-controller';
import type { ModelAuthority } from '../adapters/model-authority';
import { organizerTree } from './fixtures/organizer-tree';
function setup() {
 const tree=organizerTree(); let state: OrganizeState; const listeners=new Set<()=>void>();
 const context={tree,version:1 as const,revision:'one',sessionRevision:0,key:'key',privacy:{fullUrl:true,bodyEnabled:false,excludedFolders:[]},config:{adapter:'openai-compatible' as const,baseUrl:'https://model.test/v1',model:'test',timeoutMs:1000}};
 const authority:ModelAuthority={read:async()=>structuredClone(context),subscribe:cb=>{listeners.add(cb); return ()=>listeners.delete(cb);}};
 const close=vi.fn(); const open=vi.fn(async()=>({token:'lease',close})); const send=vi.fn(async(r:{requestId:string})=>({requestId:r.requestId,status:'completed',needsReconcile:false,completedSteps:1,remainingSteps:0}));
 const model={run:vi.fn(async()=>({status:'completed' as const,output:{moves:[{itemId:'a',folderId:'right'},{itemId:'b',folderId:'right'}],merges:[],newFolders:[]}})),cancel:vi.fn(),dispose:vi.fn()};
 const controller=new OrganizeController(s=>{state=s;},authority,model,open,send); controller.setTree({status:'ready',snapshot:tree}); controller.selectScope('bar');
 return {controller,context,close,open,send,model,state:()=>state!,invalidate:()=>listeners.forEach(cb=>cb())};
}
it('retains unchecked proposal but revokes authority on settings/tree change without reopening',async()=>{
 const h=setup(); await h.controller.generate(); h.controller.toggle('move:a',false); const frozen=h.state().proposal;
 h.context.revision='two';h.invalidate(); expect(h.state().selected).toEqual(['move:b']);expect(h.state().proposal).toEqual(frozen);expect(h.state().invalid).toBe(true);expect(h.close).toHaveBeenCalledTimes(1);
 await h.controller.apply();expect(h.send).not.toHaveBeenCalled();expect(h.open).toHaveBeenCalledTimes(1);
});
it('only explicit generation calls model, applies selected batch once, never replays',async()=>{
 const h=setup(); expect(h.model.run).not.toHaveBeenCalled(); await h.controller.generate();h.controller.toggle('move:a',false);await h.controller.apply();await h.controller.apply();expect(h.send).toHaveBeenCalledTimes(1); expect(h.state().result?.status).toBe('completed');
});
it('scope change retains invalid proposal rather than silently retargeting',async()=>{
 const h=setup();await h.controller.generate();h.controller.selectScope('outside');expect(h.state().proposal?.scope.nativeId).toBe('bar');expect(h.state().invalid).toBe(true);expect(h.close).toHaveBeenCalled();
});
it('keeps frozen snapshot identities stable on selection-only updates',async()=>{
 const h=setup();await h.controller.generate();const proposal=h.state().proposal;const tree=h.state().tree;h.controller.toggle('move:a',false);expect(h.state().proposal).toBe(proposal);expect(h.state().tree).toBe(tree);
});
it('duplicate edits revoke frozen authorization and failed re-preview cannot leave applicable UI',async()=>{
 const h=setup();h.controller.scan();h.controller.choice('a','keep');h.controller.choice('b','delete');await h.controller.previewDuplicates();expect(h.state().proposal?.actions).toHaveLength(1);
 h.controller.choice('a','delete');expect(h.state().proposal).toBeUndefined();await h.controller.previewDuplicates();expect(h.state().proposal).toBeUndefined();await h.controller.apply();expect(h.send).not.toHaveBeenCalled();expect(h.state().message).toContain('明确保留');
});
