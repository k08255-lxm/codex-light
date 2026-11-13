import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PendingMutations,lookupDecision,outcomeFromError,pendingForScope,makeMutation,serializeMarkers,restoreMarkers} from '../public/submissions.js';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const apiSource=source.slice(source.indexOf('async function api('),source.indexOf('const rpc ='));
const mutationSource=source.slice(source.indexOf('async function performMutation('),source.indexOf('// ---------- Composer:'));
const adapterSource=source.slice(source.indexOf('const aboutView = mountAbout('),source.indexOf('// Local-only:',source.indexOf('const aboutView = mountAbout(')));
const instance='b'.repeat(32);
const noop=()=>{};
function dependencies(fn,deps){const names=Object.keys(deps);return new Function(...names,fn)(...names.map(name=>deps[name]));}
function harness(api){
 const values=new Map();const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
 const pendingMutations=new PendingMutations(storage);
 const performMutation=dependencies(mutationSource+'\nreturn performMutation;',{pendingMutations,state:{serverInstance:instance,openGeneration:0},mutationContexts:new Map(),renderPendingMutations:noop,updateControls:noop,api,lookupDecision,outcomeFromError,noteLedgerChanged:noop,notice:noop});
 const adapter=dependencies(adapterSource+'\nreturn aboutView;',{mountAbout:(_host,options)=>options,$:noop,api,pendingMutations,scopedPending:scope=>pendingForScope(pendingMutations.values(),scope),performMutation});
 return {pendingMutations,performMutation,adapter,storage};
}

test('actual api accepts HTTP 200 app-update status with a failed-state error field',async()=>{
 const result={currentVersion:'0.4.0',phase:'failed',error:'安装包 SHA256 校验失败'};
 const api=dependencies(apiSource+'\nreturn api;',{token:'fixture-only-token',access:{lan:false},fetch:async()=>new Response(JSON.stringify(result)),state:{},$:noop,notice:noop});
 assert.deepEqual(await api('/api/app-update/status',{}),result);
 await assert.rejects(api('/api/app-update/check',{}),/SHA256/);
});
test('actual About adapter gates concurrent install and corrupted markers before a second mutation',async()=>{
 const requests=[];let finish;
 const h=harness((url,body,options)=>{requests.push({url,body,options});return new Promise(resolve=>finish=resolve);});
 const first=h.adapter.mutate('app-update/install',{version:'0.4.0',confirmed:true});
 assert.equal(h.pendingMutations.values().length,1);
 assert.throws(()=>h.adapter.mutate('app-update/install',{version:'0.4.0',confirmed:true}),error=>error.outcome==='notExecuted');
 assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/app-update/install');assert.equal(requests[0].options.timeoutMs,60000);assert.ok(requests[0].body.requestId);
 finish({currentVersion:'0.3.0',phase:'launched',preparedVersion:'0.4.0'});await first;assert.equal(h.pendingMutations.values().length,0);
 h.pendingMutations.storageError='broken storage';assert.throws(()=>h.adapter.mutate('app-update/download',{version:'0.4.0'}),error=>error.outcome==='notExecuted');assert.equal(requests.length,1);
});
test('actual performMutation never settles an HTTP 200 uncertain or mismatched-version update result',async()=>{
 for(const [method,result] of [
  ['app-update/install',{phase:'launchUnknown',preparedVersion:'0.4.0'}],
  ['app-update/install',{phase:'launched',preparedVersion:'0.5.0'}],
  ['app-update/download',{phase:'ready',preparedVersion:'0.5.0'}],
 ]){
  let requests=0;const h=harness(async()=>{requests++;return {currentVersion:'0.3.0',...result};});
  await assert.rejects(h.adapter.mutate(method,{version:'0.4.0',...(method.endsWith('install')?{confirmed:true}:{})}),error=>error.outcome==='unknown');
  const [marker]=h.pendingMutations.values();assert.equal(marker.status,'unknown');assert.equal(marker.appVersion,'0.4.0');
  assert.throws(()=>h.adapter.mutate(method,{version:'0.4.0'}),error=>error.outcome==='notExecuted');assert.equal(requests,1);
 }
});
test('download success is correlated to its persisted requested version, including after reload',async()=>{
 const requests=[];const h=harness(async(url,body,options)=>{requests.push({url,body,options});return {currentVersion:'0.3.0',phase:'ready',preparedVersion:'0.4.0'};});
 await h.adapter.mutate('app-update/download',{version:'0.4.0'});assert.equal(h.pendingMutations.values().length,0);assert.equal(requests[0].options.timeoutMs,960000);
 const {marker}=makeMutation(instance,'app-update/download',{version:'0.4.0'});const [restored]=restoreMarkers(serializeMarkers([marker]));assert.equal(restored.appVersion,'0.4.0');
 const response={serverInstance:instance,method:'app-update/download',state:'succeeded',result:{phase:'ready',preparedVersion:'0.4.0'}};
 assert.equal(lookupDecision(restored,response),'succeeded');assert.equal(lookupDecision({...restored,appVersion:'0.5.0'},response),'unknown');assert.equal(lookupDecision({...restored,appVersion:undefined},response),'unknown');
 const corrupt=JSON.parse(serializeMarkers([marker]));corrupt[0].appVersion='../0.4.0';assert.throws(()=>restoreMarkers(JSON.stringify(corrupt)),/版本/);
});
