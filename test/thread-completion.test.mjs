import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createThreadCompletion,createTaskbarBadge,createThreadReadReporter} from '../public/ui/thread-completion.js';

const start=(threadId='thread',id='turn')=>({method:'turn/started',params:{threadId,turn:{id,status:'inProgress'}}});
const end=(status='completed',threadId='thread',id='turn')=>({method:'turn/completed',params:{threadId,turn:{id,status}}});

test('only a normal unseen completion produces a dot; activity, listing, failure and interruption do not',()=>{
  const state=createThreadCompletion();
  for(const message of [start(),{method:'item/completed',params:{threadId:'thread',item:{type:'agentMessage'}}},{method:'thread/list',params:{data:[{id:'thread',updatedAt:Date.now()}]}}]){
    state.observe(message);assert.equal(state.unread.size,0);
  }
  state.observe(end());assert.deepEqual([...state.unread.keys()],['thread']);
  state.observe(start('thread','second'));assert.equal(state.count,1);
  state.observe(end('failed','thread','second'));assert.equal(state.count,1);
  state.observe(start('thread','third'));state.observe(end('interrupted','thread','third'));assert.equal(state.count,1);
});

test('viewing the completing conversation suppresses a dot; reading clears it without replay restoring it',()=>{
  const state=createThreadCompletion();
  state.observe(start());state.observe(end(),'thread');assert.equal(state.unread.size,0);
  state.observe(start('thread','next'));state.observe(end('completed','thread','next'),'another');
  assert.equal(state.unread.has('thread'),true);
  state.read('another');assert.equal(state.unread.has('thread'),true);
  state.read('thread');assert.equal(state.unread.size,0);
  state.observe(end('completed','thread','next'));state.observe(start('thread','next'));state.observe(end('completed','thread','next'));
  assert.equal(state.unread.size,0);
});

test('a newer running turn ignores older and superseded completion/start replays',()=>{
  const state=createThreadCompletion();
  state.observe(start('thread','old'));state.observe(start('thread','new'));
  state.observe(end('completed','thread','old'));state.observe(start('thread','old'));
  state.observe(end('completed','thread','unobserved-old'));assert.equal(state.unread.size,0);
  state.observe(end('completed','thread','new'));assert.equal(state.unread.has('thread'),true);
  state.read('thread');state.observe(end('completed','thread','old'));assert.equal(state.unread.size,0);
});

test('a genuine completed notification can arrive without its start after a previous turn settled',()=>{
  const state=createThreadCompletion();
  state.observe(end('completed','thread','first'));state.read('thread');
  state.observe(end('completed','thread','second'));assert.equal(state.unread.has('thread'),true);
});

test('restored running turns, late previous completions and internal work leave the native counter clear',()=>{
  const messages=[];
  const badge=createTaskbarBadge(message=>messages.push(message));
  const state=createThreadCompletion(badge.setCompleted);
  badge.setCompleted(0);
  state.trackActive('conversation','running-after-reconnect');
  state.observe(end('completed','conversation','old'));
  for (const internal of [{id:'child',parentThreadId:'conversation'}, {id:'review',source:{subAgent:'review'}}, {id:'helper',ephemeral:true}]) {
    state.observe({method:'thread/started',params:{thread:internal}});
    state.observe(start(internal.id));
    state.observe(end('completed',internal.id));
  }
  state.observe({method:'item/completed',params:{threadId:'conversation',item:{type:'subAgentActivity',agentThreadId:'child-after-reconnect'}}});
  state.observe(end('completed','child-after-reconnect'));
  assert.deepEqual(messages.map(item=>item.count),[0]);
  badge.setQuestions(1,true);
  badge.setQuestions(0,false);
  state.observe(end('completed','conversation','running-after-reconnect'));
  assert.deepEqual(messages.map(({count,attention})=>[count,attention]),[[0,false],[1,true],[0,false],[1,false]]);
});

test('unknown terminal states and invalid identities cannot change completion state',()=>{
  const state=createThreadCompletion();state.observe(start());
  state.observe(end('inProgress'));state.observe(end(undefined,null));state.observe(end('completed','thread',{}));
  assert.equal(state.unread.size,0);
  state.observe(end());assert.equal(state.unread.has('thread'),true);
});

test('unread counts survive replay history eviction and reset clears account-scoped state',()=>{
  const state=createThreadCompletion();
  for(let index=0;index<1100;index++)state.observe(end('completed','thread-'+index,'turn'));
  assert.equal(state.count,1100);state.observe(end('completed','thread-0','turn'));assert.equal(state.count,1100);
  state.reset();assert.equal(state.unread.size,0);assert.equal(state.count,0);
  state.observe(start());state.observe(end());assert.equal(state.unread.has('thread'),true);
});

test('badge combines individual unread turns and outstanding questions, independently of notification preference',()=>{
  const messages=[];
  const badge=createTaskbarBadge(message=>messages.push(message));
  const state=createThreadCompletion(badge.setCompleted);
  badge.setCompleted(0);
  state.observe(end('completed','a','1'));state.observe(end('completed','a','2'));state.observe(end('completed','b','1'));
  state.observe(end('completed','a','2'));
  badge.setQuestions(2,true);badge.setQuestions(2,true);
  state.read('a');badge.setQuestions(1,false);state.read('b');badge.setQuestions(0,false);
  assert.deepEqual(messages.map(({count,attention})=>[count,attention]),[[0,false],[1,false],[2,false],[3,false],[5,true],[3,true],[2,false],[1,false],[0,false]]);
  assert.ok(messages.every(message=>message.type==='desktopTaskbarBadge'));
});

test('a mobile receipt only clears its exact completed turns and never consumes question badges',()=>{
  const messages=[];
  const badge=createTaskbarBadge(message=>messages.push(message));
  const state=createThreadCompletion(badge.setCompleted);
  state.observe(end('completed','first','same-id'));
  state.observe(end('completed','second','same-id'));
  state.observe(end('completed','first','newer'));
  badge.setQuestions(1,true);
  assert.equal(state.syncRead([{threadId:'first',turnIds:['same-id','already-read']}]),true);
  assert.deepEqual([...state.unread.get('first')],['newer']);
  assert.deepEqual([...state.unread.get('second')],['same-id']);
  assert.deepEqual(messages.at(-1),{type:'desktopTaskbarBadge',count:3,attention:true});
  assert.equal(state.syncRead([{threadId:'first',turnIds:['same-id']}]),false);
  state.observe(end('completed','first','already-read'));
  assert.equal(state.count,2,'a receipt arriving before the replay suppresses the completion');
  state.syncRead([{threadId:'first',turnIds:['newer']}]);
  assert.equal(state.unread.has('first'),false);
  assert.equal(state.unread.has('second'),true);
  assert.deepEqual(messages.at(-1),{type:'desktopTaskbarBadge',count:2,attention:true});
});

test('phone retries a read after reconnect and discards unacknowledged receipts when the scope changes',async()=>{
  const calls=[];
  let complete;
  const reporter=createThreadReadReporter(input=>{
    calls.push(input);
    return new Promise((resolve,reject)=>{complete={resolve,reject};});
  });
  reporter.connect('old-scope');
  reporter.record('thread',['first','first']);
  reporter.record('thread',['first','second']);
  reporter.disconnect();
  complete.reject(new Error('connection lost'));
  await tick();
  assert.equal(calls.length,1);

  reporter.connect('old-scope');
  assert.deepEqual(calls[1],{scope:'old-scope',threadId:'thread',turnIds:['first','second']});
  reporter.connect('new-scope');
  reporter.record('other-thread',['first']);
  complete.resolve();
  await tick();
  assert.deepEqual(calls[2],{scope:'new-scope',threadId:'other-thread',turnIds:['first']});
  complete.resolve();
  await tick();
  reporter.record('other-thread',['first']);
  assert.equal(calls.length,3);
});
