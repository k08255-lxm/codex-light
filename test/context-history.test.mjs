import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {readInlineHistoryContext} from '../src/inline-history.mjs';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';

const encode=(...rows)=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
const meta=id=>({type:'session_meta',payload:{id}});
const count=(used,window=1000)=>({type:'event_msg',payload:{type:'token_count',info:{
 model_context_window:window,last_token_usage:{input_tokens:used-10,cached_input_tokens:0,output_tokens:10,total_tokens:used},
 total_token_usage:{input_tokens:8000,cache_write_input_tokens:23,output_tokens:110,total_tokens:8110},
}}});

test('history token reader selects the latest numeric snapshot without exposing other rollout content',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'context-history-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const id='thread-one',rollout=path.join(root,'rollout-'+id+'.jsonl');
 await writeFile(rollout,encode(meta(id),count(130),{type:'response_item',payload:{text:'PRIVATE_BODY'}},count(280),
  {type:'event_msg',payload:{type:'token_count',info:null}})+'{"incomplete"');
 const saved=await readInlineHistoryContext({rollout,threadId:id,roots:[root]});
 assert.equal(saved.used,280);assert.equal(saved.window,1000);assert.equal(saved.source,'history');
 assert.equal(saved.last.cachedInputTokens,0);assert.equal(saved.last.cacheWriteInputTokens,null);
 assert.equal(saved.total.cacheWriteInputTokens,23);assert.equal(saved.total.totalTokens,8110);
 assert.doesNotMatch(JSON.stringify(saved),/PRIVATE_BODY|\.jsonl/);
 assert.equal(await readInlineHistoryContext({rollout,threadId:'thread-two',roots:[root]}),null);
 assert.equal(await readInlineHistoryContext({rollout,threadId:id,roots:[path.join(root,'other')]}),null);
 await writeFile(rollout,encode(meta(id),count(130),meta('thread-two'),count(280)));
 assert.equal(await readInlineHistoryContext({rollout,threadId:id,roots:[root]}),null);
});

test('authenticated local and LAN clients recover only the bound thread, with live updates superseding history',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'context-http-'));
 const client=new DemoClient();
 const id='thread-one',rollout=path.join(root,'rollout-'+id+'.jsonl');
 client.threads.set(id,{id,path:rollout,cwd:process.cwd()});
 client.turns.set(id,[]);
 await writeFile(rollout,encode(meta(id),count(280)));
 const address='192.168.75.20';
 const app=await createServer({demo:true,client,contextHistoryReader:options=>readInlineHistoryContext({...options,roots:[root]}),
  lanOptions:{networkInterfaces:()=>({Synthetic:[{address,family:'IPv4',internal:false}]}),serverFactory:handler=>{
   const server=http.createServer(handler),listen=server.listen.bind(server);
   server.listen=options=>listen({...options,host:'127.0.0.1'});return server;
  }}});
 await app.started;t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const post=(url,data,token=app.token)=>fetch(app.origin+url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(data)});
 const context=async()=> (await (await post('/api/thread/context',{threadId:id})).json()).snapshot;
 assert.equal((await post('/api/thread/context',{threadId:id},'wrong')).status,401);
 assert.equal(await context(),null);
 assert.equal((await post('/api/thread/context',{threadId:id,path:rollout})).status,400);
 const read=()=>post('/api/rpc',{method:'thread/read',params:{threadId:id,includeTurns:false}});
 assert.equal((await read()).status,200);
 assert.equal((await context()).used,280);
 const lan=await (await post('/api/lan/enable',{address})).json();
 const capability=new URLSearchParams(new URL(lan.url).hash.slice(1)).get('token');
 const peer=()=>new Promise((resolve,reject)=>{
  const body=JSON.stringify({threadId:id});
  const req=http.request({hostname:'127.0.0.1',port:lan.port,path:'/api/thread/context',method:'POST',headers:{
   Host:new URL(lan.origin).host,Origin:lan.origin,Authorization:'Bearer '+capability,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),
  }},res=>{let text='';res.setEncoding('utf8');res.on('data',value=>text+=value);res.on('end',()=>resolve(JSON.parse(text).snapshot));});
  req.on('error',reject);req.end(body);
 });
 assert.equal((await peer()).source,'history');
 client.emit('event',{method:'thread/tokenUsage/updated',params:{threadId:id,tokenUsage:{last:{totalTokens:420},total:{totalTokens:12345},modelContextWindow:1000}}});
 assert.equal((await peer()).used,420);
 client.emit('event',{method:'account/updated',params:{}});
 assert.equal(await peer(),null);
 assert.equal((await read()).status,200);
 assert.equal((await context()).used,280);
});

test('WSL context history is constrained to the selected distribution and Codex home',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'context-wsl-')),client=new DemoClient();
 const expected='\\\\wsl.localhost\\Ubuntu\\home\\lee\\.codex\\sessions\\rollout-thread-one.jsonl';
 const thread={id:'thread-one',path:expected,cwd:'\\\\wsl.localhost\\Ubuntu\\home\\lee'};
 client.threads.set(thread.id,thread);client.turns.set(thread.id,[]);
 const selection={distribution:'Ubuntu',user:'lee'},runtime={platform:'win32',probe:async()=>({...selection,home:'/home/lee',codexHome:'/home/lee/.codex'}),launch:()=>({command:'unused-client'})};
 const calls=[];
 const app=await createServer({client,wslRuntimeService:runtime,wslSelectionStore:{root,read:async()=>selection},
  contextHistoryReader:async options=>{calls.push(options);return null;}});
 await app.started;t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const post=(url,data)=>fetch(app.origin+url,{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify(data)});
 await post('/api/rpc',{method:'thread/read',params:{threadId:thread.id,includeTurns:false}});
 await post('/api/thread/context',{threadId:thread.id});
 assert.equal(calls[0].rollout,expected);
 assert.equal(calls[0].caseSensitive,true);
 assert.ok(calls[0].roots.every(value=>value.startsWith('\\\\wsl.localhost\\Ubuntu\\home\\lee\\.codex\\')));
 thread.path=expected.replace('Ubuntu','Other');
 await post('/api/rpc',{method:'thread/read',params:{threadId:thread.id,includeTurns:false}});
 await post('/api/thread/context',{threadId:thread.id});
 assert.equal(calls.length,1);
});
