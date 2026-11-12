import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {createServer} from '../src/server.mjs';
class Mock extends EventEmitter{constructor(){super();this.requests=new Map();this.calls=[];this.connected=false;}async start(){this.connected=true;}async call(method,params){this.calls.push({method,params});if(method==='account/login/start')return {type:'chatgpt',loginId:'owned-id',authUrl:'https://auth.openai.com/authorize?state=SECRET'};if(method==='account/login/cancel')return {status:'canceled'};return {};}async close(){this.connected=false;}}
test('Account HTTP starts once, completion clears transient URL from replay, logout confirms',async t=>{
 const rpc=new Mock(),a=await createServer({client:rpc});await a.started;t.after(()=>a.close());
 let seq=0;const id=()=>`${a.operations.serverInstance}:${Date.now()}:account-test-${++seq}`;
 const send=(action,data)=>fetch(a.origin+'/api/account/'+action,{method:'POST',headers:{Authorization:`Bearer ${a.token}`,'Content-Type':'application/json'},body:JSON.stringify(data)});
 const data={requestId:id(),type:'chatgpt'};assert.equal((await send('start',data)).status,200);assert.equal((await send('start',data)).status,200);assert.equal(rpc.calls.filter(c=>c.method==='account/login/start').length,1);
 const refused=await send('cancel',{requestId:id(),loginId:'foreign'});assert.equal(refused.status,400);assert.equal(rpc.calls.some(c=>c.params?.loginId==='foreign'),false);
 rpc.emit('event',{method:'account/login/completed',params:{loginId:'owned-id',success:true,error:'SECRET'}});
 const replay=await(await send('start',data)).json();assert.equal(replay.authUrl,undefined);assert.equal(replay.redacted,true);assert.equal(JSON.stringify(a.operations.get(data.requestId)).includes('SECRET'),false);
 assert.equal((await send('logout',{requestId:id(),confirmed:false})).status,400);assert.equal(rpc.calls.some(c=>c.method==='account/logout'),false);
 const logout={requestId:id(),confirmed:true};assert.equal((await send('logout',logout)).status,200);assert.equal((await send('logout',logout)).status,200);assert.equal(rpc.calls.filter(c=>c.method==='account/logout').length,1);
});
