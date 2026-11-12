import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMutation, PendingMutations, serializeMarkers, restoreMarkers, outcomeFromError, lookupDecision, pendingForScope, PendingReconciler } from '../public/submissions.js';
const INSTANCE='a'.repeat(32), OTHER='b'.repeat(32), NOW=1794400000000;
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
class MemoryStorage {constructor(){this.map=new Map();}getItem(k){return this.map.get(k)||null;}setItem(k,v){this.map.set(k,v);}removeItem(k){this.map.delete(k);}}
function setup(){let count=0;const storage=new MemoryStorage();return {storage,ledger:new PendingMutations(storage,{now:()=>NOW,uuid:()=>uuid(++count)})};}
test('logical mutation IDs include server instance, time and a UUID',()=>{const op=makeMutation(INSTANCE,'thread/start',{cwd:'/project'},{now:NOW,uuid:uuid(1)});assert.equal(op.envelope.requestId,`${INSTANCE}:${NOW}:${uuid(1)}`);assert.equal(op.marker.status,'inFlight');assert.throws(()=>makeMutation('', 'turn/start',{}, {now:NOW,uuid:uuid(1)}));});
test('captured payload and attachment IDs cannot be retargeted by draft edits',()=>{const {ledger}=setup();const params={threadId:'t',cwd:'/project',input:[{type:'text',text:'original'}]};const attachments=[uuid(20)];const envelope=ledger.begin(INSTANCE,'turn/start',params,{attachmentIds:attachments});params.input[0].text='changed';params.cwd='/other';attachments.push(uuid(21));assert.equal(envelope.params.input[0].text,'original');assert.equal(envelope.params.cwd,'/project');assert.deepEqual(envelope.attachmentIds,[uuid(20)]);envelope.params.input[0].text='mutated';assert.equal(ledger.envelope(envelope.requestId).params.input[0].text,'original');});
test('minimal persistent marker excludes plaintext prompts, cwd and attachment identifiers',()=>{const {ledger,storage}=setup();ledger.begin(INSTANCE,'turn/start',{threadId:'t',cwd:'/secret-project',input:[{type:'text',text:'private prompt'}]},{attachmentIds:[uuid(44)]});const raw=[...storage.map.values()][0];assert.ok(!raw.includes('private prompt'));assert.ok(!raw.includes('/secret-project'));assert.ok(!raw.includes(uuid(44)));assert.ok(raw.includes('turn/start'));assert.ok(raw.includes('threadId'));});
test('unknown result locks new sends; page reload restores unknown marker without payload',()=>{const {ledger,storage}=setup();const op=ledger.begin(INSTANCE,'turn/start',{threadId:'t',input:[{type:'text',text:'x'}]});ledger.mark(op.requestId,'unknown');assert.equal(ledger.blocked,true);const reloaded=new PendingMutations(storage);assert.equal(reloaded.blocked,true);assert.equal(reloaded.values()[0].status,'unknown');assert.equal(reloaded.values()[0].restored,true);assert.equal(reloaded.envelope(op.requestId),null);});
test('even in-flight marker becomes unknown on reload, never silently unlocked',()=>{const {ledger,storage}=setup();ledger.begin(INSTANCE,'thread/start',{});const reloaded=new PendingMutations(storage);assert.equal(reloaded.values()[0].status,'unknown');assert.equal(reloaded.blocked,true);});
test('confirmed settlement clears marker and frees the gate without replay',()=>{const {ledger,storage}=setup();const op=ledger.begin(INSTANCE,'turn/interrupt',{threadId:'t',turnId:'turn'});assert.equal(ledger.has('turn/interrupt','t','turn'),true);ledger.settle(op.requestId);assert.equal(ledger.blocked,false);assert.equal(new PendingMutations(storage).blocked,false);assert.equal(ledger.envelope(op.requestId),null);});
test('unavailable storage prevents issuing a new mutation envelope',()=>{const storage={getItem(){return null;},setItem(){throw Error('blocked');},removeItem(){throw Error('blocked');}};const ledger=new PendingMutations(storage,{now:()=>NOW,uuid:()=>uuid(1)});assert.throws(()=>ledger.begin(INSTANCE,'thread/start',{}),/暂停/);assert.equal(ledger.blocked,true);assert.equal(ledger.values().length,0);});
test('failure to clear stored confirmation remains conservatively blocked',()=>{const {ledger,storage}=setup();const op=ledger.begin(INSTANCE,'thread/start',{});storage.removeItem=()=>{throw Error('blocked');};assert.throws(()=>ledger.settle(op.requestId));assert.equal(ledger.blocked,true);assert.equal(ledger.values().length,1);});
test('malformed pending store does not silently unlock',()=>{const storage=new MemoryStorage();storage.setItem('codex-light-pending-v1','not json');const ledger=new PendingMutations(storage);assert.equal(ledger.blocked,true);assert.match(ledger.storageError,/损坏/);});
test('error classification preserves unknown timeout, transport and ID conflict',()=>{for(const error of [{},{code:'RPC_TIMEOUT'},{outcome:'unknown',code:'REQUEST_ID_CONFLICT'}])assert.equal(outcomeFromError(error),'unknown');assert.equal(outcomeFromError({notExecuted:true}),'notExecuted');assert.equal(outcomeFromError({outcome:'failed'}),'failed');});
test('read-only lookup needs exact server instance/method and never clears notFound',()=>{const marker=makeMutation(INSTANCE,'turn/start',{}, {now:NOW,uuid:uuid(1)}).marker;assert.equal(lookupDecision(marker,{serverInstance:INSTANCE,state:'succeeded',method:'turn/start'}),'succeeded');assert.equal(lookupDecision(marker,{serverInstance:OTHER,state:'succeeded'}),'unknown');assert.equal(lookupDecision(marker,{serverInstance:INSTANCE,state:'succeeded',method:'thread/start'}),'unknown');assert.equal(lookupDecision(marker,{serverInstance:INSTANCE,state:'notFound',outcome:'notExecuted'}),'unknown');assert.equal(lookupDecision(marker,{serverInstance:INSTANCE,state:'pending'}),'pending');assert.equal(lookupDecision(marker,{serverInstance:INSTANCE,state:'failed',outcome:'notExecuted'}),'notExecuted');});
test('explicitly cleared operation can be replaced by a new identity; old identity not reused',()=>{const {ledger}=setup();const one=ledger.begin(INSTANCE,'turn/start',{threadId:'t'});ledger.mark(one.requestId);ledger.settle(one.requestId);const two=ledger.begin(INSTANCE,'turn/start',{threadId:'t'});assert.notEqual(one.requestId,two.requestId);});
test('marker serialization removes arbitrary extra data and restores no original plaintext',()=>{const marker=makeMutation(INSTANCE,'turn/start',{}, {now:NOW,uuid:uuid(1)}).marker;const raw=serializeMarkers([{...marker,prompt:'SECRET',result:'SECRET',attachmentIds:[uuid(2)]}]);assert.ok(!raw.includes('SECRET'));assert.equal(restoreMarkers(raw)[0].requestId,marker.requestId);});
test('terminal opening uses durable identity but never persists shell cwd or input',()=>{const {ledger,storage}=setup();const envelope=ledger.begin(INSTANCE,'terminal/open',{cwd:'/private-project',size:{rows:24,cols:80}});assert.equal(envelope.method,'terminal/open');assert.equal(envelope.requestId.split(':')[0],INSTANCE);ledger.mark(envelope.requestId,'unknown');assert.equal(ledger.has('terminal/open',null),true);assert.ok(![...storage.map.values()][0].includes('/private-project'));assert.equal(new PendingMutations(storage).blocked,true);});
test('file references and risk consent are captured without persistent identifiers',()=>{const {ledger,storage}=setup();const ids=[uuid(70)];const op=ledger.begin(INSTANCE,'turn/start',{threadId:'t',input:[]},{fileAttachmentIds:ids,confirmedFileAttachmentIds:ids});ids.push(uuid(71));assert.deepEqual(op.fileAttachmentIds,[uuid(70)]);assert.deepEqual(op.confirmedFileAttachmentIds,[uuid(70)]);assert.ok(![...storage.map.values()][0].includes(uuid(70)));assert.throws(()=>makeMutation(INSTANCE,'turn/start',{}, {now:NOW,uuid:uuid(1),fileAttachmentIds:[uuid(70)],confirmedFileAttachmentIds:[uuid(71)]}));assert.throws(()=>makeMutation(INSTANCE,'turn/start',{}, {now:NOW,uuid:uuid(1),attachmentIds:[uuid(1),uuid(2),uuid(3)],fileAttachmentIds:[uuid(4),uuid(5),uuid(6)]}));});
test('plugin apply survives reload and nested unknown never becomes success',()=>{const {ledger,storage}=setup();const op=ledger.begin(INSTANCE,'plugin/apply',{planId:'opaque-plan',confirmed:true});const restored=new PendingMutations(storage);assert.equal(restored.has('plugin/apply',null),true);const marker=restored.values()[0];assert.equal(lookupDecision(marker,{serverInstance:INSTANCE,method:'plugin/apply',state:'succeeded',result:{outcome:'unknown'}}),'unknown');assert.equal(lookupDecision(marker,{serverInstance:INSTANCE,method:'plugin/apply',state:'succeeded',result:{outcome:'not-executed'}}),'notExecuted');assert.equal(lookupDecision(marker,{serverInstance:INSTANCE,method:'plugin/apply',state:'succeeded',result:{outcome:'succeeded'}}),'succeeded');assert.ok(![...storage.map.values()][0].includes('opaque-plan'));});
test('Git completed nonzero is failure, unknown persists, exact success required',()=>{const {ledger}=setup();ledger.begin(INSTANCE,'git/apply',{planId:'p',confirmed:true});const marker=ledger.values()[0];const response={serverInstance:INSTANCE,method:'git/apply',state:'succeeded'};assert.equal(lookupDecision(marker,{...response,result:{outcome:'completed',exitCode:1}}),'failed');assert.equal(lookupDecision(marker,{...response,result:{outcome:'completed',exitCode:0}}),'succeeded');assert.equal(lookupDecision(marker,{...response,result:{outcome:'unknown',exitCode:null}}),'unknown');assert.equal(lookupDecision(marker,{...response,result:{outcome:'notExecuted',exitCode:null}}),'notExecuted');});
test('configuration business unknown remains unknown despite HTTP operation success',()=>{const {ledger}=setup();ledger.begin(INSTANCE,'config/apply',{planId:'private',confirmed:true});const marker=ledger.values()[0];assert.equal(lookupDecision(marker,{serverInstance:INSTANCE,method:'config/apply',state:'succeeded',result:{outcome:'unknown'}}),'unknown');assert.equal(lookupDecision(marker,{serverInstance:INSTANCE,method:'config/apply',state:'succeeded',result:{outcome:'succeeded',status:'okOverridden'}}),'succeeded');});
test('every disabled send state gives a visible reason and useful action',async()=>{const {sendAvailability}=await import('../public/submissions.js');const ready={connected:true,serverInstance:INSTANCE,sending:false,loadingThread:false,busy:false,uploadingImages:false,pending:false,cwd:'/project',hasContent:true};assert.equal(sendAvailability(ready).disabled,false);for(const change of [{connected:false},{serverInstance:null},{sending:true},{loadingThread:true},{busy:true},{uploadingImages:true},{pending:true},{cwd:''},{hasContent:false}]){const status=sendAvailability({...ready,...change});assert.equal(status.disabled,true);assert.ok(status.reason);}assert.equal(sendAvailability({...ready,cwd:''}).action,'cwd');assert.equal(sendAvailability({...ready,pending:true}).reason,'这条消息的发送状态正在同步…');});
test('late readiness bootstraps once without a startup timeout and rejects stale completions',async()=>{const {ConnectionBootstrap}=await import('../public/submissions.js');let starts=0,commits=0;const finish=[];const bootstrap=new ConnectionBootstrap(async current=>{starts++;await new Promise(resolve=>finish.push(resolve));if(current())commits++;});bootstrap.update(false,INSTANCE);await Promise.resolve();assert.equal(starts,0);/* readiness can arrive arbitrarily later, including after 10 seconds */bootstrap.update(true,INSTANCE);bootstrap.update(true,INSTANCE);await Promise.resolve();assert.equal(starts,1);bootstrap.update(false,INSTANCE);bootstrap.update(true,OTHER);await Promise.resolve();assert.equal(starts,2);finish[0]();await Promise.resolve();assert.equal(commits,0);finish[1]();await Promise.resolve();assert.equal(commits,1);});
test('late readiness without a server instance loads, then reloads for the real instance',async()=>{const {ConnectionBootstrap}=await import('../public/submissions.js');let starts=0,commits=0;const finish=[];const bootstrap=new ConnectionBootstrap(async current=>{starts++;await new Promise(resolve=>finish.push(resolve));if(current())commits++;});bootstrap.update(true,null);await Promise.resolve();assert.equal(starts,1);bootstrap.update(true,INSTANCE);await Promise.resolve();assert.equal(starts,2);finish[0]();await Promise.resolve();assert.equal(commits,0);finish[1]();await Promise.resolve();assert.equal(commits,1);});
test('runtime upgrade begins with a legal envelope and only the existing minimal marker',()=>{const {ledger,storage}=setup();const params={version:'0.167.1',confirmed:true};const envelope=ledger.begin(INSTANCE,'runtime/upgrade',params,{confirmed:true});assert.equal(envelope.method,'runtime/upgrade');assert.equal(envelope.requestId,`${INSTANCE}:${NOW}:${uuid(1)}`);assert.deepEqual(envelope.params,params);assert.equal(envelope.confirmed,true);const [marker]=ledger.values();assert.deepEqual(Object.keys(marker).sort(),['createdAt','method','requestId','serverInstance','status','threadId','turnId'].sort());assert.equal(marker.method,'runtime/upgrade');assert.equal(marker.threadId,null);assert.equal(marker.turnId,null);assert.equal(marker.status,'inFlight');const raw=[...storage.map.values()][0];assert.ok(raw.includes('runtime/upgrade'));for(const hidden of ['0.167.1','installedVersion','restartRequired','confirmed','path','payload'])assert.ok(!raw.includes(hidden),hidden);});
test('runtime upgrade reload keeps unknown and exposes no replay envelope',()=>{const {ledger,storage}=setup();const envelope=ledger.begin(INSTANCE,'runtime/upgrade',{version:'0.167.1',confirmed:true},{confirmed:true});const reloaded=new PendingMutations(storage);assert.equal(reloaded.blocked,true);const [marker]=reloaded.values();assert.equal(marker.requestId,envelope.requestId);assert.equal(marker.method,'runtime/upgrade');assert.equal(marker.status,'unknown');assert.equal(marker.restored,true);assert.equal(reloaded.envelope(envelope.requestId),null);});
test('runtime upgrade lookup requires strict stable SemVer and the explicit restart flag',()=>{const marker=makeMutation(INSTANCE,'runtime/upgrade',{version:'0.167.1',confirmed:true},{now:NOW,uuid:uuid(1)}).marker;const response={serverInstance:INSTANCE,method:'runtime/upgrade',state:'succeeded'};const decision=result=>lookupDecision(marker,{...response,result});assert.equal(decision({outcome:'succeeded',installedVersion:'0.167.1',restartRequired:true}),'succeeded');for(const result of [{outcome:'succeeded',installedVersion:'0.167.1'},{outcome:'succeeded',installedVersion:'0.167.1',restartRequired:false},{outcome:'succeeded',installedVersion:'0.167',restartRequired:true},{outcome:'succeeded',installedVersion:'v0.167.1',restartRequired:true},{outcome:'succeeded',installedVersion:'0.167.1-beta.1',restartRequired:true},{outcome:'succeeded',installedVersion:'0.167.1+build',restartRequired:true},{outcome:'succeeded',installedVersion:'01.167.1',restartRequired:true},{outcome:'unknown',installedVersion:'0.167.1',restartRequired:true},{}])assert.equal(decision(result),'unknown',JSON.stringify(result));assert.equal(decision({outcome:'not-executed'}),'notExecuted');assert.equal(decision({outcome:'notExecuted'}),'notExecuted');assert.equal(lookupDecision(marker,{...response,state:'pending'}),'pending');assert.equal(lookupDecision(marker,{serverInstance:OTHER,method:'runtime/upgrade',state:'succeeded',result:{outcome:'succeeded',installedVersion:'0.167.1',restartRequired:true}}),'unknown');});
const scopeMarker=(id,method,threadId=null)=>({requestId:`${INSTANCE}:${NOW}:${uuid(id)}`,method,serverInstance:INSTANCE,createdAt:NOW,threadId,turnId:null,status:'unknown'});
test('scope filtering never extends another conversation or later-operation lock to chat',()=>{
 const list=[scopeMarker(1,'runtime/upgrade'),scopeMarker(2,'remoteControl/enable'),scopeMarker(3,'git/apply'),scopeMarker(4,'turn/start','other'),scopeMarker(5,'turn/start','current'),scopeMarker(6,'turn/interrupt','current'),scopeMarker(7,'review/start','current'),scopeMarker(8,'thread/name/set','current'),scopeMarker(9,'thread/archive','other'),scopeMarker(10,'thread/start'),scopeMarker(11,'terminal/open'),scopeMarker(12,'config/apply'),scopeMarker(13,'plugin/apply'),scopeMarker(14,'account/start'),scopeMarker(15,'thread/fork','current'),scopeMarker(16,'thread/archive','current'),scopeMarker(17,'thread/unarchive','current')];
 const ids=(scope,options)=>pendingForScope(list,scope,options).map(row=>row.requestId);
 assert.deepEqual(ids('chat',{threadId:'current'}),[list[4].requestId,list[6].requestId]);
 assert.deepEqual(ids('chat'),[list[9].requestId]);
 assert.deepEqual(ids('thread',{threadId:'current'}),[list[6].requestId,list[7].requestId,list[14].requestId,list[15].requestId,list[16].requestId]);
 assert.deepEqual(ids('thread'),[list[9].requestId]);
 assert.deepEqual(ids('terminal'),[list[10].requestId]);
 assert.deepEqual(ids('remote'),[list[1].requestId]);
 assert.deepEqual(ids('git'),[list[2].requestId]);
 assert.deepEqual(ids('config'),[list[11].requestId]);
 assert.deepEqual(ids('plugin'),[list[12].requestId]);
 assert.deepEqual(ids('account'),[list[13].requestId]);
 assert.deepEqual(ids('runtime'),[list[0].requestId]);
 assert.throws(()=>pendingForScope(list,'everything'),/未知待确认操作范围/);
});
function timerHarness(){
 let next=1;const scheduled=[],cleared=[],receivers=[];
 const setTimeout=function(fn,ms){receivers.push(this);const entry={id:next++,fn,ms};scheduled.push(entry);return entry.id;};
 const clearTimeout=function(id){receivers.push(this);cleared.push(id);};
 return{scheduled,cleared,receivers,setTimeout,clearTimeout,last:()=>scheduled[scheduled.length-1]};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const activeMarker=()=>scopeMarker(1,'turn/start','current');
test('reconciler scans once on activation, then periodically without touching the ledger',async()=>{
 const records=[activeMarker()],before=structuredClone(records);let queries=0,results=0;const h=timerHarness();
 const reconciler=new PendingReconciler({records:()=>records,query:async marker=>{queries++;return{state:'pending',requestId:marker.requestId};},onResult:(marker,response)=>{results++;assert.equal(marker.requestId,records[0].requestId);assert.equal(response.state,'pending');},setTimeout:h.setTimeout,clearTimeout:h.clearTimeout});
 await reconciler.setActive(true);assert.equal(queries,1);assert.equal(results,1);assert.equal(h.last().ms,5000);assert.deepEqual(records,before);
 await h.last().fn();assert.equal(queries,2);assert.equal(results,2);assert.equal(h.last().ms,5000);
 reconciler.destroy();assert.ok(h.cleared.length>=1);assert.ok(h.receivers.every(receiver=>receiver===globalThis));
});
test('reconciler does not loop on empty records and refresh wakes it after ledger growth',async()=>{
 const records=[];let queries=0;const h=timerHarness();
 const reconciler=new PendingReconciler({records:()=>records,query:async()=>{queries++;return{state:'pending'};},onResult:()=>{},setTimeout:h.setTimeout,clearTimeout:h.clearTimeout});
 await reconciler.setActive(true);assert.equal(queries,0);assert.equal(h.scheduled.length,0);
 records.push(activeMarker());await reconciler.refresh();assert.equal(queries,1);assert.equal(h.last().ms,5000);
 await h.last().fn();assert.equal(queries,2);
 reconciler.destroy();
});
test('reconciler keeps at most two queries in flight and reads at most twenty per round',async()=>{
 const records=Array.from({length:5},(_,index)=>scopeMarker(index+1,'turn/start','current'));let active=0,max=0,calls=0;const waiting=[];const h=timerHarness();
 const reconciler=new PendingReconciler({records:()=>records,query:()=>{calls++;active++;max=Math.max(max,active);return new Promise(resolve=>waiting.push(()=>{active--;resolve({state:'pending'});}));},onResult:()=>{},setTimeout:h.setTimeout,clearTimeout:h.clearTimeout});
 const run=reconciler.setActive(true);await flush();assert.equal(active,2);assert.equal(calls,2);
 let guard=0;while(waiting.length&&guard++<20){waiting.shift()();await flush();}
 await run;assert.equal(max,2);assert.equal(calls,5);assert.equal(active,0);
 const many=Array.from({length:25},(_,index)=>scopeMarker(index+1,'turn/start','current'));let manyCalls=0;const h2=timerHarness();
 const capped=new PendingReconciler({records:()=>many,query:async()=>{manyCalls++;return{state:'pending'};},onResult:()=>{},setTimeout:h2.setTimeout,clearTimeout:h2.clearTimeout});
 await capped.setActive(true);assert.equal(manyCalls,20);assert.equal(h2.last().ms,5000);
 await h2.last().fn();assert.equal(manyCalls,40);
 reconciler.destroy();capped.destroy();
});
test('reconciler coalesces repeated refreshes while a round is running',async()=>{
 const records=[activeMarker()];let calls=0,resolveFirst;const h=timerHarness();
 const reconciler=new PendingReconciler({records:()=>records,query:()=>{calls++;if(calls===1)return new Promise(resolve=>{resolveFirst=resolve;});return Promise.resolve({state:'pending'});},onResult:()=>{},setTimeout:h.setTimeout,clearTimeout:h.clearTimeout});
 const run=reconciler.setActive(true);await flush();assert.equal(calls,1);
 const first=reconciler.refresh(),second=reconciler.refresh();assert.equal(calls,1);
 resolveFirst({state:'pending'});await run;await first;await second;await flush();assert.equal(calls,2);
 reconciler.destroy();
});
test('setActive(false) invalidates late results and reactivation uses a new generation',async()=>{
 const records=[activeMarker()];let calls=0,results=0,resolveQuery;const h=timerHarness();
 const reconciler=new PendingReconciler({records:()=>records,query:()=>{calls++;return new Promise(resolve=>{resolveQuery=resolve;});},onResult:()=>{results++;},setTimeout:h.setTimeout,clearTimeout:h.clearTimeout});
 const run=reconciler.setActive(true);await flush();assert.equal(calls,1);const firstGeneration=reconciler.generation;
 reconciler.setActive(false);assert.ok(reconciler.generation>firstGeneration);resolveQuery({state:'pending'});await run;assert.equal(results,0);
 const secondGeneration=reconciler.generation;const activation=reconciler.setActive(true);await flush();assert.ok(reconciler.generation>secondGeneration);assert.equal(calls,2);resolveQuery({state:'pending'});await activation;assert.equal(results,1);
 reconciler.destroy();
});
test('reconciler reports individual failures without stopping other records',async()=>{
 const records=[scopeMarker(1,'turn/start','current'),scopeMarker(2,'turn/start','current'),scopeMarker(3,'turn/start','current')];let results=0,errors=0;const h=timerHarness();
 const reconciler=new PendingReconciler({records:()=>records,query:async marker=>{if(marker.requestId===records[1].requestId)throw Error('one offline');return{state:'pending'};},onResult:()=>{results++;},onError:(marker,error)=>{errors++;assert.equal(marker.requestId,records[1].requestId);assert.match(error.message,/offline/);},setTimeout:h.setTimeout,clearTimeout:h.clearTimeout});
 await reconciler.setActive(true);assert.equal(results,2);assert.equal(errors,1);assert.equal(reconciler.failures,1);
 reconciler.destroy();
});
test('failed rounds back off exponentially to the cap and recover on success',async()=>{
 const records=[activeMarker()];let fail=true,calls=0,errors=0,results=0;const h=timerHarness();
 const reconciler=new PendingReconciler({records:()=>records,query:async()=>{calls++;if(fail)throw Error('offline');return{state:'pending'};},onResult:()=>{results++;},onError:()=>{errors++;},setTimeout:h.setTimeout,clearTimeout:h.clearTimeout});
 await reconciler.setActive(true);assert.equal(calls,1);assert.equal(errors,1);assert.equal(h.last().ms,5000);
 await h.last().fn();assert.equal(h.last().ms,10000);
 await h.last().fn();assert.equal(h.last().ms,20000);
 await h.last().fn();assert.equal(h.last().ms,30000);
 await h.last().fn();assert.equal(h.last().ms,30000);
 fail=false;await h.last().fn();assert.equal(calls,6);assert.equal(errors,5);assert.equal(results,1);assert.equal(h.last().ms,5000);
 assert.ok(h.receivers.every(receiver=>receiver===globalThis));
 reconciler.destroy();
});
test('reloaded unrelated unknowns remain durable while a current conversation can submit independently',()=>{
 const {ledger,storage}=setup();
 const runtime=ledger.begin(INSTANCE,'runtime/upgrade',{version:'0.167.1',confirmed:true});
 const other=ledger.begin(INSTANCE,'turn/start',{threadId:'other',input:[{type:'text',text:'private'}]});
 const restored=new PendingMutations(storage,{now:()=>NOW,uuid:()=>uuid(30)});
 assert.equal(restored.blocked,true,'global ledger still records unresolved operations');
 assert.deepEqual(pendingForScope(restored.values(),'chat',{threadId:'current'}),[]);
 assert.deepEqual(pendingForScope(restored.values(),'terminal'),[]);
 const own=restored.begin(INSTANCE,'turn/start',{threadId:'current',input:[{type:'text',text:'new'}]});
 assert.deepEqual(pendingForScope(restored.values(),'chat',{threadId:'current'}).map(row=>row.requestId),[own.requestId]);
 assert.equal(pendingForScope(restored.values(),'runtime')[0].requestId,runtime.requestId);
 assert.equal(restored.envelope(runtime.requestId),null);assert.equal(restored.envelope(other.requestId),null);
 assert.equal(new PendingMutations(storage).values().length,3,'new send cannot discard unrelated markers');
});
test('a confirmed result whose durable settlement fails remains visible and is retried only by lookup',async()=>{
 const {ledger,storage}=setup();const operation=ledger.begin(INSTANCE,'terminal/open',{cwd:'/private'});ledger.mark(operation.requestId,'unknown');
 const h=timerHarness();let queries=0,errors=0;const remove=storage.removeItem.bind(storage);storage.removeItem=()=>{throw Error('storage unavailable');};
 const reconciler=new PendingReconciler({records:()=>ledger.values(),query:async marker=>{queries++;assert.equal(marker.requestId,operation.requestId);return{serverInstance:INSTANCE,method:'terminal/open',state:'succeeded',result:{processId:'original'}};},onResult:(marker,response)=>{assert.equal(lookupDecision(marker,response),'succeeded');ledger.settle(marker.requestId);},onError:(marker,error)=>{errors++;assert.equal(marker.requestId,operation.requestId);assert.match(error.message,/保存/);},setTimeout:h.setTimeout,clearTimeout:h.clearTimeout});
 await reconciler.setActive(true);assert.equal(errors,1);assert.equal(queries,1);assert.equal(ledger.values().length,1);assert.equal(new PendingMutations(storage).values().length,1);
 storage.removeItem=remove;await h.last().fn();assert.equal(queries,2);assert.equal(ledger.values().length,0);assert.equal(new PendingMutations(storage).values().length,0);reconciler.destroy();
});
test('reactivation during an old in-flight lookup drops its result and starts a current generation',async()=>{
 const h=timerHarness(),resolvers=[];let calls=0;const seen=[];
 const reconciler=new PendingReconciler({records:()=>[activeMarker()],query:()=>{calls++;return new Promise(resolve=>resolvers.push(resolve));},onResult:(marker,response)=>seen.push(response.generation),setTimeout:h.setTimeout,clearTimeout:h.clearTimeout});
 const old=reconciler.setActive(true);await flush();reconciler.setActive(false);reconciler.setActive(true);assert.equal(calls,1,'old request is allowed to finish without starting overlapping rounds');
 resolvers.shift()({generation:'old'});await old;await flush();assert.equal(calls,2);assert.deepEqual(seen,[],'stale success must not settle a live marker');
 resolvers.shift()({generation:'current'});await flush();assert.deepEqual(seen,['current']);reconciler.destroy();
});

test('steer and compact are durable chat mutations; steer carries the attachment envelope, compact cannot', () => {
  const ids = ['00000000-0000-4000-8000-0000000000a1'];
  const steer = makeMutation(INSTANCE, 'turn/steer', { threadId: 't', expectedTurnId: 'turn', input: [{ type: 'text', text: 'x', text_elements: [] }] }, { now: NOW, uuid: '00000000-0000-4000-8000-0000000000b1', attachmentIds: ids, fileAttachmentIds: [] });
  assert.deepEqual(steer.envelope.attachmentIds, ids); assert.equal(steer.marker.threadId, 't'); assert.deepEqual(Object.keys(steer.envelope.params).sort(), ['expectedTurnId', 'input', 'threadId']);
  const compact = makeMutation(INSTANCE, 'thread/compact/start', { threadId: 't' }, { now: NOW, uuid: '00000000-0000-4000-8000-0000000000b2' });
  assert.equal(compact.marker.method, 'thread/compact/start');
  assert.throws(() => makeMutation(INSTANCE, 'thread/compact/start', { threadId: 't' }, { now: NOW, uuid: '00000000-0000-4000-8000-0000000000b3', attachmentIds: ids }), /附件/);
  const records = [{ method: 'turn/steer', threadId: 't', status: 'unknown' }, { method: 'thread/compact/start', threadId: 't', status: 'unknown' }, { method: 'turn/steer', threadId: 'other', status: 'unknown' }];
  assert.equal(pendingForScope(records, 'chat', { threadId: 't' }).length, 2);
  assert.equal(pendingForScope(records, 'chat', { threadId: null }).length, 0, 'a draft is not blocked by another thread');
  assert.deepEqual(restoreMarkers(serializeMarkers([steer.marker, compact.marker])).map(row => row.method), ['turn/steer', 'thread/compact/start']);
});
