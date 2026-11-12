import test from 'node:test';import assert from 'node:assert/strict';import {DshReadService} from '../src/dsh-read.mjs';

const cwd=process.cwd();
const item=(agentId='a',tool='dsh_start',result={structuredContent:{agent_id:agentId,status:'running'}})=>({id:`call-${agentId}-${tool}`,type:'mcpToolCall',server:'dsh_subagent',tool,status:'completed',arguments:{},result});
const client=call=>({connected:true,call});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('bindThread follows the host absolute-path policy and rejects Windows root-relative paths',()=>{
 const s=new DshReadService(client(async()=>{throw new Error('must not call');}));
 assert.equal(s.bindThread({id:'native-cwd',cwd:process.cwd()}),true);
 if(process.platform==='win32'){
  assert.equal(s.bindThread({id:'slash-root',cwd:'/root'}),false);
  assert.equal(s.bindThread({id:'backslash-root',cwd:'\\relative-root'}),false);
 }else{
  assert.equal(s.bindThread({id:'slash-root',cwd:'/root'}),true);
  assert.equal(s.bindThread({id:'backslash-root',cwd:'\\relative-root'}),false);
 }
});

test('monitor binds only the real thread cwd, lists tasks into the thread store, and preserves observed tasks',async()=>{
 const calls=[];const s=new DshReadService(client(async(method,params)=>{
  calls.push({method,params});
  if(params.tool==='dsh_list')return {structuredContent:{items:[{agent_id:'listed',status:'running',name:'Listed'}]}};
  return {structuredContent:{agent_id:'a',status:'idle',answer:'done'}};
 }));
 s.observe('thread1',item('a'));
 assert.equal(s.bindThread({id:'thread1',cwd}),true);
 assert.equal(s.bindThread({id:'thread2',cwd:'relative'}),false);
 const monitor=await s.monitor({threadId:'thread1'});
 assert.deepEqual(Object.keys(monitor).sort(),['checkedAt','cwd','result','threadId','tool']);
 assert.equal(monitor.threadId,'thread1');assert.equal(monitor.cwd,cwd);assert.equal(monitor.tool,'dsh_list');assert.match(monitor.checkedAt,/^\d{4}-\d\d-\d\dT.*Z$/);
 assert.deepEqual(calls[0],{method:'mcpServer/tool/call',params:{threadId:'thread1',server:'dsh_subagent',tool:'dsh_list',arguments:{cwd,legacy:false,limit:50,max_chars:16000}}});
 assert.ok(s.threads.get('thread1').values().some(task=>task.agentId==='listed'),'list result must authorize a read target');
 assert.equal(s.threads.get('thread1').values().find(task=>task.agentId==='a').status,'running','binding must not reset observed tasks');
 const read=await s.read({threadId:'thread1',agentId:'listed',kind:'status'});
 assert.equal(read.agentId,'listed');assert.equal(calls[1].params.arguments.agent_id,'listed');
 // DSH item arguments are not provenance for a monitor cwd.
 s.observe('thread1',{...item('b'),arguments:{cwd:'C:\\unrelated'}});
 await s.monitor({threadId:'thread1'});
 assert.equal(calls.at(-1).params.arguments.cwd,cwd);
 assert.equal(s.bindThread({id:'thread3',cwd}),true);
 assert.equal(s.bindings.get('thread3'),cwd);
});

test('monitor and read are strict about keys, ids, kinds, and cursors',async()=>{
 let calls=0;const s=new DshReadService(client(async()=>{calls++;return {structuredContent:{agent_id:'a',status:'idle'}};}));
 s.bindThread({id:'t',cwd});s.observe('t',item('a'));
 await assert.rejects(s.monitor({threadId:'t',cwd}),/不支持参数 cwd/);
 await assert.rejects(s.monitor({threadId:''}),/对话标识无效/);
 await assert.rejects(s.monitor({threadId:'x'.repeat(201)}),/对话标识无效/);
 await assert.rejects(s.monitor({}),/对话标识无效/);
 await assert.rejects(s.read({threadId:'t',agentId:'a',kind:'status',extra:true}),/不支持参数 extra/);
 await assert.rejects(s.read({threadId:'t',agentId:'a',kind:'result'}),/仅允许/);
 await assert.rejects(s.read({threadId:'t',agentId:'a',kind:'start'}),/仅允许/);
 await assert.rejects(s.read({threadId:'t',agentId:'a',kind:'status',after:0}),/仅事件/);
 for(const after of [-1,1.5,Number.MAX_SAFE_INTEGER+1,'1:2','1:2:3:4','-1:2:3',' 1:2:3','1:2:3'.repeat(30),null])
  await assert.rejects(s.read({threadId:'t',agentId:'a',kind:'events',after}),/分页游标/);
 assert.equal(calls,0);
 await assert.rejects(s.read({threadId:'t',agentId:'other',kind:'status'}),/尚未观察到/);
 await assert.rejects(s.monitor({threadId:'unbound'}),/尚未绑定/);
});

test('status and events use fixed readonly arguments, including both cursor forms; result is never called',async()=>{
 const calls=[];const s=new DshReadService(client(async(method,params)=>{
  calls.push({method,params});return {structuredContent:{agent_id:'a',status:'running',events:[{type:'assistant/final',text:'prior'}]}};
 }));
 s.bindThread({id:'t',cwd});s.observe('t',item('a'));
 const status=await s.read({threadId:'t',agentId:'a',kind:'status'});
 assert.deepEqual(Object.keys(status).sort(),['agentId','checkedAt','result','threadId','tool']);
 assert.equal(status.tool,'dsh_status');
 assert.deepEqual(calls[0],{method:'mcpServer/tool/call',params:{threadId:'t',server:'dsh_subagent',tool:'dsh_status',arguments:{agent_id:'a',legacy:false}}});
 await s.read({threadId:'t',agentId:'a',kind:'events',after:12});
 assert.deepEqual(calls[1].params.arguments,{agent_id:'a',include_progress:true,include_tool_events:true,include_descendants:true,limit:100,max_chars:12000,after:12});
 await s.read({threadId:'t',agentId:'a',kind:'events',after:'1:2:3'});
 assert.deepEqual(calls[2].params.arguments,{agent_id:'a',include_progress:true,include_tool_events:true,include_descendants:true,limit:100,max_chars:12000,after:'1:2:3'});
 await assert.rejects(s.read({threadId:'t',agentId:'a',kind:'result'}),/仅允许/);
 assert.equal(calls.length,3);
});

test('same-thread monitor and same kind+cursor reads coalesce; a different cursor is a separate call',async()=>{
 const calls=[];const gates=[];const s=new DshReadService(client((method,params)=>{
  calls.push({method,params});const gate=deferred();gates.push(gate);return gate.promise;
 }));
 s.bindThread({id:'t',cwd});s.observe('t',item('a'));
 const m1=s.monitor({threadId:'t'}),m2=s.monitor({threadId:'t'});
 assert.equal(calls.length,1);
 const r1=s.read({threadId:'t',agentId:'a',kind:'events'}),r2=s.read({threadId:'t',agentId:'a',kind:'events'});
 assert.equal(calls.length,2);
 const r3=s.read({threadId:'t',agentId:'a',kind:'events',after:3});
 assert.equal(calls.length,3);
 gates[0].resolve({structuredContent:{items:[{agent_id:'listed',status:'idle'}]}});
 gates[1].resolve({structuredContent:{agent_id:'a',status:'running'}});
 gates[2].resolve({structuredContent:{agent_id:'a',status:'running'}});
 const [mon1,mon2,read1,read2,read3]=await Promise.all([m1,m2,r1,r2,r3]);
 assert.equal(mon1.threadId,'t');assert.equal(mon2.threadId,'t');assert.equal(read1.agentId,'a');assert.equal(read2.agentId,'a');assert.equal(read3.tool,'dsh_events');
 assert.equal(s.pending.size,0);
});

test('shared 16-operation cap rejects the seventeenth monitor/read',async()=>{
 const gates=[];const s=new DshReadService(client(()=>{const gate=deferred();gates.push(gate);return gate.promise;}));
 s.bindThread({id:'t',cwd});for(let index=0;index<17;index++)s.observe('t',item(`a${index}`));
 const pending=[];for(let index=0;index<16;index++)pending.push(s.read({threadId:'t',agentId:`a${index}`,kind:'status'}));
 assert.equal(s.pending.size,16);
 await assert.rejects(s.read({threadId:'t',agentId:'a16',kind:'status'}),/同时查询过多/);
 await assert.rejects(s.monitor({threadId:'t'}),/同时查询过多/);
 for(const gate of gates)gate.resolve({structuredContent:{status:'running'}});
 await Promise.all(pending);assert.equal(s.pending.size,0);
});

test('MCP isError is an explicit failure and is never stored as lifecycle state',async()=>{
 const s=new DshReadService(client(async()=>({isError:true,content:[{type:'text',text:'permission denied'}]})));
 s.bindThread({id:'t',cwd});s.observe('t',item('a'));
 await assert.rejects(s.read({threadId:'t',agentId:'a',kind:'status'}),/permission denied/);
 assert.equal(s.threads.get('t').values().find(task=>task.agentId==='a').status,'running');
 assert.equal(s.pending.size,0);
 await assert.rejects(s.monitor({threadId:'t'}),/permission denied/);
 assert.equal(s.pending.size,0);
});

test('clear prevents late read responses from reauthorizing or overwriting a re-bound store',async()=>{
 const gate=deferred();const s=new DshReadService(client(()=>gate.promise));
 s.bindThread({id:'t',cwd});s.observe('t',item('a'));
 const lateRead=s.read({threadId:'t',agentId:'a',kind:'status'});
 s.clear();assert.equal(s.threads.size,0);assert.equal(s.bindings.size,0);
 s.bindThread({id:'t',cwd});s.observe('t',item('a','dsh_status',{structuredContent:{agent_id:'a',status:'idle'}}));
 gate.resolve({structuredContent:{agent_id:'a',status:'completed',answer:'stale'}});
 await assert.rejects(lateRead,/失效/);
 assert.equal(s.threads.get('t').values().find(task=>task.agentId==='a').status,'idle');
 assert.equal(s.pending.size,0);
});

test('clear prevents a late monitor response from injecting agents into a new authorization set',async()=>{
 const gate=deferred();const s=new DshReadService(client(()=>gate.promise));
 s.bindThread({id:'t',cwd});
 const lateMonitor=s.monitor({threadId:'t'});
 s.clear();s.bindThread({id:'t',cwd});
 assert.equal(s.threads.get('t').values().length,0);
 gate.resolve({structuredContent:{items:[{agent_id:'late',status:'running'}]}});
 await assert.rejects(lateMonitor,/失效/);
 assert.equal(s.threads.get('t').values().length,0);
 await assert.rejects(s.read({threadId:'t',agentId:'late',kind:'status'}),/尚未观察到/);
});

test('threads are capped at 100 and evict the oldest binding, not the newest',()=>{
 const s=new DshReadService(client(async()=>{throw new Error('must not call');}));
 for(let index=0;index<101;index++)assert.equal(s.bindThread({id:`t${index}`,cwd}),true);
 assert.equal(s.threads.size,100);assert.equal(s.bindings.size,100);
 assert.equal(s.bindings.has('t0'),false);assert.equal(s.bindings.get('t100'),cwd);
});

test('disconnected rpc rejects monitor and read before any tool call',async()=>{
 let calls=0;const s=new DshReadService({connected:false,call:async()=>{calls++;}});
 s.bindThread({id:'t',cwd});s.observe('t',item('a'));
 await assert.rejects(s.monitor({threadId:'t'}),/尚未连接/);
 await assert.rejects(s.read({threadId:'t',agentId:'a',kind:'status'}),/尚未连接/);
 assert.equal(calls,0);
});
