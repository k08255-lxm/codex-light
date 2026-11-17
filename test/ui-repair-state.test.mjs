import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument,visibleText} from './mini-dom.mjs';
import {mountLiveChanges,pillChanges} from '../public/ui/live-changes.js';
import {createAgentInspector} from '../public/ui/agent-inspector.js';
import {DshTaskStore,dshLifecycleEvent} from '../public/dsh.js';
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
test('change pill preserves expanded diff nodes and scroll through progress and dismisses outside',()=>{
 const document=createDocument(),host=document.createElement('div');document.body.append(host);
 const view=mountLiveChanges(host,{renderDiff:(_,text)=>{const node=document.createElement('pre');node.textContent=text;return node;}});
 const summary={turnId:'turn',count:1,rows:[{path:'a',fullPath:'a',diffs:['+a'],added:1,removed:0}],added:1,removed:0};
 view.update(summary,'a');host.querySelector('.changes-pill').click();host.querySelector('.changes-file').click();
 const diff=host.querySelector('pre');diff.scrollTop=120;diff.scrollLeft=60;const panel=host.querySelector('.changes-panel');panel.scrollTop=90;
 view.update({...summary,running:true},'a');assert.equal(host.querySelector('pre'),diff);assert.equal(diff.scrollTop,120);assert.equal(panel.scrollTop,90);
 view.update({...summary,rows:[{...summary.rows[0],diffs:['+a\n+b'],added:2}]},'a');
 assert.equal(host.querySelector('pre').scrollTop,120);assert.equal(host.querySelector('pre').scrollLeft,60);
 for(const listener of document.listeners.click)listener({target:host.querySelector('pre')});assert.equal(view.isOpen(),true);
 for(const listener of document.listeners.click)listener({target:document.body});assert.equal(view.isOpen(),false);
 // Bubbling click targets can be replaced during drawing; composedPath still identifies an inside click.
 host.querySelector('.changes-pill').click();
 for(const listener of document.listeners.click)listener({target:document.createElement('span'),composedPath:()=>[host]});assert.equal(view.isOpen(),true);
});
test('change pill resets expanded files when switching conversation, including identical turn ids',()=>{
 const document=createDocument(),host=document.createElement('div');document.body.append(host);
 const view=mountLiveChanges(host,{renderDiff:()=>document.createElement('pre')});
 const summary={turnId:'turn',count:1,rows:[{path:'a',fullPath:'a',diffs:['+a'],added:1,removed:0}],added:1,removed:0};
 view.update(summary,'a');host.querySelector('button').click();assert.equal(view.isOpen(),true);
 view.update(summary,'b');assert.equal(view.isOpen(),false);view.update(pillChanges([]),null);assert.equal(host.classList.contains('hidden'),true);
});
test('same native agent has separate numbered task sections, statuses and outputs',async()=>{
 const document=createDocument(),host=document.createElement('div');document.body.append(host);
 const state={connected:true,thread:{id:'parent'},dshReadErrors:new Map(),store:{values:()=>[{id:'spawn',type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['child'],agentsStates:{child:{status:'completed'}}}]}};
 const turns=[1,2].map(n=>({id:'task-'+n,status:'completed',startedAt:1763370000+n,items:[{id:'input-'+n,type:'userMessage',content:[{type:'text',text:'输入 '+n}]},{id:'output-'+n,type:'agentMessage',text:'输出 '+n}]}));
 const inspector=createAgentInspector({document,state,host,dshTasks:{values:()=>[]},dshLive:{snapshot:()=>({}),selectAgent(){}},el:(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls||'';e.textContent=text||'';return e;},rpc:async()=>({thread:{id:'child',turns}})});
 inspector.render();inspector.open('child','native');await settle();
 const groups=host.querySelectorAll('.agent-run');assert.equal(groups.length,2);
 assert.match(visibleText(groups[0]),/任务 1.*输入 1.*输出 1/);assert.doesNotMatch(visibleText(groups[0]),/输出 2/);
 assert.match(visibleText(groups[1]),/任务 2.*输入 2.*输出 2/);
});
test('DSH assistant events preserve the explicit task turn used to group followups',()=>{
 const store=new DshTaskStore();store.reset('parent');
 store.ingestLiveEvents('parent','child',[{event_id:1,type:'assistant/final',data:{turn:1,message:{content:[{type:'text',text:'first'}]}}},{event_id:2,type:'assistant/final',data:{turn:2,message:{content:[{type:'text',text:'second'}]}}}]);
 assert.deepEqual(store.values()[0].liveEvents.map(event=>event.taskTurn),[1,2]);
});

test('agent lifecycle projection requires typed accepted status and matching task identity',()=>{
 const item={type:'mcpToolCall',server:'dsh-subagent',tool:'dsh_start',status:'completed',arguments:{name:'review'},result:{content:[{type:'text',text:JSON.stringify({agent_id:'child',status:'running'})}]}};
 assert.deepEqual(dshLifecycleEvent(item),{id:'child',name:'review',kind:'started',label:'已启动'});
 assert.equal(dshLifecycleEvent({...item,result:{agent_id:'child',answer:'completed'}}),null);
 assert.equal(dshLifecycleEvent({...item,arguments:{agent_id:'different'}}),null);
 assert.equal(dshLifecycleEvent({...item,result:{agent_id:'child',status:'running',accepted:false}}),null);
 assert.equal(dshLifecycleEvent({...item,tool:'dsh_wait',result:{agent_id:'child',status:'completed'}}).kind,'completed');
});
