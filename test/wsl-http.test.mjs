import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
import {WslSelectionStore} from '../src/wsl-runtime.mjs';

const candidate={distribution:'Ubuntu',user:'lee',home:'/home/lee',codexHome:'/home/lee/.codex',codexPath:'/usr/bin/codex',available:true};
async function fixture(t,selected=null,probeCandidate=candidate,options={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'codecang wsl http-'));const store=new WslSelectionStore({root});await store.save(selected);
 const calls=[];const service={platform:'win32',probe:async input=>{calls.push(input);return {...probeCandidate,...input};},launch:()=>({command:'never-run',args:[],cwd:os.tmpdir()}),discover:async()=>{calls.push('discover');return {available:true,candidates:[probeCandidate]};},toLinux:async p=>p};
 const client=new DemoClient();const app=await createServer({client,wslRuntimeService:service,wslSelectionStore:store,statisticsRoot:path.join(root,'stats'),projectsRoot:path.join(root,'projects'),fileAttachmentRoot:path.join(root,'attachments'),desktopStateRoot:path.join(root,'desktop'),...options});await app.started;
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
 const status=await (await fetch(app.origin+'/api/status',{headers:{Authorization:`Bearer ${app.token}`}})).json();assert.equal(status.runtimeTarget,'wsl');assert.ok(status.runtimeUnsupported.includes('gitWrite'));assert.ok(!status.runtimeUnsupported.includes('git'));
 for(const url of ['/api/git/plan','/api/git/apply','/api/dsh/config-sources/status']){const result=await post(app,url);assert.equal(result.status,409);assert.equal((await result.json()).code,'WSL_UNSUPPORTED');}
 const connection=await (await post(app,'/api/dsh/connection/status')).json();assert.equal(connection.selectionRequired,true);assert.ok(connection.modes.includes('windows'));
 const runtime=await (await post(app,'/api/runtime/status')).json();assert.equal(runtime.current.source,'wsl');assert.equal(runtime.canUpgrade,false);
 assert.equal((await post(app,'/api/runtime/upgrade')).status,400);
 const selection=await (await post(app,'/api/runtime/wsl/status')).json();assert.equal(selection.restartRequired,false);assert.equal(selection.current.user,'lee');
});

test('new WSL projectless threads get independent Linux directories under the selected user',async t=>{
 const {app,service}=await fixture(t,{distribution:'Ubuntu',user:'lee'}),commands=[];
 service.invoke=async args=>{commands.push(args);return '';};
 const rpc=async(method,params,mutating=false)=>{
  const response=await post(app,'/api/rpc',{method,params,...(mutating?{requestId:`${app.operations.serverInstance}:${Date.now()}:${randomUUID()}`}:{})});
  assert.equal(response.status,200,await response.clone().text());return response.json();
 };
 const a=(await rpc('thread/start',{},true)).thread,b=(await rpc('thread/start',{},true)).thread;
 assert.ok(a.projectless&&b.projectless);assert.notEqual(a.cwd,b.cwd);
 assert.ok(a.cwd.startsWith('\\\\wsl.localhost\\Ubuntu\\home\\lee\\.local\\share\\codecang\\projectless-threads\\'));
 for(const command of commands){
  assert.deepEqual(command.slice(0,-1),['--distribution','Ubuntu','--user','lee','--exec','/bin/mkdir','-p','-m','700','--']);
  assert.match(command.at(-1),/^\/home\/lee\/\.local\/share\/codecang\/projectless-threads\/[a-f0-9]{32}$/);
 }
 await rpc('turn/start',{threadId:a.id,cwd:a.cwd,input:[{type:'text',text:'isolated'}]},true);
 assert.deepEqual(commands.at(-1),['--distribution','Ubuntu','--user','lee','--exec','/bin/test','-d',commands[0].at(-1)]);
 assert.equal((await rpc('thread/read',{threadId:a.id})).thread.projectless,true);
});

test('WSL Git reads use the selected Linux runtime, while write plans stay unavailable',async t=>{
 const {app,service}=await fixture(t,{distribution:'Ubuntu',user:'lee'}),calls=[];
 service.toLinux=async()=>'/home/lee/Repo';
 service.gitRead=async(cwd,args,selected)=>{calls.push({cwd,args,selected});return {exitCode:0,stdout:args[0]==='config'?'':args[0]==='status'?' M 文件.txt\0':'diff --git a/文件.txt b/文件.txt\n--- a/文件.txt\n+++ b/文件.txt\n@@ -1 +1 @@\n-a\n+b\n',stderr:''};};
 const response=await post(app,'/api/git/read',{cwd:process.cwd(),kind:'diff'});
 assert.equal(response.status,200,await response.clone().text());
 assert.match((await response.json()).diff,/\+b/);
 assert.deepEqual(calls.map(row=>row.args[0]),['config','diff']);
 assert.equal(calls[0].selected.distribution,'Ubuntu');assert.equal(calls[0].selected.user,'lee');
 const status=await post(app,'/api/git/read',{cwd:process.cwd(),kind:'status'});
 assert.deepEqual((await status.json()).files,[{index:' ',worktree:'M',path:'文件.txt'}]);
 for(const url of ['/api/git/plan','/api/git/apply'])assert.equal((await post(app,url,{cwd:process.cwd()})).status,409);
});

test('WSL desktop keeps its native folder chooser and reports cancellation without changing runtime',async t=>{
 let picks=0,selected=process.cwd();
 const {app,store}=await fixture(t,{distribution:'Ubuntu',user:'lee'},candidate,{desktop:true,onDesktopPickFolder:async()=>{picks++;return selected;}});
 const projects=await(await fetch(app.origin+'/api/projects',{headers:{Authorization:`Bearer ${app.token}`}})).json();
 assert.equal(projects.canPickFolder,true);
 assert.deepEqual(await(await post(app,'/api/desktop/pick-folder')).json(),{path:process.cwd()});
 selected=null;assert.deepEqual(await(await post(app,'/api/desktop/pick-folder')).json(),{path:null});
 assert.equal(picks,2);assert.deepEqual(await store.read(),{distribution:'Ubuntu',user:'lee'});
});

test('opening a WSL project uses its selected distribution and preserves Linux path case',async t=>{
 const checked=[],opened=[];
 const projectStore={directory:async folder=>{checked.push(folder);return folder;}};
 const {app}=await fixture(t,{distribution:'Ubuntu',user:'lee'},candidate,{projectStore,openProjectFolder:async folder=>opened.push(folder)});
 const result=await post(app,'/api/projects/open',{path:'/home/lee/Repo'});
 assert.equal(result.status,200,await result.text());
 assert.deepEqual(checked,['\\\\wsl.localhost\\Ubuntu\\home\\lee\\Repo']);
 assert.deepEqual(opened,checked);
});

test('WSL Git filter confirmation remains per read and failure never becomes empty diff',async t=>{
 const {app,service}=await fixture(t,{distribution:'Ubuntu',user:'lee'});const calls=[];
 service.toLinux=async()=>'/home/lee/Repo';
 service.gitRead=async(cwd,args)=>{calls.push(args[0]);return args[0]==='config'?{exitCode:0,stdout:'filter.lfs.clean\n',stderr:''}:{exitCode:128,stdout:'',stderr:'not a repository'};};
 let response=await post(app,'/api/git/read',{cwd:process.cwd(),kind:'diff'});
 assert.equal((await response.json()).code,'GIT_INSPECTION_CONFIRMATION_REQUIRED');assert.deepEqual(calls,['config']);
 response=await post(app,'/api/git/read',{cwd:process.cwd(),kind:'diff',confirmedInspection:true});
 assert.equal(response.status,400);assert.match((await response.json()).error,/not a repository/);
 response=await post(app,'/api/git/read',{cwd:process.cwd(),kind:'status'});
 assert.equal((await response.json()).code,'GIT_INSPECTION_CONFIRMATION_REQUIRED');assert.equal(calls.at(-1),'config');
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
