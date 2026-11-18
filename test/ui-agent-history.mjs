import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from '../src/server.mjs';

const {chromium}=createRequire(import.meta.url)('playwright');
const app=await createServer({demo:true});
await app.started;
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
 const page=await browser.newPage({viewport:{width:1280,height:820}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(app.url);
 await page.evaluate(async()=>{
  const [{createAgentInspector},{DshLiveMonitor}]=await Promise.all([import('/ui/agent-inspector.js'),import('/dsh-live.js')]);
  const el=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls||'';if(text)node.textContent=text;return node;};
  const container=el('aside','inspector-body');container.id='fixture-scroller';
  Object.assign(container.style,{position:'fixed',top:'24px',left:'24px',width:'620px',height:'500px',overflow:'auto',background:'white',zIndex:'5000'});
  const host=el('div','agent-inspector-content');container.append(host);document.body.append(container);
  const command=(id,text)=>({id,type:'commandExecution',status:'completed',command:text,aggregatedOutput:`output ${text}`});
  const turn=(id,items)=>({id,status:'completed',items});
  const two=[turn('two-old',[command('first-command','old task command'),{id:'two-first-message',type:'agentMessage',text:'Two-task previous output'}]),turn('two-new',[{id:'two-second-message',type:'agentMessage',text:'Two-task latest output'}])];
  const long=Array.from({length:4},(_,n)=>{
   const items=Array.from({length:n===0?125:12},(_,m)=>({id:`long-${n}-text-${m}`,type:'agentMessage',text:n===0?`Historical event ${m}`:`Recent ${n} event ${m}`}));
   return turn(`long-${n}`,items);
  });
  const state={connected:true,serverInstance:'fixture',thread:{id:'parent'},dshReadErrors:new Map(),store:{values:()=>[{
   id:'spawn',type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['two','long'],agentsStates:{two:{status:'completed'},long:{status:'completed'}}
  }]}};
  let retry=true,inspection;
  const calls=[];window.fixtureHistoryCalls=calls;
  const tasks={values:()=>[{threadId:'parent',agentId:'delegated',name:'DSH example',status:'completed'}]};
  const dsh=new DshLiveMonitor({historyPaging:true,onChange:()=>inspection?.render(),api:async(route,input)=>{
   if(input.kind==='status')return {result:{agent_id:'delegated',status:'completed'}};
   if(input.kind==='history'){
    const items=input.before?Array.from({length:70},(_,index)=>({event_id:index+1,seq:index+1,taskTurn:1,type:'assistant/message',text:'DSH older event '+index})):
      [{event_id:101,seq:101,taskTurn:2,type:'assistant/final',text:'DSH previous task output'},...Array.from({length:70},(_,index)=>({event_id:102+index,seq:102+index,taskTurn:3,type:'assistant/message',text:'DSH latest event '+index}))];
    return {threadId:'parent',agentId:'delegated',result:{direction:'backward',agent_id:'delegated',events:items,tail_cursor:171,before_cursor:input.before?null:101,has_older:!input.before}};
   }
   if(input.kind==='events')return {result:{events:[],next_cursor:171,has_more:false}};
   return {result:{items:[]}};
  }});
  inspection=createAgentInspector({document,state,host,dshTasks:tasks,dshLive:dsh,rpc:async(method,params)=>{
   calls.push({method,params});
   if(method==='thread/read')return {thread:{id:params.threadId,model:'gpt-fixture'}};
   if(method!=='thread/turns/list')throw new Error('Unexpected operation '+method);
   const source=params.threadId==='two'?two:long;
   if(params.cursor&&retry){retry=false;throw new Error('fixture retryable error');}
   const start=params.cursor?Number(params.cursor):0;
   return {data:[...source].reverse().slice(start,start+params.limit),nextCursor:start+params.limit<source.length?String(start+params.limit):null};
  },readDshTask:async()=>{},el});
  window.fixtureHistory=inspection;
  dsh.setContext({threadId:'parent',serverInstance:'fixture',connected:true,visible:true});
  inspection.render();
 });
 const panel=page.locator('#fixture-scroller');
 await panel.locator('[data-agent-id="two"]').click();
 await panel.getByText('Two-task latest output',{exact:true}).waitFor();
 assert.equal(await panel.locator('.agent-run').count(),2);
 await panel.locator('[data-turn-id="two-old"] summary').first().click();
 await panel.locator('[data-turn-id="two-old"] details[open]').waitFor();
 await panel.getByText('Two-task previous output',{exact:true}).waitFor();
 console.log('PASS: same native agent shows both tasks immediately, and the first task remains readable and expandable');
 await panel.getByRole('button',{name:'返回子代理列表'}).click();
 await panel.locator('[data-agent-id="long"]').click();
 await panel.getByText('Recent 3 event 11',{exact:true}).waitFor();
 await panel.evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new WheelEvent('wheel',{deltaY:-90,bubbles:true}));});
 await panel.getByText(/fixture retryable error/).waitFor();
 const anchor=await panel.evaluate(async node=>{
  const {captureHistoryAnchor}=await import('/ui/history-auto-load.js');
  node.scrollTop=0;
  const {itemId,offset}=captureHistoryAnchor(node);
  return {itemId,offset};
 });
 await panel.getByRole('button',{name:'重试加载更早的任务'}).click();
 await panel.getByText('Historical event 124',{exact:true}).waitFor();
 assert.equal(await panel.locator('[data-turn-id="long-0"] .agent-markdown').count(),125);
 const restored=await panel.locator(`[data-item-id="${anchor.itemId}"]`).evaluate(node=>node.getBoundingClientRect().top-node.closest('.inspector-body').getBoundingClientRect().top);
 assert.ok(Math.abs(restored-anchor.offset)<4,`scroll anchor ${anchor.offset} -> ${restored}`);
 console.log('PASS: upward history paging retries, preserves position and restores well over 100 native items');
 await panel.getByRole('button',{name:'返回子代理列表'}).click();
 await panel.locator('[data-agent-id="delegated"]').click();
 await panel.getByText('DSH previous task output',{exact:true}).waitFor();
 assert.equal(await panel.locator('.agent-run').count(),2);
 await panel.getByRole('button',{name:'加载更早的任务'}).click();
 await panel.getByText('DSH older event 0',{exact:true}).waitFor();
 assert.ok(await panel.locator('.agent-run .agent-markdown').count()>100);
 assert.deepEqual(await panel.locator('.agent-run .agent-run-heading strong').allTextContents(),['任务 1','任务 2','任务 3']);
 assert.ok((await page.evaluate(()=>window.fixtureHistoryCalls)).every(call=>['thread/read','thread/turns/list'].includes(call.method)));
 assert.deepEqual(errors,[]);
 console.log('PASS: DSH old task pages retain more than 100 events in chronological task groups');
}finally{await browser?.close();await app.close();}
