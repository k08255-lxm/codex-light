// Android WebView layout contract in real Chromium; all account/task data are isolated fixtures.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
const root=process.cwd(),out=path.join(root,'.tmp','mobile-repair');await mkdir(out,{recursive:true});
const temporary=await mkdtemp(path.join(out,'session-'));
const client=new DemoClient(),original=client.call.bind(client);
client.call=(method,params)=>method==='account/rateLimits/read'?Promise.resolve({rateLimits:{limitId:'codex',primary:{usedPercent:24,windowDurationMins:300},secondary:{usedPercent:61,windowDurationMins:10080}}}):original(method,params);
const app=await createServer({client,demo:true,cwd:root,projectsRoot:path.join(temporary,'projects'),desktopStateRoot:path.join(temporary,'desktop'),fileAttachmentRoot:path.join(temporary,'attachments')});await app.started;
let browser;const errors=[],checks=[];
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:393,height:850},isMobile:true,hasTouch:true});page.setDefaultTimeout(7000);
 const updateStatus={supported:true,demo:false,currentVersion:'0.4.9',phase:'available',latest:{available:true,version:'0.5.0',notes:'Synthetic layout fixture'}};
 await page.route(/\/api\/app-update\/(status|check)$/,route=>route.fulfill({json:updateStatus}));
 await page.addInitScript(()=>{window.nativeCalls=[];window.taskCalls=[];let enabled=false;window.CodexLightNative={isNativeApp:()=>true,setToolbarIntegrated:flag=>window.nativeCalls.push(['toolbar',flag]),openServerManager:()=>window.nativeCalls.push(['connection']),getTaskNotificationStatus:()=>JSON.stringify({supported:true,enabled,permissionGranted:true,promotedCandidate:true,reason:enabled?'ready':'disabled'}),setTaskNotificationsEnabled:value=>{enabled=value;window.nativeCalls.push(['notifications',value]);window.dispatchEvent(new Event('codexlight-task-notification-status'));},updateTaskNotification:data=>window.taskCalls.push(JSON.parse(data)),openTaskNotificationSettings:()=>window.nativeCalls.push(['notification-settings'])};});
 page.on('pageerror',error=>errors.push(error.message));await page.goto(app.url);
 await page.locator('#connection-text').filter({hasText:'演示模式'}).waitFor({state:'attached'});await page.locator('#mobile-quota-slot .account-quota-row').nth(1).waitFor();
 assert.deepEqual(await page.locator('.account-quota-value').allTextContents(),['76%','39%']);assert.equal(await page.locator('#menu-app').isVisible(),false);
 await page.locator('#app-update-indicator').waitFor();
 await page.evaluate(()=>{window.originalUpdateButton=document.querySelector('#app-update-indicator');});
 assert.equal(await page.locator('.app-titlebar > #app-update-indicator').count(),1);
 assert.equal(await page.locator('.rail .update-indicator').count(),0);
 assert.equal(await page.locator('.rail .rail-btn:visible').count(),5);
 await page.locator('#app-update-indicator').click();
 assert.equal(await page.locator('#settings-about').isVisible(),true);
 await page.locator('.about-update-controls button').filter({hasText:'下载更新'}).waitFor();
 await page.locator('#rail-home').click();
 checks.push('the same actionable update button sits between title and quotas, opens About, and leaves five mobile navigation entries');
 await page.locator('#mobile-connection').click();assert.deepEqual(await page.evaluate(()=>window.nativeCalls),[['toolbar',true],['connection']]);
 await page.locator('#mobile-quota-slot button').click();assert.equal(await page.locator('#app').getAttribute('data-view'),'account');await page.locator('#rail-home').click();
 checks.push('one shared quota view, working account link, integrated toolbar and no mobile menu');
 await page.evaluate(()=>{
  document.documentElement.dataset.reducedMotion='false';
  document.querySelector('#context-meter').classList.remove('hidden');document.querySelector('#context-label').textContent='62%';
  document.querySelector('#permissions-info .label').textContent='完全访问';
  document.querySelector('#queue-send').classList.remove('hidden');document.querySelector('#stop').classList.remove('hidden');
  document.querySelector('#model-trigger .model-trigger-label').textContent='GPT-6 Astra · 极高';
  document.querySelector('#cwd-label').textContent='项目名称很长的 codex-light';
 });
 for(const width of [320,360,393,432,760]){
  await page.setViewportSize({width,height:850});
  const geometry=await page.evaluate(()=>{
   const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
   const foot=document.querySelector('.composer-foot').getBoundingClientRect(),model=document.querySelector('#model-trigger').getBoundingClientRect(),chevron=document.querySelector('#model-trigger > .ui-icon').getBoundingClientRect();
   return {overflow:document.documentElement.scrollWidth>innerWidth,footer:['cwd-button','permissions-info','context-meter'].map(rect),toolbar:['add-attachment','add-file','model-trigger','queue-send','stop','send'].map(rect),titlebar:['app-update-indicator','mobile-quota-slot','mobile-refresh','mobile-connection'].map(rect),projectOffset:rect('cwd-button').x-foot.x,modelEndGap:model.right-chevron.right};
  });
  assert.equal(geometry.overflow,false,`overflow at ${width}`);
  assert.ok(geometry.projectOffset<1,`project entry aligns left at ${width}`);
  assert.ok(geometry.modelEndGap<7,`model content aligns with send controls at ${width}`);
  for(const id of ['cwd-button','model-trigger','app-update-indicator']){const r=[...geometry.footer,...geometry.toolbar,...geometry.titlebar].find(r=>r.id===id);assert.ok(r.width>=44&&r.height>=44,`${id} retains a 44px target at ${width}`);}
  for(const row of [geometry.footer,geometry.toolbar,geometry.titlebar])for(let i=0;i<row.length;i++){
   assert.ok(row[i].x>=0&&row[i].right<=width,`${row[i].id} stays inside at ${width}`);
   for(let j=i+1;j<row.length;j++)assert.ok(row[i].right<=row[j].x+.1||row[j].right<=row[i].x+.1||row[i].bottom<=row[j].y+.1||row[j].bottom<=row[i].y+.1,`${row[i].id} overlaps ${row[j].id} at ${width}`);
  }
 }
 assert.equal(await page.locator('#permissions-info .label').isVisible(),true);
 await page.setViewportSize({width:393,height:850});await page.screenshot({path:path.join(out,'composer-dark.png')});
 await page.evaluate(()=>document.documentElement.dataset.theme='light');await page.screenshot({path:path.join(out,'composer-light.png')});
 checks.push('320–760 px composer: approval, context, long model, queue, stop and send do not overlap');
 // Short labels expose alignment gaps that a full-width truncated label can conceal.
 await page.evaluate(()=>{document.querySelector('#cwd-label').textContent='repo';document.querySelector('#model-trigger .model-trigger-label').textContent='Model';});
 for(const width of [320,393,760]){
  await page.setViewportSize({width,height:850});
  const gaps=await page.evaluate(()=>{const foot=document.querySelector('.composer-foot').getBoundingClientRect(),project=document.querySelector('#cwd-button').getBoundingClientRect(),icon=document.querySelector('#cwd-button > .ui-icon').getBoundingClientRect(),model=document.querySelector('#model-trigger').getBoundingClientRect(),end=document.querySelector('#model-trigger > .ui-icon').getBoundingClientRect();return {projectStart:project.left-foot.left,projectIcon:icon.left-project.left,modelEnd:model.right-end.right};});
  assert.ok(gaps.projectStart<1&&gaps.projectIcon<7&&gaps.modelEnd<7,`short project/model alignment at ${width}: ${JSON.stringify(gaps)}`);
 }
 await page.setViewportSize({width:393,height:850});
 checks.push('short project names remain left-aligned and short model names remain next to send controls');
 await page.evaluate(()=>{window.pageEntries=[];document.addEventListener('animationstart',event=>{if(event.animationName==='page-enter')window.pageEntries.push(event.target.id);});});
 for(const [rail,target]of [['usage','usage-page'],['terminal','terminal-page'],['account','account-page'],['home','chat-page'],['settings','settings-dialog']]){
  await page.locator('#rail-'+rail).click();await page.waitForFunction(id=>window.pageEntries.includes(id),target);
 }
 for(const section of ['appearance','notifications','shortcuts']){
  if(await page.locator('#rail-sidebar').getAttribute('aria-expanded')!=='true')await page.locator('#rail-sidebar').click();
  await page.locator(`[data-settings-section="${section}"]`).click();await page.waitForFunction(id=>window.pageEntries.includes('settings-'+id),section);
 }
 if(await page.locator('#rail-sidebar').getAttribute('aria-expanded')!=='true')await page.locator('#rail-sidebar').click();
 await page.locator('[data-settings-section="notifications"]').click();
 assert.deepEqual(await page.evaluate(()=>window.taskCalls),[]);
 await page.locator('#mobile-task-enabled').check();
 await page.locator('#mobile-task-system-settings').click();
 assert.ok(await page.evaluate(()=>window.nativeCalls.some(call=>call[0]==='notifications'&&call[1]===true)));
 client.emit('event',{method:'turn/started',params:{threadId:'notification-thread',turn:{id:'notification-turn',status:'inProgress'}}});
 await page.waitForFunction(()=>window.taskCalls.some(call=>call.state==='running'));
 client.emit('event',{method:'turn/completed',params:{threadId:'notification-thread',turn:{id:'notification-turn',status:'completed'}}});
 await page.waitForFunction(()=>window.taskCalls.some(call=>call.state==='completed'));
 assert.equal(await page.evaluate(()=>window.taskCalls.at(-1).state),'completed');
 await page.locator('#mobile-task-enabled').uncheck();
 checks.push('native task monitoring requires opt-in, preserves completion and opens system settings');
 if(await page.locator('#rail-sidebar').getAttribute('aria-expanded')!=='true')await page.locator('#rail-sidebar').click();
 await page.locator('[data-settings-section="shortcuts"]').click();
 await page.evaluate(()=>document.documentElement.dataset.reducedMotion='true');
 assert.equal(await page.locator('#settings-shortcuts').evaluate(node=>getComputedStyle(node).animationName),'none');
 checks.push('all five pages and settings sections animate, reduced-motion remains respected');
 await page.setViewportSize({width:1280,height:900});assert.equal(await page.locator('.rail > #account-quota').count(),1);assert.equal(await page.locator('.composer-tools > #permissions-info').count(),1);assert.equal(await page.locator('.composer-row > #context-meter').count(),1);
 assert.equal(await page.locator('.rail > #app-update-indicator').count(),1);assert.equal(await page.evaluate(()=>document.querySelector('#app-update-indicator')===window.originalUpdateButton&&window.originalUpdateButton.nextElementSibling.id==='account-quota'),true);
 await page.locator('#app-update-indicator').click();assert.equal(await page.locator('#settings-about').isVisible(),true);
 checks.push('desktop restores the same update button before quotas and preserves its action');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,pageErrors:errors},null,2));
}finally{await browser?.close();await app.close();await rm(temporary,{recursive:true,force:true});}
