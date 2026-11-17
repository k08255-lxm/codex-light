// Real Chromium interaction checks against an isolated demo server. No model calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
const root=process.cwd(),output=path.join(root,'.tmp','ui-repair');await mkdir(output,{recursive:true});
const temporary=await mkdtemp(path.join(output,'session-'));
const client=new DemoClient(),original=client.call.bind(client);let lists=0;
client.call=async(method,params)=>{if(method==='thread/list'){lists++;if(params.searchTerm)await new Promise(resolve=>setTimeout(resolve,350));}return original(method,params);};
const app=await createServer({client,demo:true,cwd:root,projectsRoot:path.join(temporary,'projects'),desktopStateRoot:path.join(temporary,'desktop'),fileAttachmentRoot:path.join(temporary,'attachments')});await app.started;
let browser;const errors=[],checks=[];
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(6000);
 page.on('pageerror',error=>errors.push(error.message));let configReads=0;
 await page.route('**/api/config-settings/read',async route=>{configReads++;await route.fulfill({json:{fields:Object.fromEntries(['model','model_reasoning_effort','web_search','approval_policy','sandbox_mode'].map(key=>[key,{value:'test',label:'test',readonly:true,source:'测试数据'}]))}});});
 await page.goto(app.url);await page.locator('#connection-text').filter({hasText:'演示模式'}).waitFor();
 await page.locator('#rail-usage').click();assert.equal(await page.locator('#rail-sidebar').getAttribute('aria-expanded'),'false');
 await page.locator('#navigate-back').click();assert.equal(await page.locator('#app').getAttribute('data-view'),'chat');assert.equal(await page.locator('#rail-sidebar').getAttribute('aria-expanded'),'true');
 await page.locator('#navigate-forward').click();assert.equal(await page.locator('#app').getAttribute('data-view'),'usage');
 await page.locator('#rail-home').click();await page.locator('#rail-sidebar').click();
 await page.locator('#rail-account').click();await page.locator('#rail-home').click();assert.equal(await page.locator('#rail-sidebar').getAttribute('aria-expanded'),'false');
 checks.push('back/forward and independent chat sidebar state');
 await page.locator('#rail-settings').click();await page.locator('[data-settings-section="configuration"]').click();
 await page.locator('.config-settings-status').filter({hasText:'已读取当前配置'}).waitFor();assert.equal(configReads,1);
 await page.locator('[data-settings-section="appearance"]').click();await page.locator('[data-settings-section="configuration"]').click();
 await page.waitForFunction(()=>document.querySelector('.config-settings-status').textContent.includes('已读取当前配置'));assert.equal(configReads,2);
 checks.push('configuration reads automatically on each entry');
 await page.locator('#rail-home').click();await page.locator('#rail-sidebar').click();
 await page.locator('#search').fill('search-one');
 assert.match(await page.locator('.project-navigation-status').textContent(),/正在搜索/);
 await page.locator('#search').fill('search-two');await page.locator('.project-navigation-status').filter({hasText:'找到'}).waitFor();
 assert.equal(await page.locator('.project-navigation-status').getAttribute('data-busy'),'false');assert.ok(lists>=2);
 await page.locator('#search').fill('');await page.waitForFunction(()=>document.querySelector('.project-navigation-status').dataset.busy==='false');
 checks.push('immediate search feedback and settled result');
 await page.locator('#model-trigger').click();await page.locator('#model-list-open').click();await page.locator('.model-option').filter({hasText:'演示五档模型'}).click();await page.keyboard.press('Escape');
 await page.reload();await page.waitForFunction(()=>document.querySelector('#model').value==='demo-five');assert.doesNotMatch(await page.locator('#model-trigger').textContent(),/未知|继承配置/);
 checks.push('explicit model choice survives restart without unknown labels');
 await page.evaluate(async()=>{
  const {mountConversation}=await import('/activity-feed.js'),{buildTurns,TurnLedger}=await import('/state.js');
  const ledger=new TurnLedger();ledger.merge({id:'one',status:'inProgress'});ledger.merge({id:'two',status:'inProgress'});
  const diff='@@ -1,40 +1,40 @@\n'+Array.from({length:40},(_,i)=>'-old '+i+'\n+new '+i).join('\n');
  const items=[{id:'u1',type:'userMessage',_turnId:'one',content:[{type:'text',text:'多文件可读性和折叠检查'}]},{id:'edit1',type:'fileChange',_turnId:'one',status:'completed',changes:[{path:'src/alpha.js',kind:{type:'update'},diff},{path:'src/beta.js',kind:{type:'update'},diff}]},{id:'u2',type:'userMessage',_turnId:'two',content:[{type:'text',text:'另一个操作组'}]},{id:'edit2',type:'fileChange',_turnId:'two',status:'completed',changes:[{path:'src/gamma.js',kind:{type:'update'},diff}]}];
  document.querySelector('#welcome').classList.add('hidden');const view=mountConversation(document.querySelector('#messages'),{getThreadId:()=> 'fixture'});
  const render=()=>view.render(buildTurns(items,ledger,{activeTurnId:'two'}));window.repair={render,view,ledger,items,buildTurns};render();
 });
 const groups=page.locator('.turn-process');
 for(let index=0;index<2;index++){
  const group=groups.nth(index);await group.locator(':scope > summary').click();await group.locator('.step > summary').click();
   await group.locator('.diff-file').first().waitFor();assert.equal(await group.locator('.diff-file').count(),index?1:2);
  await group.locator('.step > summary').click();
  // Deliberately render before queued native toggle events run, as scroll clamping does.
  await group.locator(':scope > summary').evaluate(node=>{node.click();window.repair.render();});
  assert.equal(await group.getAttribute('open'),null);await page.evaluate(()=>window.repair.render());assert.equal(await group.getAttribute('open'),null);
 }
 checks.push('nested file disclosure collapse survives rerender and other groups');
 await page.evaluate(()=>{const r=window.repair;r.items.push({id:'agent-start',type:'subAgentActivity',agentThreadId:'child',agentPath:'/root/check',kind:'started',_turnId:'two'});r.ledger.merge({id:'two',status:'completed'});r.render();});
 assert.equal(await page.locator('.turn > .agent-lifecycle-event .agent-avatar').count(),1);
 checks.push('subagent lifecycle with avatar stays outside completed work');
 await groups.first().locator(':scope > summary').click();await groups.first().locator('.step > summary').click();
 await page.screenshot({path:path.join(output,'files-dark.png')});
 await page.evaluate(()=>document.documentElement.dataset.theme='light');await page.screenshot({path:path.join(output,'files-light.png')});
 await page.setViewportSize({width:700,height:740});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'files-narrow.png')});
 await page.setViewportSize({width:1280,height:900});
 await page.evaluate(async()=>{
  const {createAsyncInputCard}=await import('/ui/async-input.js');
  const host=document.querySelector('#messages');window.repair.view.clear();host.replaceChildren();
  const card=createAsyncInputCard(document,{id:'question',type:'agentMessage',delivery:'async',questions:[{title:'如何处理已经完成的修改？',options:['保留并继续检查','暂时保留']},{title:'还有哪些要求？'}]},{threadId:'fixture',onAnswerAsync:async payload=>{window.repair.answer=payload;return {status:'sent'};}});
  host.append(card.node);
 });
 await page.locator('.approval-choice').filter({hasText:'保留并继续检查'}).click();await page.locator('.approval-question textarea').last().fill('继续完成界面和交互检查。');
 assert.match(await page.locator('.answer-progress').textContent(),/2 \/ 2/);await page.screenshot({path:path.join(output,'answer-ready.png')});
 await page.locator('.answer-submit').click();await page.locator('.async-input-card[data-outcome="sent"]').waitFor();
 assert.equal(await page.locator('.async-input-card h3').textContent(),'已回答');assert.equal(await page.locator('.approval-choice:visible').count(),0);assert.equal(await page.locator('.answer-value:visible').count(),2);
 assert.equal(await page.evaluate(()=>window.repair.answer.answers[0].answer),'保留并继续检查');await page.screenshot({path:path.join(output,'answer-sent.png')});
 checks.push('answer progress, explicit submission and compact sent summary');
 await page.evaluate(async()=>{
  const {createAgentInspector}=await import('/ui/agent-inspector.js');
  const host=document.querySelector('#messages');host.replaceChildren();
  const state={connected:true,thread:{id:'parent'},dshReadErrors:new Map(),store:{values:()=>[{id:'spawn',type:'collabAgentToolCall',tool:'spawnAgent',model:'gpt-6',reasoningEffort:'high',receiverThreadIds:['child'],agentsStates:{child:{status:'completed'}}}]}};
  const turns=[1,2].map(n=>({id:'task-'+n,status:'completed',startedAt:1763370000+n,items:[{id:'input-'+n,type:'userMessage',content:[{type:'text',text:'第 '+n+' 次任务输入'}]},{id:'output-'+n,type:'agentMessage',text:'第 '+n+' 次任务输出'}]}));
  const inspector=createAgentInspector({document,state,host,dshTasks:{values:()=>[]},dshLive:{snapshot:()=>({}),selectAgent(){}},el:(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls||'';e.textContent=text||'';return e;},rpc:async()=>({thread:{id:'child',turns}})});
  inspector.render();inspector.open('child','native');
 });
 await page.locator('.agent-run').nth(1).waitFor();assert.match(await page.locator('.agent-run').first().textContent(),/第 1 次任务输出/);assert.doesNotMatch(await page.locator('.agent-run').first().textContent(),/第 2 次/);assert.match(await page.locator('.agent-model-meta').textContent(),/high/);
 assert.ok(await page.locator('.agent-avatar').evaluate(node=>getComputedStyle(node).color!==getComputedStyle(node.parentElement).color&&getComputedStyle(node).getPropertyValue('--agent-glow')),'avatar colors survive the real server CSP');await page.screenshot({path:path.join(output,'agent-tasks.png')});
 checks.push('separate agent tasks with raw reasoning effort');
 for(const width of [1280,393]){
  await page.setViewportSize({width,height:900});
  await page.evaluate(async()=>{
   const {mountLiveChanges}=await import('/ui/live-changes.js'),{renderDiff}=await import('/activity-feed.js');
   const host=document.createElement('div');host.id='diff-check';host.className='live-changes';Object.assign(host.style,{position:'fixed',bottom:'20px',left:'20px',transform:'none',zIndex:'9999'});document.body.append(host);
   const diff=Array.from({length:160},(_,i)=>'+'+i+' '+('long line '.repeat(30))).join('\n');
   const summary={turnId:'check',count:1,rows:[{path:'src/test.js',fullPath:'src/test.js',diffs:[diff],added:160,removed:0,known:true}],added:160,removed:0,complete:true};
   window.diffCheck={host,summary,view:mountLiveChanges(host,{renderDiff})};window.diffCheck.view.update(summary,'fixture');
  });
  await page.locator('#diff-check .pill-text').click();await page.locator('#diff-check .file-base').click();
  await page.locator('#diff-check .diff-view').evaluate(node=>{node.style.maxHeight='180px';node.scrollTop=420;node.scrollLeft=110;window.checkedDiff=node;});
  const before=await page.locator('#diff-check .diff-view').evaluate(node=>[node.scrollTop,node.scrollLeft]);
  await page.evaluate(()=>{for(let i=0;i<15;i++)window.diffCheck.view.update({...window.diffCheck.summary,running:true},'fixture');});
  assert.equal(await page.locator('#diff-check .diff-view').evaluate(node=>node===window.checkedDiff),true);
  assert.deepEqual(await page.locator('#diff-check .diff-view').evaluate(node=>[node.scrollTop,node.scrollLeft]),before);
  await page.evaluate(()=>{const d=window.diffCheck;d.view.update({...d.summary,rows:[{...d.summary.rows[0],diffs:[d.summary.rows[0].diffs[0]+'\n+later update']}]},'fixture');});
  assert.deepEqual(await page.locator('#diff-check .diff-view').evaluate(node=>[node.scrollTop,node.scrollLeft]),before);
  await page.locator('#diff-check .diff-view').click({position:{x:10,y:30}});assert.equal(await page.locator('#diff-check .changes-pill').getAttribute('aria-expanded'),'true');
  await page.locator('#rail-home').click();assert.equal(await page.locator('#diff-check .changes-pill').getAttribute('aria-expanded'),'false');
  await page.evaluate(()=>window.diffCheck.host.remove());
 }
 checks.push('desktop and mobile diff inspection survives progress/content updates; inside stays open and outside dismisses');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,pageErrors:errors},null,2));
}finally{await browser?.close();await app.close();await rm(temporary,{recursive:true,force:true});}
