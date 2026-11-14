import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
import {WslSelectionStore} from '../src/wsl-runtime.mjs';

const candidate={distribution:'Ubuntu',user:'lee',home:'/home/lee',codexHome:'/home/lee/.codex',codexPath:'/usr/bin/codex',available:true};
async function fixture(t,selected=null,probeCandidate=candidate){
 const root=await mkdtemp(path.join(os.tmpdir(),'codecang wsl http-'));const store=new WslSelectionStore({root});await store.save(selected);
 const calls=[];const service={platform:'win32',probe:async input=>{calls.push(input);return {...probeCandidate,...input};},launch:()=>({command:'never-run',args:[],cwd:os.tmpdir()}),discover:async()=>{calls.push('discover');return {available:true,candidates:[probeCandidate]};},toLinux:async p=>p};
 const client=new DemoClient();const app=await createServer({client,wslRuntimeService:service,wslSelectionStore:store,statisticsRoot:path.join(root,'stats'),projectsRoot:path.join(root,'projects'),fileAttachmentRoot:path.join(root,'attachments')});await app.started;
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});return {app,store,calls,service};
}
const post=(app,url,data={})=>fetch(app.origin+url,{method:'POST',headers:{Authorization:`Bearer ${app.token}`,'Content-Type':'application/json'},body:JSON.stringify(data)});
test('WSL status is inert; explicit discovery and selection are separate; selection does not hot-switch',async t=>{
 const {app,store,calls}=await fixture(t);let response=await post(app,'/api/runtime/wsl/status');let status=await response.json();assert.equal(status.current.target,'native');assert.equal(status.selected.target,'native');assert.equal(calls.length,0);
 response=await post(app,'/api/runtime/wsl/discover');assert.equal((await response.json()).candidates[0].distribution,'Ubuntu');assert.deepEqual(calls,['discover']);
 response=await post(app,'/api/runtime/wsl/select',{target:'wsl',distribution:'Ubuntu',user:'lee'});status=await response.json();assert.equal(status.current.target,'native');assert.equal(status.selected.target,'wsl');assert.equal(status.restartRequired,true);assert.deepEqual(await store.read(),{distribution:'Ubuntu',user:'lee'});
 response=await post(app,'/api/runtime/wsl/select',{target:'native'});assert.equal((await response.json()).restartRequired,false);assert.equal(await store.read(),null);
});
test('WSL selector rejects unauthenticated/cross-origin requests and invalid payloads without saving',async t=>{
 const {app,store}=await fixture(t);
 assert.equal((await fetch(app.origin+'/api/runtime/wsl/select',{method:'POST',body:JSON.stringify({target:'wsl',distribution:'Ubuntu'})})).status,401);
 assert.equal((await fetch(app.origin+'/api/runtime/wsl/select',{method:'POST',headers:{Authorization:`Bearer ${app.token}`,Origin:'https://other.invalid'},body:'{}'})).status,403);
 for(const value of [{target:'native',distribution:'Ubuntu'},{target:'bad'},{target:'wsl',distribution:'Ubuntu',extra:'x'}])assert.equal((await post(app,'/api/runtime/wsl/select',value)).status,400);
 assert.equal(await store.read(),null);
});
test('WSL current target and unsupported native actions are explicit',async t=>{
 const {app}=await fixture(t,{distribution:'Ubuntu',user:'lee'});
 const status=await (await fetch(app.origin+'/api/status',{headers:{Authorization:`Bearer ${app.token}`}})).json();assert.equal(status.runtimeTarget,'wsl');assert.ok(status.runtimeUnsupported.includes('git'));
 for(const url of ['/api/git/read','/api/git/plan','/api/git/apply','/api/dsh/config-sources/status']){const result=await post(app,url);assert.equal(result.status,409);assert.equal((await result.json()).code,'WSL_UNSUPPORTED');}
 const connection=await (await post(app,'/api/dsh/connection/status')).json();assert.equal(connection.selectionRequired,true);assert.ok(connection.modes.includes('windows'));
 const runtime=await (await post(app,'/api/runtime/status')).json();assert.equal(runtime.current.source,'wsl');assert.equal(runtime.canUpgrade,false);
 assert.equal((await post(app,'/api/runtime/upgrade')).status,400);
 const selection=await (await post(app,'/api/runtime/wsl/status')).json();assert.equal(selection.restartRequired,false);assert.equal(selection.current.user,'lee');
});
test('manual Linux CLI selection is persisted without rewriting Codex configuration',async t=>{
 const {app,store,calls}=await fixture(t);const codexPath='/home/lee/.nvm/versions/node/v24/bin/codex';
 const response=await post(app,'/api/runtime/wsl/select',{target:'wsl',distribution:'Ubuntu',codexPath});assert.equal(response.status,200);assert.equal((await response.json()).selected.codexPath,codexPath);assert.equal((await store.read()).codexPath,codexPath);assert.equal(calls.at(-1).codexPath,codexPath);
 assert.equal((await post(app,'/api/runtime/wsl/select',{target:'wsl',distribution:'Ubuntu',codexPath:0})).status,400);
});
test('WSL file attachment reference is converted before generated text while user text is unchanged',async t=>{
 const {app,service}=await fixture(t,{distribution:'Ubuntu',user:'lee'});let mappedFrom;
 service.toLinux=async value=>{mappedFrom=value;return '/custom mount/fixture/attachment.txt';};
 const upload=await fetch(app.origin+'/api/file-uploads',{method:'POST',headers:{Authorization:`Bearer ${app.token}`,'X-Filename':'note with spaces.txt','X-File-Mime':'text/plain'},body:'synthetic private fixture'});assert.equal(upload.status,200);const file=await upload.json();
 let seq=0;const rpc=body=>post(app,'/api/rpc',{...body,requestId:`${app.operations.serverInstance}:${Date.now()}:wsl-attach-${++seq}`});
 const threadResponse=await rpc({method:'thread/start',params:{cwd:process.cwd(),approvalPolicy:'on-request',sandbox:'workspace-write'}});assert.equal(threadResponse.status,200);const {thread}=await threadResponse.json();
 const response=await rpc({method:'turn/start',params:{threadId:thread.id,cwd:process.cwd(),input:[{type:'text',text:'Keep C:\\example exactly'}]},fileAttachmentIds:[file.id]});assert.equal(response.status,200,await response.text());
 assert.ok(mappedFrom.includes('codecang wsl http-'));const content=app.rpc.items.get(thread.id)[0].item.content;assert.equal(content[0].text,'Keep C:\\example exactly');assert.ok(content[1].text.includes('/custom mount/fixture/attachment.txt'));assert.ok(!content[1].text.includes(mappedFrom));
});
test('unrepresentable WSL home never prevents opening settings or switching back to native',async t=>{
 const {app,store}=await fixture(t,{distribution:'Ubuntu',user:'lee'},{...candidate,codexHome:'/home/lee/.codex/.'});
 const status=await (await fetch(app.origin+'/api/status',{headers:{Authorization:`Bearer ${app.token}`}})).json();assert.equal(status.connected,false);assert.equal(status.runtimeTarget,'wsl');assert.match(status.error,/path/i);
 const runtime=await post(app,'/api/runtime/wsl/status');assert.equal(runtime.status,200);assert.equal((await runtime.json()).canSelect,true);
 const response=await post(app,'/api/runtime/wsl/select',{target:'native'});assert.equal(response.status,200);assert.equal((await response.json()).restartRequired,true);assert.equal(await store.read(),null);
});
