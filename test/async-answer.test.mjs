import test from 'node:test';
import assert from 'node:assert/strict';
import {createAsyncAnswerSender} from '../public/async-answer.js';
const base=()=>({connected:true,serverInstance:'instance',sending:false,thread:{id:'parent',cwd:'C:\\parent'},threads:[{id:'child',cwd:'C:\\child'}]});
test('async answers steer the question thread without consuming the composer draft',async()=>{
 const state=base(),calls=[];
 const send=createAsyncAnswerSender({state,sessionFor:id=>id==='child'?{activeTurnId:'child-turn'}:null,performMutation:async(...args)=>{calls.push(args);return {turnId:'child-turn'};}});
 assert.deepEqual(await send({threadId:'child',itemId:'question',text:'answer'}),{status:'sent'});
 assert.deepEqual(calls,[['turn/steer',{threadId:'child',input:[{type:'text',text:'answer'}],expectedTurnId:'child-turn'}]]);
 assert.equal(state.thread.id,'parent');assert.equal(state.sending,false);
});
test('idle question replies inherit their own thread model, settings and cwd',async()=>{
 const calls=[];const send=createAsyncAnswerSender({state:base(),sessionFor:()=>null,performMutation:async(...args)=>{calls.push(args);return {turn:{id:'new'}};}});
 await send({threadId:'child',itemId:'question',text:'answer'});
 assert.deepEqual(calls,[['turn/start',{threadId:'child',input:[{type:'text',text:'answer'}],cwd:'C:\\child'}]]);
});
test('unknown acknowledgement never reports a confirmed answer or retries',async()=>{
 let calls=0;const state=base(),send=createAsyncAnswerSender({state,sessionFor:()=>null,performMutation:async()=>{calls++;throw Object.assign(new Error('timeout'),{outcome:'unknown'});}});
 assert.equal((await send({threadId:'child',itemId:'question',text:'answer'})).status,'unknown');assert.equal(calls,1);assert.equal(state.sending,false);
});
test('pending send prevents a second question submission',async()=>{
 const state=base(),send=createAsyncAnswerSender({state,sessionFor:()=>null,hasPending:()=>true,performMutation:()=>assert.fail('must not submit')});
 await assert.rejects(send({threadId:'child',itemId:'question',text:'answer'}),/等待确认/);
});

test('a missing question directory never borrows the currently open project',async()=>{
 const state=base();state.threads=[];
 const send=createAsyncAnswerSender({state,sessionFor:()=>null,performMutation:()=>assert.fail('must not submit')});
 await assert.rejects(send({threadId:'child',itemId:'question',text:'answer'}),/工作目录/);assert.equal(state.sending,false);
});

test('environment changes during directory resolution do not send the answer',async()=>{
 const state=base(),send=createAsyncAnswerSender({state,sessionFor:()=>null,getCwd:async()=>{state.serverInstance='new';return 'C:\\child';},performMutation:()=>assert.fail('must not submit')});
 await assert.rejects(send({threadId:'child',itemId:'question',text:'answer'}),/环境已变化/);assert.equal(state.sending,false);
});
