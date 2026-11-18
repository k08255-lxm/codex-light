import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentHistory,mergeAgentTurns} from '../public/agent-history.js';
import {Manager} from '../components/dsh-bridge/src/manager.mjs';
import {dshHistoryPage} from '../public/dsh.js';

test('native history keeps a stable earlier cursor while refreshing the newest task',async()=>{
 const turns=Array.from({length:5},(_,index)=>({id:`turn-${index}`,status:'completed',items:[{id:`message-${index}`}]}));
 const calls=[];
 const history=new AgentHistory(async(method,params)=>{
  calls.push({method,params});assert.equal(params.threadId,'agent');
  if(method==='thread/read')return {thread:{id:'agent'}};
  assert.equal(method,'thread/turns/list');
  // The engine cursor is anchored to the oldest visible turn, even with a new tail.
  const desc=[...turns].reverse(),index=params.cursor?desc.findIndex(turn=>turn.id===params.cursor)+1:0;
  const data=desc.slice(index,index+params.limit);
  return {data,nextCursor:index+params.limit<desc.length?data.at(-1).id:null};
 },'agent');
 const first=await history.newest();assert.deepEqual(first.turns.map(t=>t.id),['turn-2','turn-3','turn-4']);
 turns.push({id:'turn-5',status:'inProgress',items:[{id:'message-5'}]});
 const latest=await history.newest();assert.deepEqual(latest.turns.map(t=>t.id),['turn-5']);
 const older=await history.older();assert.equal(calls.at(-1).params.cursor,'turn-2');
 const historyTurns=mergeAgentTurns(mergeAgentTurns(first.turns,latest.turns),older,{older:true});
 assert.deepEqual(historyTurns.map(t=>t.id),turns.map(t=>t.id));
 assert.equal(history.hasOlder,false);
});

test('native cursor failures can retry, and an old parent cannot settle a request after switching',async()=>{
 let first=true,current=true,settle;
 const old={id:'old',items:[{id:'older'}]},newest={id:'newest',items:[{id:'recent'}]};
 const history=new AgentHistory(async(method,params)=>{
  if(method==='thread/read')return {thread:{id:'agent'}};
  if(!params.cursor)return {data:[newest],nextCursor:'older'};
  if(first){first=false;throw new Error('temporary read failure');}
  return new Promise(resolve=>{settle=()=>resolve({data:[old]});});
 },'agent',()=>current);
 await history.newest();await assert.rejects(history.older(),/temporary/);assert.equal(history.hasOlder,true);
 const pending=history.older();current=false;settle();
 await assert.rejects(pending,error=>error.stale===true);assert.equal(history.hasOlder,true);
});

test('DSH SQLite history exposes original prompts, numbered tasks and preceding pages over 100 records',()=>{
 const manager=new Manager({database:':memory:'});
 try{
  manager.save({id:'agent',status:'completed'});
  for(let task=1;task<=5;task++){
   manager.event('agent','turn/start',{});
   manager.event('agent','bridge/prompt',{task:`Dispatch ${task}`});
   for(let item=0;item<23;item++)manager.event('agent','tool/start',{name:`tool ${task}/${item}`});
   manager.event('agent','assistant/message',{text:`Output ${task}`});
   manager.event('agent','turn/end',{reason:{kind:'completed'}});
  }
  const newest=manager.historyEvents('agent');
  assert.equal(newest.direction,'backward');assert.equal(newest.has_older,true);
  assert.deepEqual([...new Set(newest.events.map(e=>e.taskTurn))],[3,4,5]);
  assert.ok(newest.events.some(event=>event.type==='user/message'&&event.text==='Dispatch 4'));
  assert.ok(newest.events.some(event=>event.type==='assistant/final'&&event.text==='Output 5'));
  const firstPage=dshHistoryPage({structuredContent:newest});
  assert.equal(firstPage.agentId,'agent');assert.ok(firstPage.hasOlder);
  let page=newest,events=newest.events;
  while(page.has_older){const prior=page.before_cursor;page=manager.historyEvents('agent',prior);if(page.has_older)assert.ok(page.before_cursor<prior);events=[...page.events,...events];}
  assert.ok(events.length>100);assert.equal(new Set(events.map(e=>e.seq)).size,events.length);
  assert.deepEqual([...new Set(events.map(e=>e.taskTurn))],[1,2,3,4,5]);
  assert.ok(events.some(event=>event.type==='user/message'&&event.text==='Dispatch 1'));
  manager.event('agent','turn/start',{});manager.event('agent','bridge/prompt',{task:'Dispatch 6'});
  const newer=manager.publicEvents('agent',newest.tail_cursor,30,{includeProgress:true,includeToolEvents:true,includeTaskHistory:true});
  assert.deepEqual(newer.events.map(e=>[e.type,e.taskTurn]),[['task/start',6],['user/message',6]]);
 }finally{manager.db.close();}
});
