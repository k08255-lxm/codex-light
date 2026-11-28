import test from 'node:test';import assert from 'node:assert/strict';
import {assertUpdateIdle,reconcileUpdateWork,UpdateReservation} from '../src/app-update-safety.mjs';
import {DshReadService} from '../src/dsh-read.mjs';
const idle=()=>({rpc:{connected:true,requests:new Map()},sessions:{queues:new Map(),snapshot:()=>({threads:[]})},terminal:{sessions:new Map()},dsh:{threads:new Map(),pending:new Map()},operations:{entries:new Map()},runtime:{busy:()=>false},requestId:'update'});
test('idle snapshot permitted; missing snapshot rejected',()=>{assertUpdateIdle(idle());assert.throws(()=>assertUpdateIdle({}),/运行任务/);});
for(const [name,mutate] of Object.entries({disconnected:s=>s.rpc.connected=false,turn:s=>s.runtime.busy=()=>true,approval:s=>s.rpc.requests.set('r',{}),queue:s=>s.sessions.queues.set('q',{}),unknown:s=>s.sessions.snapshot=()=>({threads:[{state:'unknown'}]}),terminal:s=>s.terminal.sessions.set('p',{state:'running'}),dsh:s=>s.dsh.threads.set('t',{tasks:new Map([['a',{status:'running'}]])}),dshUnknown:s=>s.dsh.threads.set('t',{tasks:new Map([['a',{}]])}),operation:s=>s.operations.entries.set('x',{state:'unknown'}),reader:s=>s.dsh.releaseError='error'}))test('blocks '+name,()=>{const s=idle();mutate(s);assert.throws(()=>assertUpdateIdle(s),e=>e.code==='APP_UPDATE_WORK_ACTIVE');});
test('current update operation does not block itself',()=>{const s=idle();s.operations.entries.set('update',{state:'pending'});assertUpdateIdle(s);});
test('settled DSH task history permits updates, even after a failure or explicit close',()=>{
 const state=idle(),tasks=new Map(['idle','error','closed','canceled','completed'].map(status=>[status,{status}]));
 state.dsh.threads.set('thread',{tasks});assertUpdateIdle(state);
 tasks.set('new',{status:'interrupting'});assert.throws(()=>assertUpdateIdle(state),/DSH 子代理/);
});
test('reservation blocks new work; definite no action releases it',async()=>{const gate=new UpdateReservation();await assert.rejects(gate.run(()=>{},()=>Promise.reject(Object.assign(new Error('no'),{outcome:'notExecuted'}))));assert.equal(gate.reserved,false);await gate.run(()=>{},async()=>{});assert.throws(()=>gate.assertOpen(),e=>e.code==='APP_UPDATE_RESERVED');});
test('uncertain outcome keeps reservation and prevents retry',async()=>{const gate=new UpdateReservation();await assert.rejects(gate.run(()=>{},async()=>{throw new Error('unknown');}));assert.equal(gate.reserved,true);});

test('a DSH information card is not a worker; a recorded dispatch requires a current status',async()=>{
 const state=idle();state.sessions.entries=new Map();
 let status='running';const calls=[];
 state.dsh=new DshReadService({connected:true,call:async(method,p)=>{
  if(method==='thread/start')return {thread:{id:'reader',cwd:process.cwd()}};
  calls.push(p.tool);
  return {structuredContent:{agent_id:'child',parent_thread_id:'thread',status}};
 }});
 state.dsh.bindThread({id:'thread',cwd:process.cwd()});
 const item=(id,tool,result)=>({id,type:'mcpToolCall',server:'dsh_subagent',tool,status:'completed',arguments:{},result:{structuredContent:result}});
 state.dsh.observe('thread',item('doctor','dsh_doctor',{}),{older:true});
 assertUpdateIdle(state);
 state.dsh.observe('thread',item('spawn','dsh_start',{agent_id:'child',status:'running'}),{older:true});
 await reconcileUpdateWork(state);assert.throws(()=>assertUpdateIdle(state),/DSH 子代理/);
 status='interrupted';await reconcileUpdateWork(state);assertUpdateIdle(state);
 assert.deepEqual(calls,['dsh_status','dsh_status']);
});
