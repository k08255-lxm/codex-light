import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EngineSetupStore,EngineOnboarding} from '../src/engine-onboarding.mjs';
import {engineSetupDecision} from '../public/engine-onboarding.js';
const native={available:true,version:'1.0.0'}, wsl={available:true,user:'lee',codexPath:'/bin/codex'};
async function setup(t,options={}){const root=await mkdtemp(path.join(os.tmpdir(),'engine-first-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const saves=[];const service=new EngineOnboarding({store:new EngineSetupStore(root),nativeCandidate:async()=>native,listDistributions:async()=>[],probeDistribution:async()=>wsl,saveSelection:async s=>{saves.push(s);return {restartRequired:s.target==='wsl'};},...options});await service.initialize();return {service,root,saves};}
test('one Windows environment is selected automatically, never split by CLI source',async t=>{const x=await setup(t);const s=await x.service.inventory();assert.equal(s.candidates.length,1);assert.equal(engineSetupDecision(s).kind,'automatic');const done=await x.service.complete({id:'native',automatic:true});assert.equal(done.completed,true);assert.deepEqual(x.saves,[{target:'native'}]);});
test('old users preserve choice without probing or prompting',async t=>{const x=await setup(t);await writeFile(path.join(x.root,'state.json'),'{}');await x.service.initialize();assert.equal(x.service.required,false);assert.equal((await x.service.inventory()).candidates.length,0);assert.equal(JSON.parse(await readFile(path.join(x.root,'engine-setup.json'))).state,'legacy');});
test('completion and later persist across app restarts',async t=>{const x=await setup(t);await x.service.complete({defer:true});const other=new EngineOnboarding({store:new EngineSetupStore(x.root)});await other.initialize();assert.equal(other.required,false);assert.deepEqual(x.saves,[]);});
test('WSL names only do not start distros; explicit discovery makes multiple choice',async t=>{let probes=0;const x=await setup(t,{listDistributions:async()=>['Ubuntu'],probeDistribution:async()=>{probes++;return wsl;}});const s=await x.service.inventory();assert.equal(probes,0);assert.equal(engineSetupDecision(s).kind,'discover');await assert.rejects(x.service.complete({id:'native',automatic:true}));const d=await x.service.discover();assert.equal(probes,1);assert.equal(engineSetupDecision(d).kind,'choose');assert.equal((await x.service.complete({id:'wsl:Ubuntu'})).restartRequired,true);});
test('only WSL automatically chosen after user-initiated probe',async t=>{const x=await setup(t,{nativeCandidate:async()=>null,listDistributions:async()=>['Ubuntu']});await x.service.inventory();const d=await x.service.discover();assert.equal(engineSetupDecision(d).candidate.id,'wsl:Ubuntu');await x.service.complete({id:'wsl:Ubuntu',automatic:true});assert.equal(x.saves.length,1);});
test('timeout is unresolved not absent; cannot automatically select remaining native',async t=>{const x=await setup(t,{listDistributions:async()=>['Ubuntu'],probeDistribution:async()=>{throw Error('ETIMEDOUT');}});await x.service.inventory();const d=await x.service.discover();assert.equal(d.discoveryPending,true);await assert.rejects(x.service.complete({id:'native',automatic:true}));assert.equal(x.saves.length,0);});
test('no engine leads to installation/configuration, not saved success',async t=>{const x=await setup(t,{nativeCandidate:async()=>null});assert.equal(engineSetupDecision(await x.service.inventory()).kind,'missing');await assert.rejects(x.service.complete({id:'native'}));assert.equal(x.service.required,true);});
test('active task prevents mutation',async t=>{const x=await setup(t,{busy:()=>true});await x.service.inventory();await assert.rejects(x.service.complete({id:'native'}),/当前任务/);assert.deepEqual(x.saves,[]);});
test('repeated save rejected while first pending; failure does not mark done',async t=>{let reject;const x=await setup(t,{saveSelection:()=>new Promise((_,r)=>reject=r)});await x.service.inventory();const pending=x.service.complete({id:'native'});await Promise.resolve();await assert.rejects(x.service.complete({id:'native'}),/稍候/);reject(Error('failed'));await assert.rejects(pending);assert.equal(await x.service.store.read(),null);assert.equal(x.service.required,true);});
test('unsupported and corrupted persistence never reset selection',async t=>{const x=await setup(t,{supported:false});assert.equal((await x.service.inventory()).needed,false);await writeFile(path.join(x.root,'engine-setup.json'),'broken');await assert.rejects(new EngineSetupStore(x.root).read());});
test('incomplete native probe cannot auto-select WSL as only engine',async t=>{const x=await setup(t,{nativeCandidate:async()=>{throw Error('timeout');},listDistributions:async()=>['Ubuntu']});await x.service.inventory();const d=await x.service.discover();assert.equal(d.discoveryPending,true);await assert.rejects(x.service.complete({id:'wsl:Ubuntu',automatic:true}));});

test('list failure after prior known inventory prevents automatic selection',async t=>{let fail=false;const x=await setup(t,{listDistributions:async()=>{if(fail)throw Error('offline');return [];}});await x.service.inventory();fail=true;const state=await x.service.discover();assert.equal(state.discoveryPending,true);await assert.rejects(x.service.complete({id:'native',automatic:true}));});

test('onboarding auto-detects running WSL and waits for choice when Windows is also ready',async t=>{
 const x=await setup(t,{discoverRunning:async()=>({candidates:[{distribution:'Ubuntu',...wsl}],pendingDistributions:[],discoveryIncomplete:false}),probeDistribution:async()=>assert.fail('manual probe should not run')});
 const s=await x.service.inventory();assert.equal(engineSetupDecision(s).kind,'choose');
 assert.deepEqual(s.candidates.map(c=>c.id),['native','wsl:Ubuntu']);
 assert.deepEqual(x.saves,[]);
 await assert.rejects(x.service.complete({id:'native',automatic:true}));
});
test('stopped distro or unknown runtime does not trigger an automatic choice',async t=>{
 const x=await setup(t,{discoverRunning:async()=>({candidates:[{distribution:'Debian',available:false,probePending:true}],pendingDistributions:['Debian'],discoveryIncomplete:false})});
 const s=await x.service.inventory();assert.equal(engineSetupDecision(s).kind,'discover');
 await assert.rejects(x.service.complete({id:'native',automatic:true}));assert.deepEqual(x.saves,[]);
});
