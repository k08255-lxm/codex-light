import {test} from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {createServer} from '../src/server.mjs';
class Mock extends EventEmitter{constructor(){super();this.requests=new Map();this.calls=[];this.executions=[];this.connected=false;}async start(){this.connected=true;}call(method,params){this.calls.push({method,params});return method==='command/exec'?new Promise(resolve=>this.executions.push(resolve)):Promise.resolve({});}async close(){this.connected=false;for(const resolve of this.executions)resolve({exitCode:0});this.emit('event',{method:'bridge/status',params:{connected:false}});}}
test('HTTP terminal open replay once, strict ownership and no arbitrary command route',async t=>{
 const rpc=new Mock(),a=await createServer({client:rpc});await a.started;t.after(()=>a.close());
 const send=(action,data)=>fetch(a.origin+'/api/terminal/'+action,{method:'POST',headers:{Authorization:`Bearer ${a.token}`,'Content-Type':'application/json'},body:JSON.stringify(data)});
 const input={requestId:`${a.operations.serverInstance}:${Date.now()}:terminal-test-123`,cwd:process.cwd(),size:{rows:24,cols:80}};
 const first=await send('open',input);assert.equal(first.status,200);const result=await first.json();assert.deepEqual(await(await send('open',input)).json(),result);assert.equal(rpc.calls.filter(x=>x.method==='command/exec').length,1);
 assert.equal((await send('open',{...input,cwd:'/different'})).status,409);
 assert.equal((await send('write',{processId:'foreign',text:'x'})).status,400);
 assert.equal((await send('write',{processId:result.processId,text:'x',command:['bad']})).status,400);
 assert.equal((await send('write',{processId:result.processId,text:'echo hi\r'})).status,200);
 assert.equal((await send('resize',{processId:result.processId,size:{rows:30,cols:90}})).status,200);
 rpc.emit('event',{method:'command/exec/outputDelta',params:{processId:result.processId,deltaBase64:'aGk=',stream:'stdout',capReached:false}});
 assert.equal((await(await send('snapshot',{processId:result.processId})).json()).output.length,1);
 assert.equal((await send('terminate',{processId:result.processId})).status,200);assert.equal((await send('write',{processId:result.processId,text:'late'})).status,400);
 const generic=await fetch(a.origin+'/api/rpc',{method:'POST',headers:{Authorization:`Bearer ${a.token}`,'Content-Type':'application/json'},body:JSON.stringify({method:'command/exec',params:{command:['bad']}})});assert.equal(generic.status,400);
 await a.close();assert.equal(a.terminal.sessions.size,0);
});
