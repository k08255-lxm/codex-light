import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {createServer} from '../src/server.mjs';import {DemoClient} from '../src/demo.mjs';import {WslSelectionStore} from '../src/wsl-runtime.mjs';
async function fixture(t,{legacy=false,native=true,names=[],auto}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'codecang-engine-http-'));let probes=0,nativeReads=0;
 if(legacy)await writeFile(path.join(root,'wsl-runtime.json'),'null');
 const service={platform:'win32',distributions:async()=>names,probe:async({distribution})=>{probes++;return {distribution,user:'lee',home:'/home/lee',codexHome:'/home/lee/.codex',codexPath:'/usr/bin/codex',available:true};}};
 if(auto)service.discoverRunning=auto;
 const store=new WslSelectionStore({root});const app=await createServer({client:new DemoClient(),desktop:true,desktopStateRoot:root,wslRuntimeService:service,wslSelectionStore:store,engineNativeCandidate:async()=>{nativeReads++;return native?{available:true,version:'1.0.0'}:null;},projectsRoot:path.join(root,'projects'),statisticsRoot:path.join(root,'stats'),fileAttachmentRoot:path.join(root,'attachments')});await app.started;
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const post=(action,data={})=>fetch(app.origin+'/api/runtime/onboarding/'+action,{method:'POST',headers:{Authorization:`Bearer ${app.token}`,'Content-Type':'application/json'},body:JSON.stringify(data)});
 return {root,app,store,service,post,counts:()=>({probes,nativeReads})};
}
test('first-run can auto-select verified native without probing WSL',async t=>{const f=await fixture(t);const state=await(await f.post('status')).json();assert.equal(state.needed,true);assert.equal(state.candidates.length,1);assert.equal(f.counts().probes,0);const r=await f.post('complete',{id:'native',automatic:true});assert.equal(r.status,200);assert.equal((await r.json()).restartRequired,false);assert.equal(f.counts().nativeReads,2);assert.equal(JSON.parse(await readFile(path.join(f.root,'engine-setup.json'),'utf8')).state,'complete');});
test('legacy selection bypasses first run and inventory',async t=>{const f=await fixture(t,{legacy:true});assert.equal((await(await f.post('status')).json()).needed,false);assert.deepEqual(f.counts(),{probes:0,nativeReads:0});});
test('explicit WSL discovery enables unique choice with restart',async t=>{const f=await fixture(t,{native:false,names:['Ubuntu']});let s=await(await f.post('status')).json();assert.equal(s.discoveryPending,true);assert.equal(f.counts().probes,0);s=await(await f.post('discover')).json();assert.equal(s.candidates.length,1);const r=await f.post('complete',{id:'wsl:Ubuntu',automatic:true});assert.equal(r.status,200);assert.equal((await r.json()).restartRequired,true);assert.equal((await f.store.read()).distribution,'Ubuntu');assert.equal(f.counts().probes,2);});
test('onboarding rejects unknown payload and unauthenticated save',async t=>{const f=await fixture(t);assert.equal((await f.post('status',{force:true})).status,400);assert.equal((await fetch(f.app.origin+'/api/runtime/onboarding/complete',{method:'POST',body:'{}'})).status,401);assert.equal((await f.post('complete',{id:'native',force:true})).status,400);});

test('WSL selection rechecks busy after asynchronous probe',async t=>{const f=await fixture(t,{names:['Ubuntu']});let release;f.service.probe=()=>new Promise(r=>release=r);const pending=fetch(f.app.origin+'/api/runtime/wsl/select',{method:'POST',headers:{Authorization:`Bearer ${f.app.token}`,'Content-Type':'application/json'},body:JSON.stringify({target:'wsl',distribution:'Ubuntu'})});while(!release)await new Promise(r=>setTimeout(r,5));f.app.sessions.queues.set('busy',Promise.resolve());release({distribution:'Ubuntu',user:'lee',available:true});const response=await pending;assert.equal(response.status,400);assert.equal((await response.json()).code,'RUNTIME_BUSY');assert.equal(await f.store.read(),null);f.app.sessions.queues.delete('busy');});

test('automatic running-only endpoint reports options but does not write selection',async t=>{
 const f=await fixture(t,{auto:async()=>({available:true,candidates:[{distribution:'Ubuntu',user:'lee',codexPath:'/usr/bin/codex',available:true,passiveProbe:true}],pendingDistributions:[],discoveryIncomplete:false})});
 const setup=await(await f.post('status')).json();
 assert.equal(setup.candidates.length,2);
 assert.equal(setup.candidates[1].selection.codexPath,undefined,'passive path is not pinned during selection');
 const endpoint=f.app.origin+'/api/runtime/wsl/discover-running';
 const request=token=>fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}'});
 assert.equal((await request('invalid')).status,401);
 const state=await(await request(f.app.token)).json();
 assert.equal(state.candidates[0].distribution,'Ubuntu');assert.equal(state.current.target,'native');assert.equal(state.selected.target,'native');
 assert.equal(await f.store.read(),null);
 assert.equal(f.counts().probes,0);
});
