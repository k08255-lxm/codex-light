import test from 'node:test';import assert from 'node:assert/strict';import {RpcClient} from '../src/rpc.mjs';import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
const make=opts=>new RpcClient({command:process.execPath,args:[fileURLToPath(new URL('./fake-app-server.mjs',import.meta.url))],...opts});
test('stdio handshake, request correlation, server error',async t=>{
 const c=make();t.after(()=>c.close());await c.start();assert.equal(c.connected,true);assert.match(c.version,/fake/);
 const results=await Promise.all([c.call('a',{v:1}),c.call('b',{v:2})]);assert.equal(results[0].echo.v,1);assert.equal(results[1].echo.v,2);
 await assert.rejects(c.call('test/error'),/test failure/);
});
test('pending approval explicit single response and no stale reuse',async t=>{
 const c=make();t.after(()=>c.close());await c.start();await c.call('test/approval');assert.equal(c.requests.size,1);
 c.respond(900,{decision:'decline'});assert.equal(c.requests.size,0);assert.throws(()=>c.respond(900,{decision:'accept'}),/不存在/);
});
test('timeout not replayed and outstanding cleared',async t=>{
 const c=make();t.after(()=>c.close());await c.start();c.timeout=40;await assert.rejects(c.call('test/delayed'),/结果未知/);assert.equal(c.pending.size,0);
 await new Promise(r=>setTimeout(r,120));assert.equal(c.pending.size,0);
});
test('process failure rejects in-flight requests',async t=>{
 const c=make();t.after(()=>c.close());await c.start();await assert.rejects(c.call('test/exit'),/连接已结束/);assert.equal(c.connected,false);
});
test('split and malformed framing bounded',()=>{
 const c=make();const events=[];c.on('event',x=>events.push(x));c.consume('{"method":"notice",');c.consume('"params":{}}\nbad\n');
 assert.equal(events[0].method,'notice');assert.equal(events[1].method,'bridge/warning');
});
test('initialization timeout closes and terminates the unusable child',async()=>{
 const c=make({timeout:100,closeTimeout:100,args:[fileURLToPath(new URL('./fake-app-server.mjs',import.meta.url)),'--hang-initialize']});
 await assert.rejects(c.start(),e=>e.code==='RPC_TIMEOUT');assert.equal(c.closed,true);assert.equal(c.connected,false);assert.ok(c.child.exitCode!==null||c.child.signalCode);await c.close();
});
test('turn completion only clears matching conversation approval requests',()=>{
 const c=make();const events=[];c.on('event',e=>events.push(e));
 c.requests.set('a',{id:'a',method:'approval',params:{threadId:'one',turnId:'turn-a'}});c.requests.set('b',{id:'b',method:'approval',params:{threadId:'two',turnId:'turn-a'}});c.requests.set('c',{id:'c',method:'approval',params:{threadId:'one'}});
 c.consume(JSON.stringify({method:'turn/completed',params:{threadId:'one',turn:{id:'turn-a'}}})+'\n');assert.deepEqual([...c.requests.keys()],['b']);assert.equal(events.filter(e=>e.method==='serverRequest/resolved').length,2);
});
test('closing ignores stale protocol output and closes only once',async t=>{
 const c=make();await c.start();const pid=c.child.pid;await c.close();await c.close();assert.ok(pid);assert.ok(c.child.exitCode!==null||c.child.signalCode);
 c.consume('{"id":10,"method":"approval","params":{}}\n');assert.equal(c.requests.size,0);
});
test('only internal command exec may disable timeout; disconnect rejects long pending',async()=>{
 const c=make({timeout:5});c.write=()=>{};
 await assert.rejects(c.call('turn/start',{}, {timeoutMs:null}),/内部请求时限/);
 await assert.rejects(c.call('command/exec',{}, {timeoutMs:999}),/内部请求时限/);
 const waiting=c.call('command/exec',{}, {timeoutMs:null});const rejected=assert.rejects(waiting,/closed test/);
 await new Promise(r=>setTimeout(r,15));assert.equal(c.pending.size,1);assert.equal([...c.pending.values()][0].timer,null);c.fail(new Error('closed test'));await rejected;assert.equal(c.pending.size,0);
});

test('default app-server unload override is process-local and termination requires observed exit',async()=>{
 const defaults=new RpcClient();assert.deepEqual(defaults.args,['app-server','--listen','stdio://','-c','thread_unload_delay_secs=0']);
 const client=new RpcClient({closeTimeout:5});const signals=[];
 client.child=Object.assign(new EventEmitter(),{pid:123,exitCode:null,signalCode:null,stdin:{end(){}},kill(signal){signals.push(signal||'SIGTERM');return true;}});
 await assert.rejects(client.close(),e=>e.code==='CHILD_CLOSE_FAILED');assert.deepEqual(signals,['SIGTERM','SIGKILL']);
});
