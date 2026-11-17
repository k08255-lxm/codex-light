import test from 'node:test';
import assert from 'node:assert/strict';
import {createThreadCompletion} from '../public/ui/thread-completion.js';

const start=(threadId='thread',id='turn')=>({method:'turn/started',params:{threadId,turn:{id,status:'inProgress'}}});
const end=(status='completed',threadId='thread',id='turn')=>({method:'turn/completed',params:{threadId,turn:{id,status}}});

test('only a normal unseen completion produces a dot; activity, listing, failure and interruption do not',()=>{
  const state=createThreadCompletion();
  for(const message of [start(),{method:'item/completed',params:{threadId:'thread',item:{type:'agentMessage'}}},{method:'thread/list',params:{data:[{id:'thread',updatedAt:Date.now()}]}}]){
    state.observe(message);assert.equal(state.unread.size,0);
  }
  state.observe(end());assert.deepEqual([...state.unread],['thread']);
  state.observe(start('thread','second'));assert.equal(state.unread.size,0);
  state.observe(end('failed','thread','second'));assert.equal(state.unread.size,0);
  state.observe(start('thread','third'));state.observe(end('interrupted','thread','third'));assert.equal(state.unread.size,0);
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

test('reset clears account-scoped state and unread bookkeeping remains bounded',()=>{
  const state=createThreadCompletion();
  for(let index=0;index<1100;index++)state.observe(end('completed','thread-'+index,'turn'));
  assert.equal(state.unread.size,1000);state.reset();assert.equal(state.unread.size,0);
  state.observe(start());state.observe(end());assert.equal(state.unread.has('thread'),true);
});
