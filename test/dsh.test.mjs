import test from 'node:test';
import assert from 'node:assert/strict';
import { DshTaskStore, dshConnectionSummary, dshStatusLabel, isDshItem, dshListSnapshot, dshEventsSnapshot, dshStatusSnapshot } from '../public/dsh.js';
const item = (id, tool, args={}, result={}, status='completed') => ({id,type:'mcpToolCall',server:'dsh_subagent',tool,arguments:args,result:{structuredContent:result},status});
const store = () => {const s=new DshTaskStore();s.reset('thread-a');return s;};
test('MCP tools present or authenticated is not connected evidence',()=>{let c=dshConnectionSummary([{name:'dsh_subagent',authStatus:'oAuth',tools:{dsh_start:{}}}]);assert.equal(c.connected,false);assert.match(c.label,/尚未检查会话连接/);c=dshConnectionSummary([{name:'dsh_subagent',runtimeStatus:'failed',authStatus:'oAuth'}]);assert.equal(c.connected,false);assert.match(c.label,/连接失败/);c=dshConnectionSummary([{name:'dsh_subagent',runtimeStatus:'connected',tools:{}}]);assert.equal(c.connected,true);});
test('other servers cannot be misidentified as DSH',()=>{assert.equal(isDshItem({...item('a','dsh_start'),server:'unrelated'}),false);assert.equal(dshConnectionSummary([{name:'other',runtimeStatus:'connected'}]).connected,false);});
test('completed MCP call does not imply completed DSH task',()=>{const s=store();s.ingest('thread-a',item('call','dsh_start'));const t=s.values()[0];assert.equal(t.status,undefined);assert.match(dshStatusLabel(t),/任务状态未知/);});
test('started provisional card migrates to returned agent ID without duplicates',()=>{const s=store();s.ingest('thread-a',item('start','dsh_start',{name:'build',cwd:'/tmp'},null,'inProgress'));s.ingest('thread-a',item('start','dsh_start',{name:'build',cwd:'/tmp'},{agent_id:'agent-1',status:'running'}));assert.equal(s.values().length,1);assert.equal(s.values()[0].agentId,'agent-1');assert.equal(s.values()[0].status,'running');assert.equal(s.values()[0].name,'build');});
test('JSON text content and string arguments track lifecycle and final answer',()=>{const s=store();s.ingest('thread-a',{...item('x','dsh_status'),arguments:JSON.stringify({agent_id:'a'}),result:{content:[{type:'text',text:JSON.stringify({status:'running',progress:'read-file'})}]}});s.ingest('thread-a',item('w','dsh_wait',{agent_id:'a'},{agent_id:'a',status:'completed',answer:'done',finish_reason:{kind:'completed'}}));assert.equal(s.values().length,1);assert.equal(s.values()[0].status,'completed');assert.equal(s.values()[0].answer,'done');assert.match(s.values()[0].finish_reason,/completed/);});
test('accepted followup clears previous final result without fabricating success',()=>{const s=store();s.ingest('thread-a',item('w','dsh_wait',{agent_id:'a'},{status:'completed',answer:'previous'}));s.ingest('thread-a',item('f','dsh_followup',{agent_id:'a'},{status:'running'}));assert.equal(s.values()[0].status,'running');assert.equal(s.values()[0].answer,'');});
test('task state stays bound to selected conversation',()=>{const s=store();assert.equal(s.ingest('thread-b',item('a','dsh_start',{}, {agent_id:'a',status:'running'})),false);assert.equal(s.values().length,0);s.ingest('thread-a',item('a','dsh_start',{}, {agent_id:'a',status:'running'}));s.reset('thread-b');assert.equal(s.values().length,0);assert.equal(s.progress('thread-a','a','old'),false);});
test('older history cannot overwrite newer observed task state',()=>{const s=store();s.ingest('thread-a',item('final','dsh_wait',{agent_id:'a'},{status:'completed',answer:'done'}));s.ingest('thread-a',item('old','dsh_status',{agent_id:'a'},{status:'running'}),{older:true});assert.equal(s.values()[0].status,'completed');});
test('50 tasks and text bounds prevent unbounded result retention',()=>{const s=store();for(let i=0;i<100;i++)s.ingest('thread-a',item(String(i),'dsh_wait',{agent_id:String(i)},{status:'completed',answer:'x'.repeat(100000)}));assert.equal(s.values().length,50);assert.ok(s.values().every(t=>t.answer.length<16100));assert.ok(s.calls.size<=200);});
test('MCP progress only updates known task, never invents status or percentage',()=>{const s=store();assert.equal(s.progress('thread-a','unknown','hello'),false);s.ingest('thread-a',item('x','dsh_start'));s.progress('thread-a','x','Reading project');assert.equal(s.values()[0].mcpProgress,'Reading project');assert.equal(s.values()[0].status,undefined);});
test('MCP errors remain call errors, not DSH lifecycle state',()=>{const s=store();s.ingest('thread-a',{...item('x','dsh_status',{agent_id:'a'}),result:{isError:true,content:[{type:'text',text:'Bridge disconnected'}]}});assert.equal(s.values()[0].status,undefined);assert.equal(s.values()[0].callError,'Bridge disconnected');});
test('DSH event results display actual events without inferring current completion',()=>{const s=store();s.ingest('thread-a',item('e','dsh_events',{agent_id:'a'},{events:[{type:'assistant/final',text:'answer from previous turn'}]}));assert.match(s.values()[0].eventSummary,/previous turn/);assert.equal(s.values()[0].status,undefined);assert.equal(s.values()[0].answer,undefined);});
test('one listed MCP call with multiple task IDs does not attribute progress arbitrarily',()=>{const s=store();s.ingest('thread-a',item('list','dsh_list',{}, {items:[{agent_id:'a',status:'running'},{agent_id:'b',status:'completed'}]}));assert.equal(s.values().length,2);assert.equal(s.progress('thread-a','list','listing'),false);});

test('observed external restart cannot display a prior final as a current result',()=>{const s=store();s.ingest('thread-a',item('w','dsh_wait',{agent_id:'a'},{status:'completed',answer:'previous'}));s.ingest('thread-a',item('status','dsh_status',{agent_id:'a'},{status:'running'}));assert.equal(s.values()[0].status,'running');assert.equal(s.values()[0].answer,'');});

import {dshRuntimeStatusLabel} from '../public/dsh.js';
test('global null runtime is catalog discovery, not a disconnected session',()=>{const summary=dshConnectionSummary([{name:'dsh_subagent',runtimeStatus:null,tools:{dsh_start:{},dsh_status:{}}}],'全局 MCP 配置');assert.equal(summary.connected,false);assert.match(summary.label,/已发现 DSH 工具目录；尚未检查会话连接/);assert.equal(summary.servers[0].toolCount,2);});
test('loaded thread null runtime remains unknown and not connected',()=>{const summary=dshConnectionSummary([{name:'dsh_subagent',runtimeStatus:null,tools:{}}],'当前对话',{sessionScoped:true});assert.equal(summary.connected,false);assert.match(summary.label,/会话连接状态未知/);});
test('runtime states use exact enum mapping and never equate startup ready to connected',()=>{for(const [value,label]of Object.entries({notStarted:'尚未启动',starting:'正在启动',connected:'已连接',authenticationRequired:'需要身份验证',failed:'连接失败',cancelled:'连接已取消',disabled:'已禁用'})){assert.equal(dshRuntimeStatusLabel(value),label);const summary=dshConnectionSummary([{name:'dsh_subagent',runtimeStatus:value}],'当前对话',{sessionScoped:true});assert.equal(summary.connected,value==='connected');assert.ok(summary.label.includes(label));}assert.match(dshRuntimeStatusLabel('ready'),/未知状态/);assert.equal(dshConnectionSummary([{name:'dsh_subagent',runtimeStatus:'ready'}]).connected,false);});

test('live list projection keeps real status, updated_at and omission metadata without fabricating a completed call',()=>{
 const s=store();
 const projection=dshListSnapshot({structuredContent:{items:[{agent_id:'live',name:'Live agent',cwd:'C:/work',status:'running',updated_at:'2026-11-11T12:00:00.000Z',progress:'reading files'}],count:1,matched:1,total:3,omitted:2}});
 assert.equal(projection.available,true);
 assert.equal(s.ingestLiveList('thread-a',projection,{checkedAt:'2026-11-11T12:00:01.000Z'}),true);
 const task=s.values()[0];
 assert.equal(task.agentId,'live');assert.equal(task.status,'running');assert.equal(task.updated_at,'2026-11-11T12:00:00.000Z');
 assert.equal(task.tool,'dsh_list');assert.equal(task.callState,'snapshot');assert.equal(task.answer,undefined);
 assert.deepEqual(s.listMeta,{checkedAt:'2026-11-11T12:00:01.000Z',count:1,matched:1,total:3,omitted:2});
});
test('a completed list row never becomes a completed MCP call or a final answer',()=>{
 const s=store();const projection=dshListSnapshot({items:[{agent_id:'a',status:'completed',name:'A'}]});
 s.ingestLiveList('thread-a',projection,{checkedAt:'2026-11-11T12:00:00.000Z'});
 const task=s.values()[0];assert.equal(task.status,'completed');assert.equal(task.callState,'snapshot');assert.equal(task.answer,undefined);assert.equal(task.finish_reason,undefined);
});
test('running after a terminal state clears the old final display but keeps the event cursor',()=>{
 const s=store();s.ingest('thread-a',item('w','dsh_wait',{agent_id:'a'},{status:'completed',answer:'old final'}));
 s.ingestLiveEvents('thread-a','a',[{event_id:'e1',seq:1,type:'progress',text:'old event'}],{cursor:'3:4:5',hasMore:true});
 s.ingestLiveList('thread-a',dshListSnapshot({items:[{agent_id:'a',status:'running',updated_at:'2026-11-11T12:00:00.000Z'}]}),{checkedAt:'2026-11-11T12:00:01.000Z'});
 const task=s.values()[0];
 assert.equal(task.status,'running');assert.equal(task.answer,'');assert.equal(task.finish_reason,'');
 assert.equal(task.eventCursor,'3:4:5');assert.equal(task.liveEvents.length,1);assert.ok(task.finalClearedAt);
});
test('live events are evidence only, retain one hundred bounded rows, and never infer current completion',()=>{
 const s=store();const events=Array.from({length:120},(_,i)=>({event_id:`e${i}`,seq:i,type:i===119?'assistant/final':'progress',text:`event ${i}`,summary:{step:i}}));
 s.ingestLiveEvents('thread-a','a',events,{cursor:'9:8:7',hasMore:false});
 const task=s.values()[0];
 assert.equal(task.status,undefined);assert.equal(task.answer,undefined);assert.equal(task.liveEvents.length,100);
 assert.equal(task.liveEvents[0].event_id,'e20');assert.match(task.liveEvents.at(-1).summary,/"step":119/);
 assert.equal(task.eventCursor,'9:8:7');assert.match(task.eventSummary,/assistant\/final/);
});
test('status projection is compact and a running status clears an old final without resetting cursor',()=>{
 const s=store();s.ingest('thread-a',item('w','dsh_wait',{agent_id:'a'},{status:'completed',answer:'old'}));
 s.ingestLiveEvents('thread-a','a',[{event_id:'e',seq:1,type:'progress',text:'old'}],{cursor:42,hasMore:false});
 const status=dshStatusSnapshot({content:[{type:'text',text:JSON.stringify({status:'running',name:'Agent A',updated_at:'2026-11-11T12:00:00Z',progress:'working'})}]});
 assert.equal(status.available,true);assert.equal(status.status,'running');
 s.ingestLiveStatus('thread-a','a',status,{checkedAt:'2026-11-11T12:00:01Z'});
 const task=s.values()[0];assert.equal(task.status,'running');assert.equal(task.answer,'');assert.equal(task.eventCursor,42);assert.equal(task.progress,'working');
});
test('event cursors stay exact strings, repeated rows are deduped, and hidden reasoning is omitted',()=>{
 const one={event_id:'e1',seq:1,type:'progress',text:'one'};
 const projection=dshEventsSnapshot({content:[{type:'text',text:JSON.stringify({events:[one,one,{event_id:'e2',seq:2,type:'progress',text:'two'},{event_id:'r',seq:3,type:'reasoning',text:'secret'}],next_cursor:'10:20:30',has_more:true})}]});
 assert.equal(projection.available,true);assert.equal(projection.next_cursor,'10:20:30');assert.equal(projection.has_more,true);
 assert.deepEqual(projection.events.map(row=>row.event_id),['e1','e2']);
});
test('list and event envelopes with an MCP error are distinguishable from empty snapshots',()=>{
 const list=dshListSnapshot({isError:true,content:[{type:'text',text:'list failed'}]});
 assert.equal(list.available,false);assert.deepEqual(list.items,[]);
 const events=dshEventsSnapshot({isError:true,content:[{type:'text',text:'events failed'}]});
 assert.equal(events.available,false);assert.deepEqual(events.events,[]);
});
