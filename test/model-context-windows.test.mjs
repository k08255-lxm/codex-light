import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ModelContextWindows,readModelWindowCatalog} from '../src/model-context-windows.mjs';
import {ThreadSessions} from '../src/thread-sessions.mjs';

test('the native catalog supplies only nominal window metadata and never invents a missing default',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codecang-catalog-'));t.after(()=>rm(root,{recursive:true,force:true}));
 assert.equal((await readModelWindowCatalog(root)).status,'missing');
 const file=path.join(root,'models_cache.json'),fetchedAt='2026-11-26T12:00:00.000Z';
 await writeFile(file,JSON.stringify({identity:'private',fetched_at:fetchedAt,models:[{slug:'a',context_window:500000,max_context_window:872000,instructions:'private'},{slug:'unknown'}]}));
 assert.deepEqual(await readModelWindowCatalog(root),{status:'ready',fetchedAt,models:{a:{size:500000,max:872000}}});
 await writeFile(file,'{');assert.equal((await readModelWindowCatalog(root)).status,'invalid');
});

test('an immediately reopened engine session waits for its previous close without resending the turn',async()=>{
 let resumes=0,sends=0;
 const rpc={call:async(method)=>{
  if(method==='thread/resume'&&++resumes===1)throw Object.assign(new Error('thread t is closing; retry thread/resume after the thread is closed'),{code:-32600});
  if(method==='turn/start'){sends++;return {turn:{id:'a',status:'inProgress'}};}
  return {thread:{id:'t'}};
 }};
 const sessions=new ThreadSessions(rpc);await sessions.call('turn/start',{threadId:'t',model:'alpha'});
 assert.equal(resumes,2);assert.equal(sends,1);assert.equal(sessions.snapshot().threads[0].activeTurnId,'a');
});

test('context window preferences persist per model and runtime, and clearing one restores the engine default',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codecang-context-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new ModelContextWindows(root,'native');
 await Promise.all([store.update({model:'alpha',size:131072}),store.update({model:'beta',size:262144})]);
 const again=new ModelContextWindows(root,'native');await again.load();
 assert.deepEqual(again.snapshot(),{alpha:131072,beta:262144});
 const wsl=new ModelContextWindows(root,'wsl');await wsl.load();assert.deepEqual(wsl.snapshot(),{});
 assert.throws(()=>again.update({model:'alpha',size:-1}));
 await again.update({model:'alpha',size:null});
 const after=new ModelContextWindows(root,'native');await after.load();assert.deepEqual(after.snapshot(),{beta:262144});
});

test('the native window follows the resolved default and the selected model on the next turn',async()=>{
 const store=new ModelContextWindows(null,'native');
 await store.update({model:'alpha',size:131072});await store.update({model:'beta',size:65536});
 const calls=[];
 const rpc={call:async(method,params)=>{
  calls.push([method,params]);
  if(method==='config/read')return {config:{model:null}};
  if(method==='model/list')return {data:[{model:'alpha',isDefault:true}]};
  if(method==='thread/read')return {thread:{id:'t',model:'beta',cwd:'/project'}};
  if(['thread/start','thread/resume'].includes(method))return {thread:{id:'t'},model:params.model};
  if(method==='turn/start')return {turn:{id:'turn',status:'inProgress'}};
  if(method==='turn/settings/update')return {status:'applied'};
  return {};
 }};
 const session=new ThreadSessions(rpc,{contextWindows:store});
 await session.call('thread/start',{cwd:'/project'});
 assert.deepEqual(calls.at(-1),['thread/start',{cwd:'/project',model:'alpha',config:{model_context_window:131072}}]);
 await session.call('turn/start',{threadId:'t',model:'alpha'});
 await assert.rejects(session.call('turn/settings/update',{threadId:'t',turnId:'turn',model:'beta'}),{code:'CONTEXT_WINDOW_ACTIVE'});
 session.observe({method:'turn/completed',params:{threadId:'t',turn:{id:'turn'}}});
 await session.call('turn/start',{threadId:'t',model:'beta'});
 assert.deepEqual(calls.filter(([m])=>m==='thread/resume').at(-1)[1],{threadId:'t',excludeTurns:true,config:{model_context_window:65536}});
 assert.deepEqual(await store.sessionParams(rpc,{threadId:'t'}),{threadId:'t',config:{model_context_window:65536}});
 assert.deepEqual(await store.sessionParams(rpc,{threadId:'t'},{model:'alpha'}),{threadId:'t',model:'alpha',config:{model_context_window:131072}});
 assert.deepEqual(await store.sessionParams(rpc,{threadId:'t'},{model:'other'}),{threadId:'t'});
});
