import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PendingMutations,lookupDecision} from '../public/submissions.js';
import {threadProjectPath} from '../public/projects.js';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const INSTANCE='a'.repeat(32),OTHER='b'.repeat(32),NOW=1794400000000;
async function harness(method,params={},options={}){
 const storage={raw:null,getItem(){return this.raw;},setItem(key,value){this.raw=value;},removeItem(){this.raw=null;}};
 const original=new PendingMutations(storage,{now:()=>NOW,uuid:()=> '00000000-0000-4000-8000-000000000001'});
 const envelope=original.begin(INSTANCE,method,params);original.mark(envelope.requestId,'unknown');
 const ledger=options.restored?new PendingMutations(storage):original;
 const marker=ledger.values()[0],calls={draft:[],history:[],lists:0,notices:[],reasoning:[],permissions:[],requestRenders:0,optimistic:[]};
 const state={connected:true,serverInstance:INSTANCE,thread:null,cwd:'/project',loadingThread:false,openGeneration:0,busy:false,turnId:null,terminalTurns:new Set(),dshReadErrors:new Map(),dshOpenDetails:new Set(),settingsPage:'general',ledger:{merge(){},activate(){}},...options.state};
 const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',classList:{contains:()=>false,add(){} }});return nodes.get(id);};
 const contexts=new Map();if(options.context)contexts.set(marker.requestId,options.context);
 const deps={sessionControls:{load:async id=>{calls.permissions.push(id);await options.loadPermission?.(id,state);}},composer:{resolveOptimistic:(...args)=>calls.optimistic.push(args)},state,pendingMutations:ledger,allPendingRecords:()=>ledger.values(),mutationContexts:contexts,pendingReadGeneration:0,pendingReconcileErrors:new Map(),lookupDecision,pendingLedgerSignature:()=>'',pendingReconcilerSignature:'',renderPendingMutations(){},updateControls(){},noteLedgerChanged(){},notice:(...args)=>calls.notices.push(args),runtimePanel:{refresh(){}},refreshAccount:async()=>{},remoteControls(){},$,
  clearSubmittedDraft:value=>calls.draft.push(value),restoreThreadReasoning:value=>calls.reasoning.push(value),dshTasks:{reset(){}},renderDshConnection(){},syncDshLiveContext(){},renderDshTasks(){},renderRequests(){calls.requestRenders++;},activity(){},
  loadThreads:async()=>{calls.lists++;if(options.loadThreads)await options.loadThreads();},loadItems:async(...args)=>{calls.history.push(args);if(options.loadItems)await options.loadItems();}};
 const start=app.indexOf('function pendingMarkerExists('),end=app.indexOf('function handlePendingReconcileError(',start);assert.ok(start>=0&&end>start);
 const functions=new Function('threadProjectPath',...Object.keys(deps),`${app.slice(start,end)};return {handle:handlePendingReconcileResult,invalidate(){pendingReadGeneration++;}};`)(threadProjectPath,...Object.values(deps));
 const response=result=>({serverInstance:INSTANCE,method,state:'succeeded',result});
 return{...functions,state,calls,ledger,marker,envelope,response};
}
test('new thread recovery adopts only the matching unassigned page and never sends its draft',async()=>{
 const h=await harness('thread/start',{cwd:'/project'});const thread={id:'created',cwd:'/project'};
 await h.handle(h.marker,h.response({thread,model:'configured'}));assert.equal(h.state.thread,thread);assert.equal(h.calls.reasoning[0].model,'configured');assert.equal(h.calls.lists,1);assert.equal(h.calls.history.length,0);assert.equal(h.calls.draft.length,0);assert.equal(h.calls.requestRenders,1);assert.equal(h.ledger.values().length,0);
 assert.deepEqual(h.calls.permissions,['created']);
 for(const options of [{state:{thread:{id:'other'}}},{state:{cwd:'/other'}},{context:{openGeneration:0},state:{openGeneration:1}}]){
  const h=await harness('thread/start',{cwd:'/project'},options);const before=h.state.thread;await h.handle(h.marker,h.response({thread}));assert.equal(h.state.thread,before);assert.equal(h.calls.lists,1);assert.equal(h.calls.reasoning.length,0);assert.equal(h.calls.requestRenders,0);assert.equal(h.ledger.values().length,0);
  assert.deepEqual(h.calls.permissions,[]);
 }
 const restored=await harness('thread/start',{cwd:'/project'},{restored:true,loadPermission:(_id,state)=>{state.openGeneration++;}});
 await restored.handle(restored.marker,restored.response({thread}));
 assert.deepEqual(restored.calls.permissions,['created']);assert.equal(restored.state.thread,null);assert.equal(restored.calls.draft.length,0);assert.equal(restored.calls.lists,1);
});
test('malformed successful results remain pending rather than unlocking a duplicate operation',async()=>{
 for(const [method,params,result]of [['thread/start',{}, {thread:{id:'t'}}],['turn/start',{threadId:'t'},{turn:{id:'turn'}}],['turn/start',{threadId:'t'},{threadId:'other',turn:{id:'turn',status:'inProgress'}}],['terminal/open',{},{}]]){
  const h=await harness(method,params);await assert.rejects(h.handle(h.marker,h.response(result)),/有效/);assert.equal(h.ledger.values().length,1,method);
 }
});
test('turn recovery clears captured attachments, preserves new text and restores current-thread running state',async()=>{
 const h=await harness('turn/start',{threadId:'current',input:[{type:'text',text:'original'}]},{state:{thread:{id:'current'}}});
 await h.handle(h.marker,h.response({turn:{id:'turn',status:'inProgress'}}));assert.equal(h.state.busy,true);assert.equal(h.state.turnId,'turn');assert.deepEqual(h.calls.draft,[{...h.envelope,preserveText:true}]);assert.equal(h.calls.history.length,1);assert.equal(h.ledger.values().length,0);
 const restored=await harness('turn/start',{threadId:'current'},{restored:true,state:{thread:{id:'current'}}});await restored.handle(restored.marker,restored.response({turn:{id:'done',status:'completed'}}));assert.equal(restored.calls.draft.length,0,'reloaded records contain no evidence identifying the current draft');assert.equal(restored.state.busy,false);assert.equal(restored.state.turnId,null);
 const other=await harness('turn/start',{threadId:'original'},{state:{thread:{id:'other'},busy:true,turnId:'newer'}});await other.handle(other.marker,other.response({turn:{id:'old',status:'completed'}}));assert.equal(other.state.turnId,'newer');assert.equal(other.state.busy,true);assert.equal(other.calls.history.length,0);
});
test('an already completed or newer running turn cannot be resurrected by lookup',async()=>{
 const completed=await harness('turn/start',{threadId:'current'},{state:{thread:{id:'current'},terminalTurns:new Set(['old'])}});await completed.handle(completed.marker,completed.response({turn:{id:'old',status:'inProgress'}}));assert.equal(completed.state.busy,false);assert.equal(completed.state.turnId,null);
 const newer=await harness('turn/start',{threadId:'current'},{state:{thread:{id:'current'},busy:true,turnId:'newer'}});await newer.handle(newer.marker,newer.response({turn:{id:'old',status:'completed'}}));assert.equal(newer.state.busy,true);assert.equal(newer.state.turnId,'newer');
});
test('legacy terminal records settle and identify the existing process',async()=>{
 const h=await harness('terminal/open',{});
 await h.handle(h.marker,h.response({processId:'original-process'}));
 assert.match(h.calls.notices[0][0],/original-process/);
 assert.equal(h.ledger.values().length,0);
});
test('obsolete instances, removed markers and late async recovery cannot settle current state',async()=>{
 const stale=await harness('thread/start');stale.state.serverInstance=OTHER;await stale.handle(stale.marker,stale.response({thread:{id:'old',cwd:'/project'}}));assert.equal(stale.state.thread,null);assert.equal(stale.ledger.values().length,1);
 const removed=await harness('thread/start');removed.ledger.settle(removed.marker.requestId);await removed.handle(removed.marker,removed.response({thread:{id:'old',cwd:'/project'}}));assert.equal(removed.state.thread,null);
 let finish;const late=await harness('turn/start',{threadId:'current'},{state:{thread:{id:'current'}},loadItems:()=>new Promise(resolve=>{finish=resolve;})});const result=late.handle(late.marker,late.response({turn:{id:'old',status:'completed'}}));await Promise.resolve();late.invalidate();late.state.thread={id:'new'};late.state.busy=true;late.state.turnId='newer';finish();await result;assert.equal(late.ledger.values().length,1);assert.equal(late.state.turnId,'newer');assert.equal(late.state.thread.id,'new');
});

// The recovered operation must settle its matching optimistic row only after
// authoritative validation, never from stale, malformed or uncertain replies.
test('recovery forwards exact confirmed outcome to composer once and leaves unknown outcomes unresolved',async()=>{
 for(const decision of ['succeeded','failed','notExecuted']){
  const h=await harness('turn/start',{threadId:'current'},{state:{thread:{id:'current'}}});
  const response=decision==='succeeded'?h.response({turn:{id:'confirmed',status:'completed'}}):{serverInstance:INSTANCE,method:'turn/start',state:'failed',outcome:decision,error:'confirmed rejection'};
  await h.handle(h.marker,response,decision);
  assert.deepEqual(h.calls.optimistic,[[h.marker,response,decision]]);
  assert.equal(h.ledger.values().length,0);
  await h.handle(h.marker,response,decision);assert.equal(h.calls.optimistic.length,1,'settled reply must not repeat');
 }
 for(const decision of ['pending','unknown']){
  const h=await harness('turn/start',{threadId:'current'});await h.handle(h.marker,{serverInstance:INSTANCE},decision);
  assert.deepEqual(h.calls.optimistic,[]);assert.equal(h.ledger.values().length,1);
 }
 const stale=await harness('turn/start',{threadId:'current'});stale.state.serverInstance=OTHER;
 await stale.handle(stale.marker,stale.response({turn:{id:'old',status:'completed'}}));assert.deepEqual(stale.calls.optimistic,[]);
 const malformed=await harness('turn/start',{threadId:'current'});
 await assert.rejects(malformed.handle(malformed.marker,malformed.response({})));assert.deepEqual(malformed.calls.optimistic,[]);
});
