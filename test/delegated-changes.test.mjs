import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeAgentChanges} from '../public/agent-changes.js';
import {projectDelegatedEdit,delegatedItemsForTurn,mergeDelegatedFileSummary} from '../public/delegated-changes.js';
import {fileSummary,buildTurns,TurnLedger,changeStats} from '../public/state.js';
import {DshTaskStore,dshEventsSnapshot} from '../public/dsh.js';
import {DshChangeReader} from '../src/dsh-changes.mjs';
import {pillChanges,mountLiveChanges} from '../public/ui/live-changes.js';
import {renderDiff} from '../public/activity-feed.js';
import {createDocument} from './mini-dom.mjs';

const patch='@@ -1 +1 @@\n-old\n+new\n';
const record=(id,path,diff=patch)=>({id,turnId:'parent',success:true,cwd:'C:/repo',changes:[{path,kind:{type:'update'},...(diff===undefined?{}:{diff})}]});
const summary=records=>fileSummary(delegatedItemsForTurn(records,'parent','C:/repo'),null,{cwd:'C:/repo'});

test('native child snapshots preserve successive patches, deduplicate item IDs and keep parent scope',()=>{
 const collector=new NativeAgentChanges('root');collector.observe([{id:'spawn',type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['child'],_turnId:'parent'}]);
 const edit=id=>({id,type:'fileChange',status:'completed',changes:[{path:'Program.cs',kind:{type:'update'},diff:patch}]});
 const child={id:'child',cwd:'C:/repo',turns:[{id:'child-turn',status:'completed',items:[edit('one'),edit('two'),edit('two')]}]};
 assert.equal(collector.ingest('other',child,{complete:true}),false);collector.ingest('root',child,{complete:true});collector.ingest('root',child,{complete:true});
 const records=collector.changes();assert.equal(records.length,2);const files=summary([...records,...records]);
 assert.equal(files.count,1);assert.equal(files.added,2);assert.equal(files.removed,2);assert.equal(files.rows[0].diffs.length,2);assert.equal(files.statsBasis,'edits');
});

test('DSH reader through browser normalization and task ownership retains multi-hunk and repeated file edits',async()=>{
 const reader=new DshChangeReader();const all=[{type:'tool/call',event_id:1,summary:{name:'Edit',callId:'one'}},{type:'tool/result',event_id:2},{type:'tool/call',event_id:3,summary:{name:'Edit',callId:'two'}},{type:'tool/result',event_id:4}];
 const fragments=[{path:'C:/repo/Program.cs',oldText:'keep\nold\nkeep2',newText:'keep\nnew\nkeep2'},{path:'C:/repo/Program.cs',oldText:'same\na\nmid\nb\ntail',newText:'same\nc\nmid\nd\ntail'}];
 const call=async(_tool,args)=>({structuredContent:args.event_id?{events:[{event_id:args.event_id,data:{turn:1,message:{isError:false,toolCallId:args.event_id===2?'one':'two'},meta:{operation:'update',diffs:args.event_id===2?fragments:[fragments[0]]}}}]}:{events:all.filter(event=>event.event_id>args.after),next_cursor:4,has_more:false}});
 const raw=await reader.read('root:child','child',call,{status:'completed',updatedAt:'one'});
 assert.equal(raw.structuredContent.events.length,2);assert.equal(raw.structuredContent.events[0].changes.length,2);
 const projection=dshEventsSnapshot(raw),store=new DshTaskStore();store.reset('root');
 store.ingest('root',{id:'spawn',_turnId:'parent',type:'mcpToolCall',server:'dsh_subagent',tool:'dsh_start',arguments:{cwd:'C:/repo'},status:'completed',result:{structuredContent:{agent_id:'child',status:'completed'}}});
 store.ingestChanges('root','child',projection.events,{hasMore:false});store.ingestChanges('root','child',projection.events,{hasMore:false});
 const records=store.delegatedChanges(),files=summary(records);assert.equal(files.count,1);assert.equal(files.added,4);assert.equal(files.removed,4);assert.equal(files.rows[0].diffs.length,3);assert.equal(files.complete,true);
 assert.match(files.rows[0].diffs[0],/无完整文件行号/);assert.doesNotMatch(files.rows[0].diffs[0],/@@ -\d/);
 const ledger=new TurnLedger();ledger.merge({id:'parent',status:'completed'});const turn=buildTurns([{id:'user',type:'userMessage',_turnId:'parent',content:[]}],ledger,{cwd:'C:/repo',delegatedChanges:records})[0];assert.equal(turn.files.added,4);
});

test('large native patches keep exact counts after preview truncation and repeated projections',()=>{
 const source='@@ -0,0 +1,2000 @@\n'+Array.from({length:2000},()=>`+${'a'.repeat(80)}\n`).join('');
 const first=projectDelegatedEdit({success:true,changes:[{path:'large.js',kind:{type:'update'},diff:source}]});
 assert.equal(first.changes[0].diffTruncated,true);assert.equal(first.changes[0].lineStats.added,2000);assert.ok(first.changes[0].diff.length<=65536);
 const second=projectDelegatedEdit(first);assert.deepEqual(second.changes[0].lineStats,{added:2000,removed:0});assert.equal(summary([{...second,id:'large',turnId:'parent'}]).added,2000);
});

test('a missing edit retains known contributions for the same file and overall totals',()=>{
 const missing={...record('missing','Program.cs'),changes:[{path:'Program.cs',kind:{type:'update'}}]};
 const files=summary([record('one','Program.cs'),missing,record('two','other.js')]);
 assert.equal(files.count,2);assert.equal(files.added,2);assert.equal(files.removed,2);assert.equal(files.unknownCount,1);assert.equal(files.rows[0].added,null);assert.equal(files.rows[0].knownAdded,1);assert.equal(files.complete,false);
 const unknown=summary([missing]);assert.equal(unknown.added,null);assert.equal(unknown.removed,null);assert.equal(unknown.binaryCount,0);
});

test('native net diffs override child edits while ordinary parent and child patches accumulate',()=>{
 const primary=fileSummary([{type:'fileChange',status:'completed',changes:[{path:'C:/repo/Program.cs',kind:{type:'update'},diff:patch}]}],null,{cwd:'C:/repo'}),delegated=summary([record('child','Program.cs')]);
 assert.equal(mergeDelegatedFileSummary(primary,delegated,{cwd:'C:/repo'}).added,2);
 const net=fileSummary([{type:'fileChange',status:'completed',changes:[{path:'C:/repo/Program.cs',kind:{type:'update'},diff:patch}]}],'',{cwd:'C:/repo'});
 const merged=mergeDelegatedFileSummary(net,delegated,{cwd:'C:/repo'});assert.equal(merged.count,1);assert.equal(merged.added,0);assert.equal(merged.rows[0].net,'unchanged');
});

test('binary, missing, and incomplete diffs stay distinct; incomplete hunks never count as complete',()=>{
 for(const diff of ['@@ -1,2 +1,2 @@\n-a\n+b\n','@@ -1 +1 @@\n-a\n+b\n+unexpected'])assert.deepEqual(changeStats({kind:{type:'update'},diff}),{added:null,removed:null});
 const files=summary([record('bin','image.png','Binary files a/image.png and b/image.png differ'),{...record('missing','empty.js'),changes:[{path:'empty.js'}]}]);
 assert.equal(files.binaryCount,1);assert.deepEqual(files.rows.map(row=>row.statsReasons),[['binary'],['missing']]);assert.equal(files.added,null);
 assert.deepEqual(changeStats({kind:{type:'add'},diff:''}),{added:0,removed:0});
});

test('live floating pill and its file panel retain known totals alongside honest unknown reasons',()=>{
 const files=summary([record('one','known.cs'),{...record('missing','Program.cs'),changes:[{path:'Program.cs'}]},record('binary','icon.png','Binary files a/icon.png and b/icon.png differ')]);
 const pill=pillChanges([{id:'parent',status:'running',files}]);assert.equal(pill.added,1);assert.equal(pill.unknownCount,2);assert.equal(pill.binaryCount,1);
 const document=createDocument(),host=document.createElement('div');const view=mountLiveChanges(host,{renderDiff});view.update(pill);
 assert.match(host.querySelector('.changes-pill').textContent,/已知 \+1-1.*2 个文件行数未知/);
 host.querySelector('.changes-pill').dispatch('click');assert.equal(view.isOpen(),true);
 const rows=host.querySelectorAll('.changes-file');assert.match(rows[0].textContent,/\+1-1/);assert.match(rows[1].textContent,/缺少差异数据，行数未知/);assert.match(rows[2].textContent,/二进制/);
 assert.match(host.querySelector('.diff-stats').title,/累计/);
});

test('preview budgets never remove later file paths or their counts',()=>{
 const changes=Array.from({length:150},(_,i)=>({path:`file-${i}.js`,kind:{type:'add'},diff:'a\n'.repeat(4000)}));
 const edit=projectDelegatedEdit({success:true,changes});assert.equal(edit.changes.length,150);
 const files=summary([{...edit,id:'many',turnId:'parent'}]);assert.equal(files.count,150);assert.equal(files.added,600000);assert.equal(files.complete,true);assert.ok(files.rows.at(-1).diffs[0].includes('预览已截断'));
});

test('DSH changes snapshots preserve more than 100 operations while the ordinary event feed stays bounded',()=>{
 const events=Array.from({length:150},(_,i)=>({event_id:`edit-${i}`,seq:i,type:'tool/result',success:true,taskTurn:1,changes:[{path:`file-${i}.js`,kind:{type:'update'},diff:patch}]}));
 const envelope={structuredContent:{events,next_cursor:150,has_more:false}};
 assert.equal(dshEventsSnapshot(envelope).events.length,100);
 const all=dshEventsSnapshot(envelope,{retainChanges:true});assert.equal(all.events.length,150);
 const records=all.events.map(event=>({...event,id:event.event_id,turnId:'parent'}));assert.equal(summary(records).count,150);assert.equal(summary(records).added,150);
});

test('a successful DSH result with a path but no applied diff is missing data, not zero lines',async()=>{
 const reader=new DshChangeReader();const response=await reader.read('root:child','child',async(_tool,args)=>({structuredContent:args.event_id?{events:[{event_id:2,data:{turn:1,message:{toolCallId:'write',isError:false},meta:{path:'C:/repo/new.js',diffs:[]}}}]}:{events:[{event_id:1,type:'tool/call',summary:{name:'Write',callId:'write'}},{event_id:2,type:'tool/result'}],next_cursor:2,has_more:false}}));
 const changes=response.structuredContent.events[0].changes;assert.equal(changes[0].statsReason,'missing');assert.equal(changes[0].lineStats,undefined);
});
