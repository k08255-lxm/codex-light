import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopSleep} from '../src/desktop-sleep.mjs';

const tool=(name,id,status)=>({
 type:'mcpToolCall',id:'call-'+id,server:'dsh_subagent',tool:name,status:'completed',
 arguments:{},result:{structuredContent:{agent_id:id,status}},
});

test('a detached owned DSH task is checked independently until it finishes, without accepting another thread',async t=>{
 let activeTurnId='turn',childStatus='running';
 const reads=[],actions=[],sessions={entries:new Map([['parent',{}]]),snapshot:()=>({threads:[{activeTurnId}]})};
 const controller=new DesktopSleep({apply:value=>actions.push(value),streams:new Map(),sessions,readDsh:async(thread,id)=>{
  reads.push([thread,id]);return {result:{structuredContent:{agent_id:id,status:childStatus}}};
 }});
 t.after(()=>controller.close());
 controller.configure({keepAwakeDuringTask:true});
 controller.observeChild('unknown',tool('dsh_start','external','running'));
 controller.observeChild('parent',tool('dsh_start','child','running'));
 controller.observeChild('unknown',tool('dsh_wait','child','completed'));
 assert.deepEqual(actions,[true]);assert.deepEqual(reads,[]);
 activeTurnId=null;controller.update();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(reads,[['parent','child']]);assert.deepEqual(actions,[true]);
 childStatus='completed';await controller.poll();
 assert.deepEqual(actions,[true,false]);assert.equal(controller.timer,null);
});

test('late status replies cannot revive a cleared DSH task or leak a request on shutdown',async()=>{
 let complete;const actions=[];
 const controller=new DesktopSleep({apply:v=>actions.push(v),streams:new Map(),sessions:{entries:new Map([['parent',{}]]),snapshot:()=>({threads:[]})},readDsh:()=>new Promise(resolve=>{complete=resolve;})});
 controller.configure({keepAwakeDuringTask:true});
 controller.observeChild('parent',tool('dsh_start','child','running'));
 await new Promise(resolve=>setImmediate(resolve));
 controller.clearChildren();controller.close();
 complete({result:{structuredContent:{agent_id:'child',status:'running'}}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(actions,[true,false]);assert.equal(controller.timer,null);
});
