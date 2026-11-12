import test from 'node:test';import assert from 'node:assert/strict';import {DemoClient} from '../src/demo.mjs';
test('interrupting one demo thread does not cancel another and resumes show status',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const c=new DemoClient();t.after(()=>c.close());const a=(await c.call('thread/start',{cwd:process.cwd()})).thread;const b=(await c.call('thread/start',{cwd:process.cwd()})).thread;
 const ta=(await c.call('turn/start',{threadId:a.id,input:[{type:'text',text:'one'}]})).turn;const tb=(await c.call('turn/start',{threadId:b.id,input:[{type:'text',text:'two'}]})).turn;
 await c.call('turn/interrupt',{threadId:a.id,turnId:ta.id});t.mock.timers.tick(650);assert.equal(ta.status,'interrupted');assert.equal(tb.status,'completed');assert.equal((await c.call('thread/turns/list',{threadId:b.id,limit:1})).data[0].status,'completed');
});
test('demo supports bounded pages and search rather than dropping older rows',async()=>{
 const c=new DemoClient();for(let i=0;i<35;i++)await c.call('thread/start',{cwd:process.cwd()});const first=await c.call('thread/list',{limit:30});assert.equal(first.data.length,30);assert.equal(first.nextCursor,'30');const second=await c.call('thread/list',{limit:30,cursor:first.nextCursor});assert.equal(second.data.length,5);assert.equal(second.nextCursor,null);assert.equal((await c.call('thread/list',{searchTerm:'not-a-title'})).data.length,0);c.close();
});
test('demo metadata rename archive restore and fork preserve usable history',async t=>{
 const client=new DemoClient();t.after(()=>client.close());const {thread}=await client.call('thread/start',{cwd:process.cwd()});
 await client.call('thread/name/set',{threadId:thread.id,name:'Renamed'});assert.equal((await client.call('thread/list',{})).data[0].name,'Renamed');
 await client.call('thread/archive',{threadId:thread.id});assert.equal((await client.call('thread/list',{})).data.length,0);assert.equal((await client.call('thread/list',{archived:true})).data.length,1);
 await client.call('thread/unarchive',{threadId:thread.id});const fork=await client.call('thread/fork',{threadId:thread.id});assert.notEqual(fork.thread.id,thread.id);
 const result=await client.call('turn/start',{threadId:fork.thread.id,input:[{type:'text',text:'fork test'}]});assert.equal(result.turn.status,'inProgress');
});
test('demo catalog keeps legacy model and supplies explicit five/six-stop fixtures only',async t=>{
 const client=new DemoClient();t.after(()=>client.close());const {data}=await client.call('model/list',{});
 assert.equal(data[0].model,'demo');assert.deepEqual(data.map(m=>m.supportedReasoningEfforts.length),[1,5,6]);assert.ok(data.every(m=>m.displayName.includes('演示')&&m.displayName.includes('不调用 AI')));
 assert.equal(data[1].defaultReasoningEffort,'medium');assert.equal(data[2].defaultReasoningEffort,'high');
});
test('demo records actual model/effort omission and resumes custom/null inheritance without model calls',async t=>{
 const client=new DemoClient();t.after(()=>client.close());const started=await client.call('thread/start',{cwd:process.cwd(),model:'demo-six'});assert.equal(started.model,'demo-six');assert.equal(started.reasoningEffort,null);
 const run=async params=>{const {turn}=await client.call('turn/start',{threadId:started.thread.id,input:[{type:'text',text:'local fixture'}],...params});await client.call('turn/interrupt',{threadId:started.thread.id,turnId:turn.id});};
 await run({});assert.equal(client.modelTurns.at(-1).effortWasProvided,false);assert.equal((await client.call('thread/resume',{threadId:started.thread.id})).reasoningEffort,null);
 await run({effort:'custom-future'});await run({});const restored=await client.call('thread/resume',{threadId:started.thread.id});assert.equal(restored.reasoningEffort,'custom-future');assert.equal(client.modelTurns.at(-1).effortWasProvided,false);
 await run({model:'demo-five',effort:'medium'});assert.equal(client.modelTurns.at(-1).model,'demo-five');assert.equal(client.modelTurns.at(-1).effort,'medium');assert.equal(client.modelTurns.at(-1).effortWasProvided,true);
});
