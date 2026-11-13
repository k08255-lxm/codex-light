import test from 'node:test';
import assert from 'node:assert/strict';
import { DshTaskStore, dshStatusSnapshot } from '../public/dsh.js';
import { createAgentInspector } from '../public/ui/agent-inspector.js';
import { createDocument } from './mini-dom.mjs';

const item=(id,tool,args={},result={},status='completed',extra={})=>({id,type:'mcpToolCall',server:'dsh_subagent',tool,arguments:args,result:{structuredContent:result},status,...extra});
const store=()=>{const s=new DshTaskStore();s.reset('thread-a');return s;};
const compact=status=>dshStatusSnapshot({content:[{type:'text',text:JSON.stringify(status)}]});
function runtime(row){
 const document=createDocument(),host=document.createElement('div');document.body.append(host);
 const el=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls;if(text!=null)node.textContent=text;return node;};
 const state={connected:false,thread:{id:row.threadId||'thread-a',cwd:'C:/work'},dshReadErrors:new Map(),store:{values:()=>[]}};
 const inspector=createAgentInspector({document,state,host,el,dshTasks:{values:()=>[row]},dshLive:{selectAgent(){},snapshot:()=>({})},readDshTask:async()=>{}});
 inspector.render();
 return host.querySelector('.agent-runtime');
}

test('compact status without a start time still shows a running duration from the parent dispatch',()=>{
 const s=store(),started=Date.now()-5000;
 s.ingest('thread-a',item('start','dsh_start',{},{agent_id:'a',status:'running'},'inProgress',{_startedAtMs:started}));
 assert.equal(s.values()[0].runStartedAtMs,started);
 s.ingestLiveStatus('thread-a','a',compact({status:'running',updated_at:new Date().toISOString()}),{checkedAt:new Date().toISOString()});
 const task=s.values()[0];
 assert.equal(task.runStartedAtMs,started);
 assert.equal(task.started_at,undefined);assert.equal(task.created_at,undefined);
 const node=runtime(task);
 assert.equal(node.dataset.start,String(started));
 assert.match(node.textContent,/^运行 \d+s$/);
 assert.notEqual(node.textContent,'时长不详');
});

test('repeating the same dispatch item never resets its run start',()=>{
 const s=store();
 s.ingest('thread-a',item('start','dsh_start',{},{agent_id:'a',status:'running'},'inProgress',{_startedAtMs:1000}));
 s.ingest('thread-a',item('start','dsh_start',{},{agent_id:'a',status:'running'},'inProgress',{_startedAtMs:9000}));
 assert.equal(s.values()[0].runStartedAtMs,1000);
 assert.equal(s.values()[0].runStartedAtCallId,'start');
 assert.equal(runtime(s.values()[0]).dataset.start,'1000');
});

test('compact status and list reads preserve the captured run start',()=>{
 const s=store();
 s.ingest('thread-a',item('start','dsh_start',{},{agent_id:'a',status:'running'},'inProgress',{_startedAtMs:2000}));
 s.ingestLiveStatus('thread-a','a',compact({status:'running',updated_at:'2026-11-11T12:00:00.000Z'}),{checkedAt:'2026-11-11T12:00:01.000Z'});
 s.ingestLiveList('thread-a',{items:[{agent_id:'a',status:'running',updated_at:'2026-11-11T12:00:02.000Z'}],count:1,matched:1,total:1},{checkedAt:'2026-11-11T12:00:03.000Z'});
 const task=s.values()[0];
 assert.equal(task.runStartedAtMs,2000);
 assert.equal(task.started_at,undefined);
 assert.equal(task.created_at,undefined);
});

test('a new followup call resets the run start, while older history and old created_at do not roll it back',()=>{
 const s=store();
 s.ingest('thread-a',item('start','dsh_start',{},{agent_id:'a',status:'running'},'inProgress',{_startedAtMs:1000}));
 s.ingest('thread-a',item('follow-old','dsh_followup',{agent_id:'a'},{agent_id:'a',status:'running'},'inProgress',{_startedAtMs:5000}));
 s.ingest('thread-a',item('follow-1','dsh_followup',{agent_id:'a'},{agent_id:'a',status:'running'},'inProgress',{_startedAtMs:9000}));
 let task=s.values()[0];
 assert.equal(task.runStartedAtMs,9000);assert.equal(task.runStartedAtSource,'dispatch_started_at');assert.equal(task.runStartedFromFollowup,true);
 // A stale replay of an already seen followup call and an explicit older page must both keep the newer run start.
 s.ingest('thread-a',item('follow-old','dsh_followup',{agent_id:'a'},{agent_id:'a',status:'running'},'inProgress',{_startedAtMs:5000}));
 s.ingest('thread-a',item('follow-older','dsh_followup',{agent_id:'a'},{agent_id:'a',status:'running'},'inProgress',{_startedAtMs:4000}),{older:true});
 s.ingestLiveList('thread-a',{items:[{agent_id:'a',status:'running',created_at:'2020-01-01T00:00:00.000Z',updated_at:'2026-11-11T12:00:02.000Z'}],count:1,matched:1,total:1},{checkedAt:'2026-11-11T12:00:03.000Z'});
 task=s.values()[0];
 assert.equal(task.runStartedAtMs,9000);
 assert.equal(runtime(task).dataset.start,'9000');
});

test('a failed or rejected dispatch never starts a timer',()=>{
 for(const failed of [
  item('bad','dsh_followup',{agent_id:'a'},{agent_id:'a',status:'running'},'failed',{_startedAtMs:9000}),
  item('bad','dsh_followup',{agent_id:'a'},{agent_id:'a',status:'running',accepted:false},'completed',{_startedAtMs:9000}),
 ]){
  const s=store();s.ingest('thread-a',failed);
  const task=s.values()[0];
  assert.equal(task.runStartedAtMs,undefined);assert.equal(task.runStartedAtCallId,undefined);
  assert.equal(runtime(task).textContent,'时长不详');
 }
});

test('a followup drops the prior run timestamp and unseen stale calls cannot move its clock back',()=>{
 const s=store(),base=Date.parse('2026-11-13T05:00:00Z');
 s.ingest('thread-a',item('start','dsh_start',{},{agent_id:'a',status:'running',started_at:new Date(base).toISOString()},'completed',{_startedAtMs:base}));
 s.ingest('thread-a',item('follow','dsh_followup',{agent_id:'a'},{agent_id:'a',status:'running'},'completed',{_startedAtMs:base+60000}));
 assert.equal(s.values()[0].started_at,undefined);
 assert.equal(runtime(s.values()[0]).dataset.start,String(base+60000));
 s.ingest('thread-a',item('unseen-old','dsh_followup',{agent_id:'a'},{agent_id:'a',status:'running'},'completed',{_startedAtMs:base+30000}));
 assert.equal(s.values()[0].runStartedAtMs,base+60000);
});

test('compact evidence without any trusted timestamp remains unknown',()=>{
 const s=store();
 s.ingest('thread-a',item('status','dsh_status',{agent_id:'a'},{agent_id:'a',status:'running',updated_at:'2026-11-11T12:00:00.000Z'}));
 const task=s.values()[0];
 assert.equal(task.runStartedAtMs,undefined);
 assert.equal(runtime(task).textContent,'时长不详');
});

test('explicit started_at wins, the start created_at can beat dispatch, and completed uses updated_at',()=>{
 const explicit={agentId:'a',threadId:'thread-a',status:'completed',started_at:'2026-11-11T12:00:02.000Z',runStartedAtMs:1000,updated_at:'2026-11-11T12:00:07.000Z'};
 let node=runtime(explicit);
 assert.equal(node.dataset.start,String(Date.parse('2026-11-11T12:00:02.000Z')));
 assert.equal(node.textContent,'用时 5s');
 const s=store();
 s.ingest('thread-a',item('start','dsh_start',{},{agent_id:'a',status:'running',created_at:'2026-11-11T12:00:01.000Z'},'inProgress',{_startedAtMs:Date.parse('2026-11-11T12:00:09.000Z')}));
 const task=s.values()[0];
 assert.equal(task.runStartedAtMs,Date.parse('2026-11-11T12:00:01.000Z'));
 assert.equal(task.runStartedAtSource,'created_at');
 node=runtime({...task,status:'completed',updated_at:'2026-11-11T12:00:06.000Z'});
 assert.equal(node.textContent,'用时 5s');
});
