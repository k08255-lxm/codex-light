import {EventEmitter} from 'node:events';
import http from 'node:http';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../src/server.mjs';

class MockClient extends EventEmitter {
 constructor({threadCwd}){super();this.connected=true;this.version='mock';this.requests=new Map();this.threadCwd=threadCwd;this.calls=[];}
 async start(){return {};}
 async close(){this.connected=false;}
 async call(method,params){
  this.calls.push({method,params});
  if(method==='thread/start')return {thread:{id:params.ephemeral?'reader-internal':'thread-real',cwd:params.ephemeral?params.cwd:this.threadCwd,model:'mock'}};
  if(method==='thread/unsubscribe')return {};
  if(method==='thread/read')return {thread:{id:params.threadId,cwd:this.threadCwd,turns:[]}};
  if(method==='mcpServer/tool/call'){
   if(params.tool==='dsh_list')return {structuredContent:{items:[{agent_id:'agent-real',status:'running',name:'Real task'}]}};
   if(params.tool==='dsh_events')return {structuredContent:{agent_id:'agent-real',events:[{type:'assistant/progress',text:'working'}]}};
   if(params.tool==='dsh_status')return {structuredContent:{agent_id:'agent-real',parent_thread_id:'thread-real',status:'running'}};
  }
  throw new Error(`unexpected mock method ${method}`);
 }
}

let requestSequence=0;
const post=(a,url,data,extra={})=>{
 if(url==='/api/rpc'&&data.method==='thread/start'&&data.requestId===undefined)data={...data,requestId:`${a.operations.serverInstance}:${Date.now()}:monitor-http-${++requestSequence}`};
 return fetch(a.origin+url,{method:'POST',headers:{Authorization:`Bearer ${a.token}`,'Content-Type':'application/json',...extra},body:JSON.stringify(data)});
};
const readUntil=async(reader,needle)=>{
 let buffer='';const decoder=new TextDecoder();
 for(let index=0;index<12;index++){
  const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});
  if(buffer.includes(needle))return buffer;
 }
 throw new Error(`SSE did not deliver ${needle}: ${buffer}`);
};

test('HTTP monitor binds the actual thread result cwd, lists only that cwd, and read uses fixed events arguments',async t=>{
 const threadCwd=process.cwd();const requestCwd=os.tmpdir();
 assert.notEqual(threadCwd,requestCwd);
 const client=new MockClient({threadCwd});const a=await createServer({client,cwd:threadCwd});await a.started;t.after(()=>a.close());
 const statsModule=await fetch(a.origin+'/change-stats.js',{headers:{Authorization:`Bearer ${a.token}`}});assert.equal(statsModule.status,200);assert.match(await statsModule.text(),/export function changeEvidence/);

 const created=await post(a,'/api/rpc',{method:'thread/start',params:{cwd:requestCwd,approvalPolicy:'on-request',sandbox:'workspace-write'}});
 assert.equal(created.status,200);const {thread}=await created.json();assert.equal(thread.id,'thread-real');assert.equal(thread.cwd,threadCwd);
 assert.equal(a.dsh.bindings.get('thread-real'),threadCwd);

 const monitor=await post(a,'/api/dsh/monitor',{threadId:'thread-real'});
 assert.equal(monitor.status,200);const monitorBody=await monitor.json();
 assert.equal(monitorBody.threadId,'thread-real');assert.equal(monitorBody.cwd,threadCwd);assert.equal(monitorBody.tool,'dsh_list');
 assert.deepEqual(client.calls.find(call=>call.params?.tool==='dsh_list'),{method:'mcpServer/tool/call',params:{threadId:'reader-internal',server:'dsh_subagent',tool:'dsh_list',arguments:{cwd:threadCwd,legacy:false,limit:50,max_chars:16000}}});
 assert.ok(a.dsh.threads.get('thread-real').values().some(task=>task.agentId==='agent-real'),'list result must become a legal read target');

 const read=await post(a,'/api/dsh/read',{threadId:'thread-real',agentId:'agent-real',kind:'events',after:'1:2:3'});
 assert.equal(read.status,200);const readBody=await read.json();
 assert.equal(readBody.tool,'dsh_events');assert.match(readBody.checkedAt,/^\d{4}-\d\d-\d\dT.*Z$/);
 assert.deepEqual(client.calls.at(-1),{method:'mcpServer/tool/call',params:{threadId:'reader-internal',server:'dsh_subagent',tool:'dsh_events',arguments:{agent_id:'agent-real',include_progress:true,include_tool_events:true,include_descendants:true,limit:100,max_chars:12000,after:'1:2:3'}}});

 const before=client.calls.length;
 assert.equal((await post(a,'/api/dsh/monitor',{threadId:'thread-real',cwd:requestCwd})).status,400);
 assert.equal((await post(a,'/api/dsh/monitor',{threadId:'thread-unknown'})).status,400);
 assert.equal((await post(a,'/api/dsh/read',{threadId:'thread-real',agentId:'agent-real',kind:'status',after:0})).status,400);
 assert.equal((await post(a,'/api/dsh/read',{threadId:'thread-real',agentId:'agent-real',kind:'result'})).status,400);
 assert.equal(client.calls.length,before,'rejected requests must not call MCP');
});

test('monitor does not broadcast while read keeps the dshSnapshot broadcast',async t=>{
 const client=new MockClient({threadCwd:process.cwd()});const a=await createServer({client,cwd:process.cwd()});await a.started;t.after(()=>a.close());
 await post(a,'/api/rpc',{method:'thread/start',params:{cwd:process.cwd(),approvalPolicy:'on-request',sandbox:'workspace-write'}});
 const abort=new AbortController();const response=await fetch(a.origin+'/api/events',{headers:{Authorization:`Bearer ${a.token}`},signal:abort.signal});const reader=response.body.getReader();await reader.read();
 assert.equal((await post(a,'/api/dsh/monitor',{threadId:'thread-real'})).status,200);
 client.emit('event',{method:'test/sentinel',params:{value:1}});
 const beforeRead=await readUntil(reader,'test/sentinel');
 assert.ok(!beforeRead.includes('bridge/dshSnapshot'),'monitor must not broadcast a list snapshot');
 assert.equal((await post(a,'/api/dsh/read',{threadId:'thread-real',agentId:'agent-real',kind:'status'})).status,200);
 const afterRead=await readUntil(reader,'bridge/dshSnapshot');
 assert.match(afterRead,/bridge\/dshSnapshot/);
 abort.abort();
});

test('dsh HTTP routes keep auth/origin checks and demo never calls real DSH tools',async t=>{
 const client=new MockClient({threadCwd:process.cwd()});const a=await createServer({client,cwd:process.cwd()});await a.started;t.after(()=>a.close());
 assert.equal((await fetch(a.origin+'/api/dsh/monitor',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"threadId":"t"}'})).status,401);
 const evil=await post(a,'/api/dsh/monitor',{threadId:'t'},{Origin:'https://evil.example'});
 assert.equal(evil.status,403);
 const evilRead=await post(a,'/api/dsh/read',{threadId:'t',agentId:'a',kind:'status'},{Origin:'https://evil.example'});
 assert.equal(evilRead.status,403);
 const hostStatus=await new Promise(resolve=>{const req=http.request(a.origin+'/api/dsh/monitor',{method:'POST',headers:{Host:'evil.example',Authorization:`Bearer ${a.token}`}},res=>{res.resume();resolve(res.statusCode);});req.end();});
 assert.equal(hostStatus,403);

 const demo=await createServer({demo:true});await demo.started;t.after(()=>demo.close());
 let calls=0;const original=demo.rpc.call.bind(demo.rpc);demo.rpc.call=async(...args)=>{calls++;return original(...args);};
 const monitor=await post(demo,'/api/dsh/monitor',{threadId:'t'});assert.equal(monitor.status,400);assert.match((await monitor.json()).error,/演示模式/);
 const read=await post(demo,'/api/dsh/read',{threadId:'t',agentId:'a',kind:'status'});assert.equal(read.status,400);assert.match((await read.json()).error,/演示模式/);
 assert.equal(calls,0);
});

test('account change and disconnect clear bound threads and observed tasks',async t=>{
 const client=new MockClient({threadCwd:process.cwd()});const a=await createServer({client,cwd:process.cwd()});await a.started;t.after(()=>a.close());
 await post(a,'/api/rpc',{method:'thread/start',params:{cwd:process.cwd(),approvalPolicy:'on-request',sandbox:'workspace-write'}});
 assert.equal((await post(a,'/api/dsh/monitor',{threadId:'thread-real'})).status,200);
 assert.equal(a.dsh.threads.size,1);assert.equal(a.dsh.bindings.size,1);
 client.emit('event',{method:'account/updated',params:{}});
 assert.equal(a.dsh.threads.size,0);assert.equal(a.dsh.bindings.size,0);
 assert.equal((await post(a,'/api/dsh/read',{threadId:'thread-real',agentId:'agent-real',kind:'status'})).status,400);

 assert.equal((await post(a,'/api/rpc',{method:'thread/read',params:{threadId:'thread-real'}})).status,200);
 assert.equal(a.dsh.bindings.get('thread-real'),process.cwd());
 client.emit('event',{method:'bridge/status',params:{connected:false}});
 assert.equal(a.dsh.threads.size,0);assert.equal(a.dsh.bindings.size,0);
});
