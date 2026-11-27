// Android WebView layout contract in real Chromium; all account/task data are isolated fixtures.
import assert from 'node:assert/strict';
import http from 'node:http';
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
const address='192.168.78.19',browserHost='phone.codecang.test';
const app=await createServer({client,demo:true,cwd:root,projectsRoot:path.join(temporary,'projects'),desktopStateRoot:path.join(temporary,'desktop'),fileAttachmentRoot:path.join(temporary,'attachments'),lanOptions:{
 networkInterfaces:()=>({Synthetic:[{address,family:'IPv4',internal:false}]}),serverFactory:handler=>{
  const server=http.createServer((req,res)=>{
   const port=server.address().port;
   if(req.headers.host===`${browserHost}:${port}`)req.headers.host=`${address}:${port}`;
   if(req.headers.origin===`http://${browserHost}:${port}`)req.headers.origin=`http://${address}:${port}`;
   handler(req,res);
  }),listen=server.listen.bind(server);
  server.listen=options=>listen({...options,host:'127.0.0.1'});
  return server;
 },
}});await app.started;
let browser;const errors=[],checks=[],desktopUpdateReads=[];
try{
 const lan=await app.lan.enable({address});const phoneUrl=new URL(lan.url);phoneUrl.hostname=browserHost;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',args:[`--host-resolver-rules=MAP ${browserHost} 127.0.0.1`,'--no-proxy-server']});
 const page=await browser.newPage({viewport:{width:393,height:850},isMobile:true,hasTouch:true});page.setDefaultTimeout(7000);
 page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/app-update/'))desktopUpdateReads.push(request.method());});
 await page.addInitScript(()=>{window.nativeCalls=[];window.taskCalls=[];window.androidUpdateStatus={phase:'idle'};let enabled=false;window.CodexLightNative={isNativeApp:()=>true,setToolbarIntegrated:flag=>window.nativeCalls.push(['toolbar',flag]),openServerManager:()=>window.nativeCalls.push(['connection']),openApplicationSettings:()=>window.nativeCalls.push(['permissions']),checkForUpdates:()=>window.nativeCalls.push(['android-update']),getAppUpdateStatus:()=>JSON.stringify(window.androidUpdateStatus),openAppUpdate:()=>window.nativeCalls.push(['android-update-open']),getTaskNotificationStatus:()=>JSON.stringify({supported:true,enabled,permissionGranted:true,promotedCandidate:true,reason:enabled?'ready':'disabled'}),setTaskNotificationsEnabled:value=>{enabled=value;window.nativeCalls.push(['notifications',value]);window.dispatchEvent(new Event('codexlight-task-notification-status'));},updateTaskNotification:data=>window.taskCalls.push(JSON.parse(data)),openTaskNotificationSettings:()=>window.nativeCalls.push(['notification-settings'])};});
 page.on('pageerror',error=>errors.push(error.message));await page.goto(phoneUrl.href);
 await page.locator('#connection-text').filter({hasText:'演示模式'}).waitFor({state:'attached'});await page.locator('#mobile-quota-slot .account-quota-row').nth(1).waitFor();
 if(await page.locator('#first-theme').evaluate(dialog=>dialog.open))await page.locator('#first-theme button[type=submit]').click();
 assert.equal(await page.locator('html').getAttribute('data-access'),'lan');
 assert.deepEqual(await page.locator('.account-quota-value').allTextContents(),['76%','39%']);assert.equal(await page.locator('#menu-app').isVisible(),false);
 assert.equal(await page.locator('#app-update-indicator').isVisible(),false);
 const updateNative=phase=>page.evaluate(value=>{window.androidUpdateStatus=value;window.dispatchEvent(new Event('codexlight-android-update-status'));},phase);
 await updateNative({phase:'available',version:'0.5.0'});
 await page.locator('#app-update-indicator').waitFor();
 await page.evaluate(()=>{window.originalUpdateButton=document.querySelector('#app-update-indicator');});
 assert.equal(await page.locator('.app-titlebar > #app-update-indicator').count(),1);
 assert.equal(await page.locator('.rail .update-indicator').count(),0);
 assert.deepEqual(await page.locator('.rail .rail-btn:visible').evaluateAll(buttons=>buttons.map(b=>b.id)),['rail-home','rail-usage','rail-account','rail-settings']);
 await page.locator('#app-update-indicator').click();
 assert.equal(await page.locator('#settings-about').isVisible(),false);
 assert.deepEqual(await page.evaluate(()=>window.nativeCalls.at(-1)),['android-update-open']);
 await updateNative({phase:'downloading',version:'0.5.0'});
 assert.equal(await page.locator('#app-update-indicator').getAttribute('aria-label'),'正在下载更新，版本 0.5.0，查看更新');
 await updateNative({phase:'up_to_date'});assert.equal(await page.locator('#app-update-indicator').isVisible(),false);
 await updateNative({phase:'available',version:'0.5.0'});
 checks.push('the APK update button sits between the phone title and quotas, opens the Android updater, and tracks the native state');
 await page.locator('#rail-settings').click();assert.equal(await page.locator('#sidebar-overlay').isVisible(),false);
 await page.locator('#mobile-connection').click();await page.locator('#mobile-app-permissions').click();
 assert.equal(await page.locator('#mobile-app-update').isVisible(),false);
 await page.locator('#rail-sidebar').click();await page.getByRole('button',{name:'关于',exact:true}).click();
 await page.locator('#mobile-app-update').click();
 assert.equal(await page.locator('#mobile-app-update').innerText(),'查看 v0.5.0 更新');
 assert.deepEqual(await page.evaluate(()=>window.nativeCalls),[['toolbar',true],['android-update-open'],['connection'],['permissions'],['android-update-open']]);
 await updateNative({phase:'up_to_date'});
 await page.getByRole('button',{name:'检查更新',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.nativeCalls.at(-1)),['android-update']);
 await updateNative({phase:'available',version:'0.5.0'});
 assert.equal(await page.evaluate(()=>window.CodexLightNavigation.back()),true);await page.locator('#settings-general').waitFor();
 assert.equal(await page.evaluate(()=>window.CodexLightNavigation.back()),true);await page.waitForFunction(()=>document.getElementById('app').dataset.view==='chat');
 await page.setViewportSize({width:700,height:500});await page.locator('.app-titlebar #rail-settings').waitFor();
 await page.locator('#rail-settings').click();await page.locator('#mobile-connection-settings').waitFor();
 await page.setViewportSize({width:1000,height:850});await page.locator('.rail #rail-settings').waitFor();
 assert.equal(await page.locator('#chat-sidebar #settings').isVisible(),false);
 await page.setViewportSize({width:393,height:850});await page.locator('#rail-home').click();
 checks.push('one Settings entry opens Android connection, permissions and update actions on phones, compact screens and tablets');
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
   return {overflow:document.documentElement.scrollWidth>innerWidth,footer:['cwd-button','permissions-info','context-meter'].map(rect),toolbar:['add-attachment','add-file','model-trigger','queue-send','stop','send'].map(rect),titlebar:['app-update-indicator','mobile-quota-slot','mobile-refresh'].map(rect),projectOffset:rect('cwd-button').x-foot.x,modelEndGap:model.right-chevron.right};
  });
  assert.equal(geometry.overflow,false,`overflow at ${width}`);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,`viewport at ${width}`);
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
 for(const [rail,target]of [['usage','usage-page'],['account','account-page'],['home','chat-page'],['settings','settings-dialog']]){
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
 client.emit('event',{method:'thread/started',params:{thread:{id:'notification-thread',source:'appServer'}}});
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
 await page.locator('#app-update-indicator').click();assert.equal(await page.locator('#settings-about').isVisible(),false);
 assert.deepEqual(await page.evaluate(()=>window.nativeCalls.at(-1)),['android-update-open']);
 checks.push('the wider Android layout reuses the APK update button and still opens the Android updater');
 for(const width of [1440,393]){
  await page.setViewportSize({width,height:850});
  const result=await page.evaluate(async()=>{
   const panel=document.querySelector('#details'),toggle=document.querySelector('#toggle-details'),close=document.querySelector('#close-details');
   document.documentElement.dataset.reducedMotion='false';
   const style=()=>getComputedStyle(panel);
   const transition=()=>{void style().opacity;return panel.getAnimations().map(a=>a.transitionProperty);};
   const settle=()=>Promise.all(panel.getAnimations().map(a=>a.finished));
   toggle.click();const opening=transition();await settle();
   close.click();const closing=transition(),inertOnClose=panel.inert;
   const focusRestored=document.activeElement===toggle;
   // Reverse an in-flight close to exercise quick successive clicks.
   for(const animation of panel.getAnimations())animation.currentTime=60;
   void style().opacity;toggle.click();transition();await settle();
   const reopened=style().visibility==='visible'&&!panel.inert;
   close.click();transition();await settle();const hidden=style().visibility==='hidden';
   document.documentElement.dataset.reducedMotion='true';
   toggle.click();const reduced=transition();close.click();
   return {opening,closing,inertOnClose,focusRestored,reopened,hidden,reduced};
  });
  const movement=width>1200?'margin-right':'transform';
  for(const direction of ['opening','closing'])assert.ok(result[direction].includes('opacity')&&result[direction].includes(movement),width+' '+direction+' '+result[direction]);
  assert.ok(result.inertOnClose&&result.focusRestored&&result.reopened&&result.hidden);
  assert.deepEqual(result.reduced,[]);
 }
 checks.push('activity panel animates in both directions, reverses on repeat clicks, and respects reduced motion on desktop and mobile');
 assert.deepEqual(desktopUpdateReads,[]);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,pageErrors:errors},null,2));
}finally{await browser?.close();await app.close();await rm(temporary,{recursive:true,force:true});}
