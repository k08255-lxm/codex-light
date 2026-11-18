import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';

async function post(app,pathname,input){
 const response=await fetch(app.origin+pathname,{method:'POST',headers:{Authorization:`Bearer ${app.token}`,'Content-Type':'application/json'},body:JSON.stringify(input)});
 const result=await response.json();
 assert.equal(response.status,200,JSON.stringify(result));
 return result;
}
const rpc=(app,method,params,mutating=false)=>post(app,'/api/rpc',{method,params,...(mutating?{requestId:`${app.operations.serverInstance}:${Date.now()}:${randomUUID()}`}:{})});

test('isolated projectless paths, selection and confirmed activity survive a server restart',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codex-light-projectless-'));
 const projectsRoot=path.join(root,'state');
 const client=new DemoClient();
 const open=async client=>{const app=await createServer({demo:true,client,projectsRoot});await app.started;return app;};
 let app;
 try{
  const directory=await mkdir(path.join(root,'existing-project'),{recursive:true});
  app=await open(client);
  const added=await post(app,'/api/projects/add',{path:directory});
  assert.ok(added.projects[0].addedAt);
  assert.equal((await post(app,'/api/projects/select',{id:null})).selectedId,null);
  const a=(await rpc(app,'thread/start',{},true)).thread;
  const b=(await rpc(app,'thread/start',{},true)).thread;
  const projectThread=(await rpc(app,'thread/start',{cwd:directory},true)).thread;
  assert.ok(a.projectless&&b.projectless);
  assert.ok(!projectThread.projectless);
  assert.notEqual(a.cwd,b.cwd);
  assert.equal(path.dirname(a.cwd),path.join(projectsRoot,'projectless-threads'));
  assert.ok((await stat(a.cwd)).isDirectory()&&(await stat(b.cwd)).isDirectory());
  const started=await rpc(app,'turn/start',{threadId:a.id,cwd:a.cwd,input:[{type:'text',text:'first'}]},true);
  assert.ok(started.submittedAt);
  const steered=await rpc(app,'turn/steer',{threadId:a.id,expectedTurnId:started.turn.id,input:[{type:'text',text:'extra'}]},true);
  assert.ok(steered.submittedAt>=started.submittedAt);
  assert.deepEqual(await app.projectStore.submitted(),{[a.id]:steered.submittedAt});
  assert.equal((await rpc(app,'thread/read',{threadId:a.id})).thread.submittedAt,steered.submittedAt);
  assert.ok(!(await rpc(app,'thread/read',{threadId:b.id})).thread.submittedAt);
  client.threads.get(a.id).updatedAt+=1000;
  const persistedHistory=structuredClone(client.threads);
  await app.close();
  const restartedClient=new DemoClient();restartedClient.threads=persistedHistory;
  app=await open(restartedClient);
  const rows=(await rpc(app,'thread/list',{limit:20})).data;
  assert.equal(rows.find(row=>row.id===a.id).submittedAt,steered.submittedAt);
  assert.ok(rows.find(row=>row.id===a.id).projectless);
  assert.ok(rows.find(row=>row.id===b.id).projectless);
  assert.ok(!rows.find(row=>row.id===projectThread.id).projectless);
  assert.equal((await app.projectStore.list()).selectedId,null);
  assert.ok((await rpc(app,'thread/read',{threadId:b.id})).thread.projectless);
 }finally{await app?.close();await rm(root,{recursive:true,force:true});}
});
