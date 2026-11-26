import test from 'node:test';
import assert from 'node:assert/strict';
import {createTurnActions,createTurnUsageSource} from '../public/ui/turn-actions.js';
import {createDocument} from './mini-dom.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('log recovery refreshes an open breakdown and rechecks unmounted turns on return',async()=>{
  let recovered=false;
  const calls=[],source=createTurnUsageSource(async(_thread,ids)=>{
    calls.push(ids);
    return {turns:recovered?ids.map(turnId=>({turnId,tokens:{inputTokens:8,totalTokens:8},estimatedCost:{usd:0.000016,complete:true,components:[{kind:'inputIncludingCacheWrite',tokens:8,pricePerMillion:2,usd:0.000016}]}})):[]};
  });
  const view=createTurnActions(createDocument(),{threadId:'thread',turnId:'active',source});
  const leave=source.watch('thread','old',()=>{});await settle();leave();
  view.node.querySelector('[aria-label="本轮用量"]').click();await settle();
  const panel=view.node.querySelector('.turn-usage-popover');
  assert.match(panel.textContent,/此轮未记录用量/);
  recovered=true;source.recovered();await settle();
  assert.deepEqual(calls.at(-1),['active']);assert.match(panel.textContent,/输入（含缓存写入）/);
  assert.match(panel.textContent,/0\.000016/);
  source.watch('thread','old',()=>{});await settle();assert.deepEqual(calls.at(-1),['old']);
  view.release();
});
test('answers batch visible turn IDs and ignore a previous conversation response',async()=>{
  const requests=[],received=[];
  const source=createTurnUsageSource((threadId,turnIds)=>new Promise(resolve=>requests.push({threadId,turnIds,resolve})));
  const listen=next=>received.push(next.value);
  source.watch('one','a',listen);source.watch('one','b',listen);
  await settle();assert.deepEqual(requests[0].turnIds,['a','b']);
  source.clear();source.watch('two','a',listen);await settle();
  requests[0].resolve({turns:[{turnId:'a',model:'old'}]});
  requests[1].resolve({turns:[{turnId:'a',model:'new'}]});await settle();
  assert.deepEqual(received,[{turnId:'a',model:'new'}]);
  source.watch('two','a',listen);await settle();assert.equal(requests.length,2);
});
test('answer actions copy the retained response and branch once through this turn',async()=>{
  const doc=createDocument(),copies=[],forks=[];
  let finish;
  const view=createTurnActions(doc,{threadId:'thread',turnId:'early',
    onCopy:async text=>copies.push(text),
    onFork:(thread,turn)=>{forks.push([thread,turn]);return new Promise(resolve=>{finish=resolve;});},
    source:createTurnUsageSource(async()=>({turns:[{turnId:'early',tokens:{totalTokens:12345}}]}))});
  view.update('final response',true);await settle();
  const [copy,fork,usage]=view.node.children;
  copy.click();fork.click();fork.click();await settle();
  assert.deepEqual(copies,['final response']);assert.deepEqual(forks,[['thread','early']]);
  assert.match(usage.textContent,/12,345 tokens/);
  finish();view.release();
});
