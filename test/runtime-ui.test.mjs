import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {lookupDecision} from '../public/submissions.js';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const marker={requestId:'a'.repeat(32)+':1:123e4567-e89b-12d3-a456-426614174000',method:'runtime/upgrade',serverInstance:'a'.repeat(32)};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
function between(start,end){const begin=app.indexOf(start),finish=app.indexOf(end,begin);assert.ok(begin>=0&&finish>begin,`missing source boundary ${start}`);return app.slice(begin,finish);}

test('runtime mounting wires only fixed local, registry and mutation adapters',async()=>{
 const runtimeAt=html.indexOf('id="runtime-panel"');assert.ok(runtimeAt>html.indexOf('id="command-info"'));assert.ok(runtimeAt<html.indexOf('id="settings-dsh-heading"'));assert.equal((html.match(/id="runtime-panel"/g)||[]).length,1);
 const source=between('function createRuntimePanel()','runtimePanel=createRuntimePanel()');let options;const root={},calls=[],query=()=>{},recovered=()=>{};
 const create=new Function('mountRuntimePanel','$','api','performMutation','queryRuntimePending','clearRuntimePendingAfterRecovery',`${source};return createRuntimePanel;`)((container,callbacks)=>{assert.equal(container,root);options=callbacks;return{};},id=>{assert.equal(id,'runtime-panel');return root;},(...args)=>calls.push(['api',...args]),(...args)=>calls.push(['mutation',...args]),query,recovered);
 create();assert.deepEqual(calls,[]);options.read();options.check();options.upgrade({version:'0.167.1',confirmed:true});
 assert.deepEqual(calls,[['api','/api/runtime/status',{}],['api','/api/runtime/check',{}],['mutation','runtime/upgrade',{version:'0.167.1',confirmed:true}]]);assert.equal(options.queryPending,query);assert.equal(options.onRecovered,recovered);
 assert.match(app,/runtimePanel\.reset\(\{pending:!!runtimePendingMarker\(\)\}\)/);assert.match(app,/function resetRuntimePanel\(\)\{runtimePanel\?\.setActive\?\.\(false\);runtimePanel\?\.reset\(\{pending:!!runtimePendingMarker\(\)\}\);\}/);
});

test('runtime activity follows connection, settings page, dialog visibility and document visibility',()=>{
 const source=between('function runtimePanelShouldBeActive()','function pendingLedgerSignature()');const state={connected:true,settingsPage:'general'},document={visibilityState:'visible'};let hidden=false;const active=[];
 const sync=new Function('state','document','$','runtimePanel',`${source};return syncRuntimePanelActivity;`)(state,document,()=>({classList:{contains:()=>hidden}}),{setActive:value=>active.push(value)});
 sync();state.connected=false;sync();state.connected=true;state.settingsPage='account';sync();state.settingsPage='general';hidden=true;sync();hidden=false;document.visibilityState='hidden';sync();document.visibilityState='visible';sync();assert.deepEqual(active,[true,false,false,false,false,true]);
 assert.match(app,/visibilitychange[\s\S]*syncRuntimePanelActivity\(\)/);
});

test('runtime upgrade has a 31 minute transport timeout and validates operation outcomes',()=>{
 assert.match(app,/async function api\(path, body, \{timeoutMs=90000\}=\{\}\)/);assert.match(app,/setTimeout\(\(\) => controller\.abort\(\), timeoutMs\)/);
 assert.match(app,/await api\('\/api\/runtime\/upgrade',\{\.\.\.envelope\.params,requestId:envelope\.requestId\},\{timeoutMs:1860000\}\)/);
 assert.match(app,/decision=marker\?lookupDecision\(marker,\{serverInstance:state\.serverInstance,method,state:'succeeded',result\}\):'unknown'/);assert.match(app,/pendingMutations\.mark\(envelope\.requestId,'unknown'\)/);
});

function pendingHarness(){
 const source=between('// runtime-pending:start','// runtime-pending:end');const calls=[],settled=[],marked=[];const state={connected:true,serverInstance:marker.serverInstance};let currentMarker=marker,response={state:'pending',serverInstance:marker.serverInstance,method:marker.method},ledgerChanges=0;
 const pendingMutations={settle:id=>settled.push(id),mark:(...args)=>marked.push(args)};
 const recovery=between('function clearRuntimePendingAfterRecovery()','function createRuntimePanel()');
 const code=`let pendingReadGeneration=0,pendingReconcilerSignature='';const runtimeRecoveryCandidates=new Map();${source};${recovery};return {query:queryRuntimePending,recover:clearRuntimePendingAfterRecovery,invalidate(){pendingReadGeneration++;}};`;
 const adapter=new Function('runtimePendingMarker','api','lookupDecision','pendingMutations','noteLedgerChanged','renderPendingMutations','updateControls','state','pendingMarkerExists','pendingLedgerSignature','scopedPending','pendingReconcileErrors',code)(()=>currentMarker,async(...args)=>{calls.push(args);return await response;},lookupDecision,pendingMutations,()=>ledgerChanges++,()=>{},()=>{},state,value=>currentMarker?.requestId===value.requestId,()=>'',()=>currentMarker?[currentMarker]:[],new Map());
 return{...adapter,state,calls,settled,marked,get ledgerChanges(){return ledgerChanges;},set response(value){response=value;},set marker(value){currentMarker=value;}};
}

test('runtime lookup settles validated receipts while pending cannot be cleared by a version read',async()=>{
 const x=pendingHarness();assert.deepEqual(await x.query(),{outcome:'pending'});assert.deepEqual(x.settled,[]);assert.deepEqual(x.marked,[[marker.requestId,'pending']]);assert.deepEqual(x.calls,[['/api/operations?requestId='+encodeURIComponent(marker.requestId)]]);
 x.response={state:'succeeded',serverInstance:marker.serverInstance,method:marker.method,result:{outcome:'succeeded',installedVersion:'0.167.1',restartRequired:true}};assert.equal((await x.query()).installedVersion,'0.167.1');assert.deepEqual(x.settled,[marker.requestId]);
 x.response={state:'succeeded',serverInstance:marker.serverInstance,method:marker.method,result:{outcome:'not-executed'}};assert.deepEqual(await x.query(),{outcome:'not-executed'});assert.equal(x.settled.length,2);
});

test('runtime lookup retains malformed success and tolerates an absent local marker without manual confirmation',async()=>{
 const x=pendingHarness();x.response={state:'succeeded',serverInstance:marker.serverInstance,method:marker.method,result:{outcome:'succeeded',installedVersion:'0.167.1',restartRequired:false}};assert.deepEqual(await x.query(),{outcome:'unknown'});assert.deepEqual(x.settled,[]);assert.deepEqual(x.marked,[[marker.requestId,'unknown']]);x.recover();assert.deepEqual(x.settled,[marker.requestId],'a malformed terminal receipt can release only its local marker after a real version read');
 x.marker=null;const count=x.calls.length;assert.deepEqual(await x.query(),{outcome:'unknown'});assert.equal(x.calls.length,count);
});

test('runtime lookup cannot mutate pending state after disconnect, new generation, instance change or marker removal',async()=>{
 for(const invalidate of [x=>x.invalidate(),x=>{x.state.connected=false;},x=>{x.state.serverInstance='b'.repeat(32);},x=>{x.marker=null;}]){
  const x=pendingHarness(),response=deferred();x.response=response.promise;const pending=x.query();invalidate(x);response.resolve({state:'succeeded',serverInstance:marker.serverInstance,method:marker.method,result:{outcome:'succeeded',installedVersion:'0.167.1',restartRequired:true}});assert.deepEqual(await pending,{outcome:'unknown'});assert.deepEqual(x.settled,[]);assert.deepEqual(x.marked,[]);assert.equal(x.ledgerChanges,0);
 }
});

test('runtime recovery has no manual acknowledgement action and no generic chat lock',()=>{
 assert.doesNotMatch(app,/仅清除本地待核对记录|acknowledgeObservedMutation/);
 const render=between('function renderPendingMutations()','async function performMutation');assert.match(render,/const records=chatPendingRecords\(\)/);assert.doesNotMatch(render,/runtime\/upgrade/);
});


test('a registered terminal unknown alone can clear its local marker after a version read',async()=>{
 const x=pendingHarness();x.response={state:'succeeded',serverInstance:marker.serverInstance,method:marker.method,result:{outcome:'unknown'}};assert.deepEqual(await x.query(),{outcome:'unknown'});x.recover();assert.deepEqual(x.settled,[marker.requestId]);
});

test('old-instance runtime marker recovers from local read, but a stale recovery generation cannot clear it',async()=>{
 const x=pendingHarness();x.marker={...marker,serverInstance:'b'.repeat(32)};assert.deepEqual(await x.query(),{outcome:'unknown'});x.recover();assert.deepEqual(x.settled,[marker.requestId]);
 const y=pendingHarness();y.marker={...marker,serverInstance:'b'.repeat(32)};await y.query();y.invalidate();y.recover();assert.deepEqual(y.settled,[]);
});


test('unregistered or unrelated runtime lookup responses remain pending until a matching terminal response',async()=>{
 for(const response of [{state:'notFound',serverInstance:marker.serverInstance},{state:'succeeded',serverInstance:marker.serverInstance,method:'turn/start',result:{outcome:'unknown'}},{state:'pending',serverInstance:marker.serverInstance,method:marker.method},{state:'succeeded',serverInstance:'b'.repeat(32),method:marker.method,result:{outcome:'unknown'}}]){const x=pendingHarness();x.response=response;assert.deepEqual(await x.query(),{outcome:'pending'});x.recover();assert.deepEqual(x.settled,[]);}
});
