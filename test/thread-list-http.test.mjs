import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'codecang-b2-http-')),client=new DemoClient();
 for(let i=0;i<75;i++)client.threads.set(`s${i}`,{id:`s${i}`,name:`synthetic ${i}`,updatedAt:i,cwd:root});
 const original=client.call.bind(client),calls=[];let hook;
 client.call=async(method,params,options)=>{if(method==='thread/list'){calls.push({params,options});if(hook)await hook(options);}return original(method,params);};
 const app=await createServer({client,demo:true,projectsRoot:path.join(root,'projects'),fileAttachmentRoot:path.join(root,'files'),desktopStateRoot:path.join(root,'state')});await app.started;
 t.after(async()=>{await app.close();assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^codecang-b2-http-/);await rm(root,{recursive:true,force:true});});
 let sequence=0;const post=async(method,params={},signal)=>{
  const requestId=`${app.operations.serverInstance}:${Date.now()}:b2test${String(++sequence).padStart(8,'0')}`;
  const response=await fetch(app.origin+'/api/rpc',{method:'POST',signal,headers:{Authorization:`Bearer ${app.token}`,'Content-Type':'application/json'},body:JSON.stringify({method,params,requestId})});return {status:response.status,body:await response.json(),timing:response.headers.get('server-timing')};
 };
 return {app,client,calls,post,setHook(value){hook=value;}};
}
test('HTTP search keeps pagination/filter semantics and never reads message bodies',async t=>{
 const f=await fixture(t);const first=await f.post('thread/list',{searchTerm:'synthetic',limit:30,sortKey:'updated_at',sortDirection:'desc'});assert.equal(first.status,200);assert.equal(first.body.data.length,30);assert.equal(first.body.nextCursor,'30');assert.match(first.timing,/^thread_list;dur=\d+\.\d{2}$/);
 const second=await f.post('thread/list',{searchTerm:'synthetic',limit:30,cursor:first.body.nextCursor});assert.equal(second.body.data.length,30);assert.equal(new Set([...first.body.data,...second.body.data].map(row=>row.id)).size,60);
 const last=await f.post('thread/list',{searchTerm:'synthetic',limit:30,cursor:second.body.nextCursor});assert.equal(last.body.data.length,15);assert.equal(last.body.nextCursor,null);
 assert.deepEqual((await f.post('thread/list',{searchTerm:'missing'})).body.data,[]);assert.equal((await f.post('thread/list',{limit:10000})).status,400);assert.equal(f.calls.length,4);
});
test('HTTP rename, archive, restore, new thread and external deletion are fresh',async t=>{
 const f=await fixture(t);const list=()=>f.post('thread/list',{searchTerm:'unique'});assert.deepEqual((await list()).body.data,[]);
 assert.equal((await f.post('thread/name/set',{threadId:'s1',name:'unique renamed'})).status,200);assert.equal((await list()).body.data[0].name,'unique renamed');
 assert.equal((await f.post('thread/archive',{threadId:'s1'})).status,200);assert.deepEqual((await list()).body.data,[]);assert.equal((await f.post('thread/list',{searchTerm:'unique',archived:true})).body.data[0].id,'s1');
 assert.equal((await f.post('thread/unarchive',{threadId:'s1'})).status,200);assert.equal((await list()).body.data[0].id,'s1');f.client.threads.delete('s1');assert.deepEqual((await list()).body.data,[]);
 const created=await f.post('thread/start',{cwd:f.client.threads.get('s0').cwd});assert.equal(created.status,200);await f.post('thread/name/set',{threadId:created.body.thread.id,name:'unique new'});assert.equal((await list()).body.data[0].id,created.body.thread.id);
});
test('HTTP disconnect cancels bridge work, next query works, errors are not cached',async t=>{
 const f=await fixture(t),entered=deferred(),aborted=deferred(),release=deferred();
 f.setHook(async({signal})=>{signal.addEventListener('abort',()=>{aborted.resolve();release.resolve();},{once:true});entered.resolve();await release.promise;});
 const controller=new AbortController(),request=f.post('thread/list',{searchTerm:'synthetic'},controller.signal),rejected=assert.rejects(request,e=>e.name==='AbortError');await entered.promise;controller.abort();await rejected;await aborted.promise;
 f.setHook(()=>{throw Object.assign(new Error('synthetic upstream failed'),{code:-32603});});let result=await f.post('thread/list',{searchTerm:'synthetic'});assert.equal(result.status,400);assert.match(result.body.error,/synthetic upstream failed/);
 f.setHook(null);result=await f.post('thread/list',{searchTerm:'synthetic'});assert.equal(result.status,200);assert.equal(result.body.data.length,30);assert.equal(f.calls.length,3);
});
