import test from 'node:test';
import assert from 'node:assert/strict';
import {ThreadSessions} from '../src/thread-sessions.mjs';
import {validateRpc} from '../src/security.mjs';

test('read and legacy resume remain read-only; completion before start response stays released',async()=>{
 const calls=[];let sessions;
 const rpc={call:async(method,params)=>{
  calls.push({method,params});
  if(method==='turn/start'){sessions.observe({method:'turn/started',params:{threadId:'t',turn:{id:'a'}}});sessions.observe({method:'turn/completed',params:{threadId:'t',turn:{id:'a'}}});return {turn:{id:'a',status:'inProgress'}};}
  if(method==='thread/unsubscribe')return {status:'unsubscribed'};
  return {thread:{id:'t'}};
 }};
 sessions=new ThreadSessions(rpc);
 await sessions.call('thread/read',{threadId:'t'});await sessions.call('thread/resume',{threadId:'t',excludeTurns:true});
 assert.deepEqual(calls.map(c=>c.method),['thread/read','thread/read']);
 await sessions.call('turn/start',{threadId:'t'});await new Promise(r=>setImmediate(r));
 assert.deepEqual(sessions.snapshot(),{threads:[]});
 assert.equal(calls.filter(c=>c.method==='thread/resume').length,1);
 assert.equal(calls.filter(c=>c.method==='thread/unsubscribe').length,1);
});

test('resume failure never submits work; uncertain start is retained and cannot restart',async()=>{
 let count=0;
 const sessions=new ThreadSessions({call:async method=>{if(method==='thread/resume')return {};if(method==='thread/unsubscribe')return {status:'unsubscribed'};count++;throw Object.assign(new Error('Unknown transport outcome'),{code:'RPC_TIMEOUT'});}});
 await assert.rejects(sessions.call('turn/start',{threadId:'t'}),e=>e.code==='RPC_TIMEOUT');
 assert.equal(sessions.snapshot().threads[0].state,'unknown');
 assert.equal((await sessions.call('thread/unsubscribe',{threadId:'t'})).status,'retained');
 await assert.rejects(sessions.call('turn/start',{threadId:'t'}),e=>e.code==='TURN_ACTIVE');assert.equal(count,1);
 await sessions.close();assert.deepEqual(sessions.snapshot().threads,[]);
 const noWork=new ThreadSessions({call:async()=>{throw Object.assign(new Error('Another client owns this'),{code:-32001});}});
 await assert.rejects(noWork.call('turn/start',{threadId:'t'}),e=>e.outcome==='notExecuted');assert.deepEqual(noWork.snapshot().threads,[]);
});

test('new empty threads stay loaded until first send because no rollout exists yet',async()=>{
 const calls=[];
 const sessions=new ThreadSessions({call:async(method,params)=>{calls.push(method);if(method==='thread/start')return {thread:{id:'new'}};if(method==='thread/resume')throw new Error('No rollout before first turn');if(method==='turn/start')return {turn:{id:'first',status:'inProgress'}};return {status:'unsubscribed'};}});
 await sessions.call('thread/start',{cwd:process.cwd()});assert.deepEqual(calls,['thread/start']);
 await sessions.call('turn/start',{threadId:'new'});assert.deepEqual(calls,['thread/start','turn/start']);
 sessions.observe({method:'turn/completed',params:{threadId:'new',turn:{id:'first'}}});await new Promise(r=>setImmediate(r));
 assert.deepEqual(calls,['thread/start','turn/start','thread/unsubscribe']);assert.deepEqual(sessions.snapshot(),{threads:[]});
});

test('first unsent turn failures preserve empty thread for retry until work begins or user discards it',async()=>{
 for(const code of ['INPUT_BACKPRESSURE','TOO_MANY_REQUESTS',-32602]){
  const calls=[];let attempt=0;
  const sessions=new ThreadSessions({call:async(method,params)=>{
   calls.push(method);
   if(method==='thread/start')return {thread:{id:'new'}};
   if(method==='thread/resume')throw new Error('No rollout exists for an unsent thread');
   if(method==='turn/start'){if(attempt++===0)throw Object.assign(new Error('First attempt not executed'),{code});return {turn:{id:'first',status:'inProgress'}};}
   return {status:'unsubscribed'};
  }});
  await sessions.call('thread/start',{cwd:process.cwd()});
  await assert.rejects(sessions.call('turn/start',{threadId:'new'}),e=>e.code===code);
  assert.deepEqual(calls,['thread/start','turn/start']);assert.equal(sessions.snapshot().threads[0].state,'idle');
  await sessions.call('turn/start',{threadId:'new'});assert.deepEqual(calls,['thread/start','turn/start','turn/start']);
  sessions.observe({method:'turn/completed',params:{threadId:'new',turn:{id:'first'}}});await new Promise(r=>setImmediate(r));
  assert.equal(calls.at(-1),'thread/unsubscribe');assert.deepEqual(sessions.snapshot().threads,[]);
 }
 const calls=[];const abandoned=new ThreadSessions({call:async method=>{calls.push(method);if(method==='thread/start')return {thread:{id:'draft'}};return {status:'unsubscribed'};}});
 await abandoned.call('thread/start',{});await abandoned.call('thread/unsubscribe',{threadId:'draft'});
 assert.deepEqual(calls,['thread/start','thread/unsubscribe']);assert.deepEqual(abandoned.snapshot().threads,[]);
});

test('steer schema validates expected ID, prohibits start overrides, preserves bounded UTF-8 text spans',()=>{
 const p={threadId:'t',expectedTurnId:'a',input:[{type:'text',text:'中文x',text_elements:[{byteRange:{start:0,end:6},placeholder:'中文'}]}]};
 assert.deepEqual(validateRpc('turn/steer',p),p);
 for(const params of [{...p,expectedTurnId:''},{...p,model:'m'},{...p,cwd:process.cwd()},{...p,effort:'high'},{...p,input:[{type:'localImage',path:'anything'}]},{...p,input:[{type:'text',text:'中',text_elements:[{byteRange:{start:1,end:3}}]}]},{...p,input:[{type:'text',text:'x',text_elements:[{byteRange:{start:0,end:2}}]}]}])assert.throws(()=>validateRpc('turn/steer',params));
 assert.deepEqual(validateRpc('turn/steer',{threadId:'t',expectedTurnId:'a',input:[{type:'text',text:'ok'}]}).input[0].text_elements,[]);
 for(const [method,params] of [['skills/list',{forceReload:true}],['skills/list',{cwds:['relative']}],['thread/unsubscribe',{}],['thread/compact/start',{threadId:'t',sandbox:'danger-full-access'}]])assert.throws(()=>validateRpc(method,params));
});

test('closing during resume cannot submit a turn after the load finishes',async()=>{
 let finishResume,loaded;const started=new Promise(resolve=>{loaded=resolve;});const calls=[];
 const sessions=new ThreadSessions({call:async method=>{calls.push(method);if(method==='thread/resume'){loaded();return new Promise(resolve=>{finishResume=resolve;});}return {};}});
 const work=sessions.call('turn/start',{threadId:'t'});const rejected=assert.rejects(work,e=>e.code==='CLIENT_CLOSING');
 await started;await sessions.close();finishResume({});await rejected;assert.deepEqual(calls,['thread/resume']);
});
