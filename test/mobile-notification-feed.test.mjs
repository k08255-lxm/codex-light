import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
import {MobileNotificationFeed} from '../src/mobile-notification-feed.mjs';
import {MobileTaskRoutes} from '../src/mobile-task-routes.mjs';

function feedWithRoots(...ids){
  const feed=new MobileNotificationFeed({readThread:async id=>({id,source:'vscode'})});
  for(const id of ids)feed.routes.remember({id,source:'vscode'});
  return feed;
}

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
  emit('thread/started',{thread:{id:threadId,source:'appServer'}});
  emit('turn/started',{threadId,turn:{id:turnId,status:'inProgress'}});
  client.requests.set(1,{id:1,method:'item/commandExecution/requestApproval',params:{threadId,turnId,command:'TOP_SECRET_COMMAND'}});
  client.requests.set(2,{id:2,method:'mcpServer/elicitation/request',params:{threadId,turnId,_meta:{codex_approval_kind:'mcp_tool_call',tool_name:'TOP_SECRET_TOOL'}}});
  emit('item/completed',{threadId,turnId,item:{id:'async-message',type:'agentMessage',delivery:'async',questions:[{title:'TOP_SECRET_QUESTION'}]}});
  const active=await (await request()).json();
  assert.deepEqual(active.running,[{threadId,turnId,state:'waiting',phase:'approval'}]);
  assert.deepEqual(active.pending.map(({kind,id})=>[kind,id.split('-')[0]]),[['approval','request'],['approval','request'],['question','async']]);
  assert.deepEqual(Object.keys(active.pending[0]).sort(),['id','kind','threadId']);
  assert.doesNotMatch(JSON.stringify(active),/TOP_SECRET|bridgeRequestToken/);
  assert.deepEqual((await (await request()).json()).pending,active.pending);
  client.requests.clear();
  emit('turn/completed',{threadId,turn:{id:turnId,status:'completed'}});
  const finished=await (await request()).json();
  assert.deepEqual(finished.running,[{threadId,turnId,state:'waiting',phase:'question'}]);
  assert.deepEqual(finished.finished,[]);
  assert.deepEqual(finished.pending,[active.pending[2]]);
  emit('item/completed',{threadId,turnId:'turn-2',item:{id:'answer',type:'userMessage',content:[{type:'text',text:'对提问的回答\n\n1. TOP_SECRET_QUESTION\n回答：yes'}]}});
  const answered=await (await request()).json();
  assert.deepEqual(answered.pending,[]);
  assert.deepEqual(answered.running,[]);
  assert.deepEqual(answered.finished,[{threadId,turnId,state:'completed'}]);
  await app.lan.rotate();
  assert.equal((await request()).status,401);
});

test('offline snapshots report no active states or inferred completions and expire old outcomes',()=>{
  const feed=feedWithRoots('t');
  const snapshot=(connected,now)=>feed.snapshot({connected,now,serverInstance:'instance',threads:[],requests:new Map()});
  const threadId='t', turnId='round';
  feed.observe({method:'turn/started',params:{threadId,turn:{id:turnId}}},100);
  assert.deepEqual(snapshot(false,100).finished,[]);
  feed.observe({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'failed'}}},100);
  assert.deepEqual(snapshot(true,200).finished,[{threadId,turnId,state:'failed'}]);
  assert.deepEqual(snapshot(true,15*60_000+100).finished,[]);
});

test('background activity phases follow actual events across simultaneous tasks without exposing output',()=>{
  const feed=feedWithRoots('a','b');
  const event=(method,threadId,item)=>feed.observe({method,params:{threadId,turnId:'one',item,delta:'private',turn:method==='turn/started'?{id:'one'}:undefined}});
  const snapshot=()=>feed.snapshot({connected:true,serverInstance:'x',threads:[],requests:new Map()}).running;
  for(const id of ['a','b'])event('turn/started',id);
  event('item/started','a',{id:'thought',type:'reasoning'});
  event('item/started','b',{id:'tool',type:'commandExecution',command:'private'});
  assert.deepEqual(snapshot().map(t=>t.phase),['thinking','tool']);
  event('item/started','a',{id:'writer',type:'agentMessage'});
  event('item/completed','a',{id:'thought',type:'reasoning'});
  assert.deepEqual(snapshot().map(t=>t.phase),['responding','tool']);
  event('item/completed','b',{id:'tool',type:'commandExecution'});
  assert.deepEqual(snapshot().map(t=>t.phase),['responding','working']);
  assert.doesNotMatch(JSON.stringify(snapshot()),/private|commandExecution|writer/);
});

test('unanswered async notices survive terminal retention and engine reconnect until answer or archive',()=>{
  const feed=feedWithRoots('thread');
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

test('mid-turn recovery, plan updates and a delayed question keep the same task identity',()=>{
  const feed=feedWithRoots('root');
  const event=(method,fields)=>feed.observe({method,params:{threadId:'root',turnId:'turn',...fields}});
  const snapshot=(details=true)=>feed.snapshot({connected:true,details,serverInstance:'x',threads:[{threadId:'root',state:'idle'}],requests:new Map()});
  event('item/commandExecution/outputDelta',{itemId:'cmd',delta:'SECRET COMMAND OUTPUT'});
  event('turn/plan/updated',{plan:[{step:'private task',status:'completed'},{step:'检查附件布局',status:'inProgress'}]});
  assert.deepEqual(snapshot().running[0],{threadId:'root',turnId:'turn',state:'running',phase:'tool',details:{action:'commandExecution',done:1,total:2,step:'检查附件布局'}});
  event('item/completed',{item:{id:'cmd',type:'commandExecution'}});
  assert.equal(snapshot().running[0].details.completedTools,1);
  event('turn/completed',{turn:{id:'turn',status:'completed'}});
  event('item/commandExecution/outputDelta',{itemId:'cmd',delta:'late replay'});
  assert.deepEqual(snapshot().running,[]);
  event('item/completed',{item:{id:'ask',type:'agentMessage',delivery:'async',questions:[{title:'选哪个版本？'}]}});
  const waiting=snapshot(), card=waiting.running[0];
  assert.deepEqual([card.turnId,card.phase,card.details.preview],['turn','question','选哪个版本？']);
  assert.equal(card.details.noticeId,waiting.pending[0].id);
  assert.equal(waiting.pending[0].threadId,'root');
  assert.doesNotMatch(JSON.stringify(snapshot(false)),/选哪个版本|检查附件布局|preview|private task|SECRET/);
});

test('unclassified turns stay silent until confirmed; nested agents, guardian and attached threads stay hidden',async()=>{
  const answers=new Map(), reads=[];
  const feed=new MobileNotificationFeed({readThread:id=>new Promise(resolve=>{reads.push(id);answers.set(id,resolve);})});
  const emit=(method,params)=>feed.observe({method,params});
  const snapshot=()=>feed.snapshot({connected:true,serverInstance:'instance',threads:[],requests:new Map()});
  for(const id of ['outside','user-fork','child','grandchild','guardian','attached']){
    emit('thread/started',{thread:{id}});
    emit('turn/started',{threadId:id,turn:{id:'round'}});
  }
  emit('turn/completed',{threadId:'child',turn:{id:'round',status:'completed'}});
  emit('item/started',{threadId:'outside',item:{type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['child']}});
  emit('item/completed',{threadId:'child',item:{type:'subAgentActivity',agentThreadId:'grandchild'}});
  assert.deepEqual(snapshot().running,[]);
  assert.deepEqual(snapshot().finished,[]);
  await Promise.resolve();
  assert.equal(reads.length,6,'coalesce repeated metadata requests per candidate');
  answers.get('outside')({id:'outside',source:'vscode'});
  answers.get('user-fork')({id:'user-fork',source:'appServer',forkedFromId:'outside'});
  answers.get('child')({id:'child',source:'vscode'}); // Older reply without the spawn edge.
  answers.get('grandchild')({id:'grandchild',source:{subAgent:{thread_spawn:{parent_thread_id:'child',depth:2}}}});
  answers.get('guardian')({id:'guardian',threadSource:'guardian_review'});
  answers.get('attached')({id:'attached',attachedToThreadId:'outside',source:'appServer'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(snapshot().running.map(row=>row.threadId),['outside','user-fork']);
  assert.deepEqual(snapshot().finished,[]);
  emit('turn/completed',{threadId:'outside',turn:{id:'round',status:'completed'}});
  emit('turn/started',{threadId:'outside',turn:{id:'round'}});
  assert.deepEqual(snapshot().running.map(row=>row.threadId),['user-fork']);
  assert.deepEqual(snapshot().finished.map(row=>row.threadId),['outside']);
});

test('legacy notification opens follow confirmed parents and terminate for hidden, archived or removed roots',async()=>{
  const rows=new Map([
    ['root',{id:'root',source:'cli'}], ['child',{id:'child',parentThreadId:'root',archived:true}],
    ['leaf',{id:'leaf',source:{subAgent:{thread_spawn:{parent_thread_id:'child'}}}}],
    ['review',{id:'review',source:{subAgent:{other:'guardian'}}}],
    ['archived',{id:'archived',source:'vscode',archived:true}],
    ['archived-on-disk',{id:'archived-on-disk',source:'cli',path:'/data/.codex/archived_sessions/rollout.jsonl'}],
  ]);
  const routes=new MobileTaskRoutes(async id=>{
    if(id==='offline')throw Object.assign(new Error('disconnected'),{code:'NOT_CONNECTED'});
    if(!rows.has(id))throw Object.assign(new Error(`thread not loaded: ${id}`),{code:-32600});
    return rows.get(id);
  },()=>{});
  assert.equal(await routes.target('leaf'),'root');
  for(const id of ['review','archived','archived-on-disk','deleted'])assert.equal(await routes.target(id),null);
  rows.delete('root');
  assert.equal(await routes.target('leaf'),null,'root removed externally after the original click');
  await assert.rejects(routes.target('offline'),{code:'NOT_CONNECTED'});
});

test('a pending read from a previous connection cannot override the new route or delay its lookup',async()=>{
  const pending=[];
  const routes=new MobileTaskRoutes(id=>new Promise((resolve,reject)=>pending.push({id,resolve,reject})),()=>{});
  assert.equal(routes.isRoot('fresh'),false);
  await Promise.resolve();
  routes.reset();
  pending.shift().reject(Object.assign(new Error('old connection'),{code:'NOT_CONNECTED'}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(routes.isRoot('fresh'),false);
  await Promise.resolve();
  assert.equal(pending.length,1);
  pending.shift().resolve({id:'fresh',source:'vscode'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(routes.isRoot('fresh'),true);
});
