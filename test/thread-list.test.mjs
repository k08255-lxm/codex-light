import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,getEventListeners} from 'node:events';
import {ThreadListService} from '../src/thread-list.mjs';
import {RpcClient} from '../src/rpc.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(){const calls=[];return {calls,service:new ThreadListService({call(method,params,{signal}){const gate=deferred();calls.push({method,params,signal,...gate});return gate.promise;}})};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('thread list coalesces reordered identical parameters, preserving opaque fields and pagination',async()=>{
 const {service,calls}=fixture(),params={limit:30,searchTerm:'合成',sortKey:'updated_at',sortDirection:'desc'};
 const one=service.list(params),two=service.list({searchTerm:'合成',sortDirection:'desc',limit:30,sortKey:'updated_at'});await tick();assert.equal(calls.length,1);assert.deepEqual(calls[0].params,params);
 const page={data:[{id:'a',name:'合成',preview:'keep',cwd:'C:\\synthetic'}],nextCursor:'opaque/next',extra:{preserved:true}};calls[0].resolve(page);assert.deepEqual(await Promise.all([one,two]),[page,page]);assert.equal(service.inflight.size,0);
 const next=service.list({...params,cursor:page.nextCursor});await tick();assert.equal(calls[1].params.cursor,'opaque/next');calls[1].resolve({data:[],nextCursor:null});assert.deepEqual(await next,{data:[],nextCursor:null});
});

test('thread list never merges distinct search, cursor, archive, limit or sort filters',async()=>{
 const {service,calls}=fixture(),params={searchTerm:'AbC',limit:30};
 const pending=[params,{...params,searchTerm:'abc'},{...params,cursor:'p'},{...params,archived:true},{...params,limit:20},{...params,sortDirection:'asc'}].map(p=>service.list(p));await tick();assert.equal(calls.length,6);calls.forEach((call,i)=>call.resolve({data:[i]}));assert.deepEqual(await Promise.all(pending),calls.map((_,i)=>({data:[i]})));
});

test('cancel one waiter leaves shared work alive; last waiter frees work and listeners',async()=>{
 const {service,calls}=fixture(),a=new AbortController(),b=new AbortController();
 const one=service.list({limit:30},{signal:a.signal}),two=service.list({limit:30},{signal:b.signal});await tick();const rejected=assert.rejects(one,e=>e.code==='SEARCH_ABORTED');a.abort();await rejected;assert.equal(calls[0].signal.aborted,false);assert.equal(getEventListeners(a.signal,'abort').length,0);
 const rejectedTwo=assert.rejects(two,e=>e.code==='SEARCH_ABORTED');b.abort();await rejectedTwo;assert.equal(calls[0].signal.aborted,true);assert.equal(service.inflight.size,0);assert.equal(getEventListeners(b.signal,'abort').length,0);calls[0].reject(new Error('late failure'));
 const pre=new AbortController();pre.abort();await assert.rejects(service.list({},{signal:pre.signal}),e=>e.code==='SEARCH_ABORTED');assert.equal(calls.length,1);
});

test('completed pages and errors are never cached, including external deletion without events',async()=>{
 let rows=[{id:'old',name:'old'}],calls=0,error=false;
 const service=new ThreadListService({async call(){calls++;if(error)throw new Error('synthetic failure');return {data:structuredClone(rows),nextCursor:null};}});
 assert.equal((await service.list({})).data[0].name,'old');rows[0].name='renamed';assert.equal((await service.list({})).data[0].name,'renamed');rows=[];assert.deepEqual((await service.list({})).data,[]);
 error=true;await assert.rejects(service.list({}),/synthetic failure/);error=false;assert.deepEqual((await service.list({})).data,[]);assert.equal(calls,5);
});

test('mutation boundaries prevent old in-flight snapshots from being reused or deleting new entries',async()=>{
 const {service,calls}=fixture(),gate=deferred();const before=service.list({});await tick();const mutation=service.mutate(()=>gate.promise);const during=service.list({});await tick();assert.equal(calls.length,2);gate.resolve();await mutation;
 const after=service.list({});await tick();assert.equal(calls.length,3);calls[0].resolve({data:['before']});calls[1].resolve({data:['during']});await Promise.all([before,during]);assert.equal(service.inflight.size,1);calls[2].resolve({data:['after']});assert.deepEqual(await after,{data:['after']});
});

test('events and failed mutations invalidate shared snapshots',async()=>{
 for(const method of ['thread/started','thread/name/updated','thread/archived','thread/deleted','turn/started','turn/completed','account/updated','bridge/status']){
  const {service,calls}=fixture(),before=service.list({});await tick();service.observe({method});const after=service.list({});await tick();assert.equal(calls.length,2,method);calls.forEach(call=>call.resolve({data:[]}));await Promise.all([before,after]);
 }
 const {service,calls}=fixture(),before=service.list({});await tick();await assert.rejects(service.mutate(async()=>{throw new Error('mutation unknown');}),/unknown/);const after=service.list({});await tick();assert.equal(calls.length,2);calls.forEach(call=>call.resolve({data:[]}));await Promise.all([before,after]);
});

test('HTTP close aborts list waiter and removes listener; already destroyed response sends nothing',async()=>{
 const {service,calls}=fixture(),res=new EventEmitter();res.setHeader=()=>assert.fail('no response on disconnect');const request=service.http({},res,{});await tick();res.destroyed=true;const rejected=assert.rejects(request,e=>e.code==='SEARCH_ABORTED');res.emit('close');await rejected;assert.equal(calls[0].signal.aborted,true);assert.equal(res.listenerCount('close'),0);calls[0].resolve({data:[]});
 await assert.rejects(service.http({},res,{}),e=>e.code==='SEARCH_ABORTED');assert.equal(calls.length,1);
});

function clientFixture(options={}){const rpc=new RpcClient({timeout:1000,...options}),writes=[];rpc.write=message=>writes.push(message);return {rpc,writes};}
test('RPC cancellation drops pending timer/listener, ignores late reply and sends no cancel/turn interruption',async()=>{
 const {rpc,writes}=clientFixture(),controller=new AbortController();const pending=rpc.call('thread/list',{limit:30},{signal:controller.signal});assert.equal(rpc.pending.size,1);const rejected=assert.rejects(pending,e=>e.code==='SEARCH_ABORTED');controller.abort();await rejected;assert.equal(rpc.pending.size,0);assert.equal(getEventListeners(controller.signal,'abort').length,0);rpc.consume(JSON.stringify({id:writes[0].id,result:{data:[]}})+'\n');assert.equal(writes.length,1);assert.equal(rpc.connected,false);
});
test('RPC abort before or during path mapping prevents sending; signals disallowed for writes',async()=>{
 const gate=deferred(),{rpc,writes}=clientFixture({mapRequest:async params=>{await gate.promise;return params;}}),controller=new AbortController();
 const pending=rpc.call('thread/list',{}, {signal:controller.signal});controller.abort();gate.resolve();await assert.rejects(pending,e=>e.code==='SEARCH_ABORTED');await assert.rejects(rpc.call('thread/list',{}, {signal:controller.signal}),e=>e.code==='SEARCH_ABORTED');assert.equal(writes.length,0);assert.equal(rpc.pending.size,0);
 await assert.rejects(rpc.call('turn/start',{}, {signal:new AbortController().signal}),e=>e.code==='INVALID_TIMEOUT');
});
test('RPC success, error, timeout, disconnect and write failure remove abort listeners',async()=>{
 for(const mode of ['success','error','timeout','disconnect','write']){
  const {rpc,writes}=clientFixture({timeout:5}),controller=new AbortController();if(mode==='write')rpc.write=()=>{throw new Error('write failed');};
  const pending=rpc.call('thread/list',{}, {signal:controller.signal}),checked=mode==='success'?pending:assert.rejects(pending);
  if(mode==='success')rpc.consume(JSON.stringify({id:writes[0].id,result:{data:[]}})+'\n');if(mode==='error')rpc.consume(JSON.stringify({id:writes[0].id,error:{message:'failed'}})+'\n');if(mode==='disconnect')rpc.fail(new Error('disconnect'));
  await checked;assert.equal(getEventListeners(controller.signal,'abort').length,0,mode);assert.equal(rpc.pending.size,0,mode);
 }
});
