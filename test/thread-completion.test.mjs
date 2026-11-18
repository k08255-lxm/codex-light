import test from 'node:test';
import assert from 'node:assert/strict';
import {createThreadCompletion,createTaskbarBadge} from '../public/ui/thread-completion.js';

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
