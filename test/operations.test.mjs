import test from 'node:test';import assert from 'node:assert/strict';import {OperationStore} from '../src/operations.mjs';
const make=options=>new OperationStore({serverInstance:'test-instance',now:()=>1800000000000,...options});
const id=(suffix='operation-1',time=1800000000000)=>`test-instance:${time}:${suffix}`;
test('same operation ID coalesces concurrent requests and preserves completed result',async()=>{
 const s=make();let calls=0;const run=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return {thread:{id:'a'}};};
 const [a,b]=await Promise.all([s.execute(id(),'thread/start',{cwd:'x',model:'m'},run),s.execute(id(),'thread/start',{model:'m',cwd:'x'},run)]);
 assert.equal(calls,1);assert.deepEqual(a,b);assert.equal(s.get(id()).state,'succeeded');
 assert.deepEqual(await s.execute(id(),'thread/start',{cwd:'x',model:'m'},run),a);assert.equal(calls,1);
});
test('different payload never reuses an ID, including when original is pending',async()=>{
 const s=make();let finish;const promise=s.execute(id(),'turn/start',{text:'first'},()=>new Promise(r=>{finish=r;}));await Promise.resolve();
 assert.throws(()=>s.execute(id(),'turn/start',{text:'second'},()=>{}),e=>e.code==='REQUEST_ID_CONFLICT'&&e.outcome==='unknown');finish({ok:1});await promise;
});
test('timeout remains unknown and retrying the same ID does not execute again',async()=>{
 const s=make();let calls=0;const run=()=>{calls++;throw Object.assign(new Error('timeout'),{code:'RPC_TIMEOUT'});};
 await assert.rejects(s.execute(id(),'turn/start',{},run));await assert.rejects(s.execute(id(),'turn/start',{},run));assert.equal(calls,1);assert.equal(s.get(id()).state,'unknown');
});
test('expired IDs never execute even after pruning and restarting rejects old instance',()=>{
 const s=make();assert.throws(()=>s.execute(id('operation-old',1800000000000-86400001),'turn/start',{},()=>{}),e=>e.code==='REQUEST_EXPIRED');
 assert.throws(()=>s.execute('previous-instance:1800000000000:operation-1','turn/start',{},()=>{}),e=>e.code==='REQUEST_INSTANCE_CHANGED');
 assert.equal(s.get('previous-instance:1800000000000:operation-1').state,'unknown');
});
test('capacity exhaustion rejects before execution and no silent eviction',async()=>{
 const s=make({limit:1});await s.execute(id(),'thread/start',{},()=>({ok:true}));
 assert.throws(()=>s.execute(id('operation-2'),'thread/start',{},()=>{}),e=>e.code==='OPERATION_LIMIT'&&e.outcome==='notExecuted');assert.equal(s.entries.size,1);
});
test('invalid IDs and clock skew are rejected; unsent failures are distinguished',async()=>{
 const s=make();for(const value of [null,'uuid-only','test-instance:bad:operation-1'])assert.throws(()=>s.execute(value,'turn/start',{},()=>{}));
 assert.throws(()=>s.execute(id('operation-1',1800000300001),'turn/start',{},()=>{}),e=>e.code==='REQUEST_IN_FUTURE');
 await assert.rejects(s.execute(id(),'turn/start',{},()=>{throw Object.assign(new Error('busy'),{code:'INPUT_BACKPRESSURE'});}));assert.equal(s.get(id()).outcome,'notExecuted');
});
test('completed result is a stable snapshot, not a mutable backend object',async()=>{
 const s=make();const source={turn:{id:'one',status:'inProgress'}};const result=await s.execute(id(),'turn/start',{},()=>source);source.turn.status='completed';assert.equal(result.turn.status,'inProgress');assert.equal(s.get(id()).result.turn.status,'inProgress');
});
