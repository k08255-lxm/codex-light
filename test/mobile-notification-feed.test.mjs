import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
import {MobileNotificationFeed} from '../src/mobile-notification-feed.mjs';

test('paired HTTP notification feed includes only active, terminal and pending routes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'codecang-mobile-notifications-'));
  const client=new DemoClient();
  const address='192.168.78.19';
  const app=await createServer({demo:true,client,projectsRoot:join(root,'projects'),statisticsRoot:join(root,'statistics'),lanOptions:{
    networkInterfaces:()=>({Synthetic:[{address,family:'IPv4',internal:false}]}),serverFactory:handler=>{
      const server=http.createServer(handler),listen=server.listen.bind(server);
      server.listen=options=>listen({...options,host:'127.0.0.1'});
      return server;
    },
  }});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  await app.started;
  const lan=await app.lan.enable({address});
  const route='/api/mobile/notification-state';
  const token=new URL(lan.url).hash.slice(7);
  const request=(key=token,method='GET')=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:lan.port,path:route,method,agent:false,headers:{Host:`${address}:${lan.port}`,Authorization:`Bearer ${key}`}},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,json:()=>JSON.parse(Buffer.concat(chunks))}));
      res.on('error',reject);
    });
    req.on('error',reject);
    req.end();
  });
  assert.equal((await request('unpaired')).status,401);
  assert.equal((await fetch(app.origin+route,{headers:{Authorization:`Bearer ${app.token}`}})).status,403);
  assert.equal((await request(token,'POST')).status,405);
  const initial=await (await request()).json();
  assert.equal(initial.connected,true);
  assert.deepEqual(initial.pending,[]);
  const emit=(method,params)=>client.emit('event',{method,params});
  const threadId='thread-1', turnId='turn-1';
  emit('turn/started',{threadId,turn:{id:turnId,status:'inProgress'}});
  client.requests.set(1,{id:1,method:'item/commandExecution/requestApproval',params:{threadId,turnId,command:'TOP_SECRET_COMMAND'}});
  client.requests.set(2,{id:2,method:'mcpServer/elicitation/request',params:{threadId,turnId,_meta:{codex_approval_kind:'mcp_tool_call',tool_name:'TOP_SECRET_TOOL'}}});
  emit('item/completed',{threadId,turnId,item:{id:'async-message',type:'agentMessage',delivery:'async',questions:[{title:'TOP_SECRET_QUESTION'}]}});
  const active=await (await request()).json();
  assert.deepEqual(active.running,[{threadId,turnId,state:'waiting'}]);
  assert.deepEqual(active.pending.map(({kind,id})=>[kind,id.split('-')[0]]),[['approval','request'],['approval','request'],['question','async']]);
  assert.deepEqual(Object.keys(active.pending[0]).sort(),['id','kind','threadId']);
  assert.doesNotMatch(JSON.stringify(active),/TOP_SECRET|bridgeRequestToken/);
  assert.deepEqual((await (await request()).json()).pending,active.pending);
  client.requests.clear();
  emit('turn/completed',{threadId,turn:{id:turnId,status:'completed'}});
  const finished=await (await request()).json();
  assert.deepEqual(finished.running,[]);
  assert.deepEqual(finished.finished,[{threadId,turnId,state:'completed'}]);
  assert.deepEqual(finished.pending,[active.pending[2]]);
  emit('item/completed',{threadId,turnId:'turn-2',item:{id:'answer',type:'userMessage',content:[{type:'text',text:'对提问的回答\n\n1. TOP_SECRET_QUESTION\n回答：yes'}]}});
  assert.deepEqual((await (await request()).json()).pending,[]);
  await app.lan.rotate();
  assert.equal((await request()).status,401);
});

test('offline snapshots report no active states or inferred completions and expire old outcomes',()=>{
  const feed=new MobileNotificationFeed();
  const snapshot=(connected,now)=>feed.snapshot({connected,now,serverInstance:'instance',threads:[],requests:new Map()});
  const threadId='t', turnId='round';
  feed.observe({method:'turn/started',params:{threadId,turn:{id:turnId}}},100);
  assert.deepEqual(snapshot(false,100).finished,[]);
  feed.observe({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'failed'}}},100);
  assert.deepEqual(snapshot(true,200).finished,[{threadId,turnId,state:'failed'}]);
  assert.deepEqual(snapshot(true,15*60_000+100).finished,[]);
});

test('unanswered async notices survive terminal retention and engine reconnect until answer or archive',()=>{
  const feed=new MobileNotificationFeed();
  const threadId='thread', turnId='round';
  const question={id:'question',type:'agentMessage',delivery:'async',questions:[{title:'Question'}]};
  const snapshot=(connected,now,activeTurnId)=>feed.snapshot({connected,now,serverInstance:'instance',threads:activeTurnId?[{threadId,activeTurnId,state:'active'}]:[],requests:new Map()});
  feed.observe({method:'item/completed',params:{threadId,turnId,item:question}},100);
  const original=snapshot(true,101,turnId);
  assert.equal(original.running[0].state,'waiting');
  const later=16*60_000;
  assert.deepEqual(snapshot(true,later,'different-round').pending,original.pending);
  assert.equal(snapshot(true,later,'different-round').running[0].state,'running');
  feed.observe({method:'bridge/status',params:{connected:false}},later+1);
  assert.deepEqual(snapshot(false,later+2).pending,[]);
  assert.deepEqual(snapshot(true,later+3).pending,original.pending);
  feed.observe({method:'thread/archived',params:{threadId}},later+4);
  assert.deepEqual(snapshot(true,later+5).pending,[]);
});
