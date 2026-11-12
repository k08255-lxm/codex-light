// Run explicitly: node test/ui-smoke.mjs (requires local Playwright + Chromium).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { createServer } from '../src/server.mjs';
import { DemoClient } from '../src/demo.mjs';
const require=createRequire(import.meta.url); const { chromium }=require('playwright');
await mkdir(new URL('../.tmp/ui-smoke/',import.meta.url),{recursive:true});
const client = new DemoClient();
const app=await createServer({client,demo:true,cwd:os.tmpdir()}); await app.started;
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})}); const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const check=[];
try {
 await page.goto(app.url); await page.locator('#connection-text').filter({hasText:'演示模式'}).waitFor();
 assert.equal(await page.evaluate(()=>location.hash),''); check.push('URL token removed; session authenticated');
 // Regress the measured small-window welcome layout in browser and native CSS modes.
 await page.setViewportSize({width:707,height:534});
 for(const native of [false,true]){
  await page.evaluate(value=>document.documentElement.classList.toggle('native-caption-integrated',value),native);
  const boxes=await page.evaluate(()=>{const read=s=>{const b=document.querySelector(s).getBoundingClientRect();return {top:b.top,bottom:b.bottom,height:b.height};};return {heading:read('#welcome h1'),conversation:read('#conversation'),composer:read('.composer-dock'),scrollTop:document.getElementById('conversation').scrollTop};});
  assert.ok(boxes.heading.height>0);assert.ok(boxes.heading.top>=boxes.conversation.top);assert.ok(boxes.heading.bottom<=boxes.conversation.bottom);assert.ok(boxes.heading.bottom<=boxes.composer.top);assert.equal(boxes.scrollTop,0);
 }
 await page.screenshot({path:fileURLToPath(new URL('../.tmp/ui-smoke/gui-welcome-small.png',import.meta.url))});
 await page.evaluate(()=>document.documentElement.classList.remove('native-caption-integrated'));await page.setViewportSize({width:1440,height:1000});
 check.push('707×534 welcome title fits remaining conversation above composer in browser/native CSS modes');
 await page.screenshot({path:fileURLToPath(new URL('../.tmp/ui-smoke/gui-welcome.png',import.meta.url))});
 // Use supplied demo catalog stops, real native-range keyboard, and model changes.
 await page.locator('#model-trigger').click();await page.locator('#model-list-open').click();await page.locator('.model-option').filter({hasText:'演示五档模型'}).click();
 assert.equal(await page.locator('#reasoning-range').getAttribute('max'),'4');await page.locator('#reasoning-range').focus();await page.keyboard.press('End');assert.equal(await page.locator('#effort').inputValue(),'max');
 await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('#effort').inputValue(),'xhigh');await page.locator('#reasoning-reset').click();assert.equal(await page.locator('#effort').inputValue(),'medium');
 await page.locator('#model-list-open').click();await page.locator('.model-option').filter({hasText:'演示六档模型'}).click();assert.equal(await page.locator('#reasoning-range').getAttribute('max'),'5');assert.equal(await page.locator('#effort').inputValue(),'medium');
 await page.locator('#reasoning-range').focus();await page.keyboard.press('End');assert.equal(await page.locator('#effort').inputValue(),'ultra');
 await page.locator('#model-list-open').click();await page.locator('.model-option').filter({hasText:'演示五档模型'}).click();assert.equal(await page.locator('#effort').inputValue(),'medium');await page.keyboard.press('Escape');
 check.push('Five/six-stop catalogs, range keyboard, reset, supported preservation and unsupported fallback');
 await page.locator('#prompt').fill('界面测试：<img src=x onerror="window.injected=true">');
 await page.locator('#send').click(); await page.waitForFunction(()=>!document.querySelector('#stop:not(.hidden)')&&[...document.querySelectorAll('.turn .turn-process-label')].some(n=>/用时|已处理/.test(n.textContent)));
 assert.equal(client.threads.size,1);assert.equal(client.modelTurns.at(-1).model,'demo-five');assert.equal(client.modelTurns.at(-1).effort,'medium'); assert.equal(await page.locator('#messages .turn > .message').count(),2); assert.equal(await page.evaluate(()=>window.injected),undefined);check.push('Send, streaming, completion, text XSS resistance');
 const first=[...client.threads.keys()][0];
 // Repeated submit is synchronous guarded, not three billable starts.
 let turns=0; let lastTurnParams; const calledMethods=[]; const originalCall=client.call.bind(client);client.call=async(method,p)=>{calledMethods.push(method);if(method==='turn/start'){turns++;lastTurnParams=p;} return originalCall(method,p);};
 await page.locator('#model-trigger').click(); await page.locator('#model-list-open').click(); await page.locator('.model-option').filter({hasText:'演示模型'}).click(); await page.locator('#reasoning-reset').click(); assert.equal(await page.locator('#effort').inputValue(),'high'); await page.locator('#reasoning-range').evaluate(node=>{node.value='0';node.dispatchEvent(new Event('input',{bubbles:true}));}); assert.equal(await page.locator('#effort').inputValue(),'high'); await page.keyboard.press('Escape'); assert.equal(await page.locator('#reasoning-popover').isVisible(),false); await page.locator('#prompt').fill('重复提交保护');await page.evaluate(()=>{const f=document.getElementById('compose');for(let i=0;i<3;i++)f.dispatchEvent(new Event('submit',{cancelable:true}));});
 await page.locator('#stop').waitFor({state:'visible'});assert.equal(turns,1);assert.equal(lastTurnParams.effort,'high');assert.equal(lastTurnParams.model,'demo');await page.locator('#stop').click();await page.locator('.turn-footer').filter({hasText:'已停止'}).last().waitFor();check.push('Repeated submits start once; stop works');
 // IME Enter must not send.
 await page.locator('#prompt').fill('输入法测试');await page.locator('#prompt').dispatchEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true});await page.waitForTimeout(100);assert.equal(turns,1);check.push('IME composing Enter does not send');
 await page.locator('#new-thread').click();assert.equal(await page.locator('#welcome').isVisible(),true);
 await page.locator('#prompt').fill('第二个对话');await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#stop:not(.hidden)')&&[...document.querySelectorAll('.turn .turn-process-label')].some(n=>/用时|已处理/.test(n.textContent)));assert.equal(client.threads.size,2);
 await page.locator('.project-group-thread').filter({hasText:'重复提交保护'}).click();await page.waitForTimeout(200);assert.equal(await page.locator('#messages .turn > .message').count(),4);check.push('Separate threads and history resume');
 await page.reload(); await page.locator('#connection-text').filter({hasText:'演示模式'}).waitFor();await page.locator('.project-group-thread').filter({hasText:'重复提交保护'}).click();await page.waitForTimeout(150);check.push('Reload retains local authentication; history reopened via RPC');
 // Confirm a real server request explicitly, not on receipt.
 const request={id:801,method:'item/commandExecution/requestApproval',params:{threadId:first,command:'echo approval-test',cwd:os.tmpdir()}};client.requests.set('801',request);client.emit('event',request);
 await page.locator('.approval').waitFor(); assert.equal(client.requests.has('801'),true);await page.getByRole('button',{name:'仅允许这一次'}).click();await page.locator('.approval').waitFor({state:'detached'});assert.equal(client.requests.has('801'),false);check.push('Approval remains pending until explicit click');
 // Permission/form fixtures are local DemoClient requests; no actual grant or external service.
 let recordedResponse;const originalRespond=client.respond.bind(client);client.respond=(id,result,error)=>{recordedResponse={id,result,error};return originalRespond(id,result,error);};
 const permissions={id:802,method:'item/permissions/requestApproval',params:{threadId:first,turnId:'demo-permissions',itemId:'permissions',environmentId:null,startedAtMs:Date.now(),cwd:os.tmpdir(),reason:'Local UI fixture',permissions:{network:{enabled:true},fileSystem:{read:[os.tmpdir()]}}}};
 client.requests.set('802',permissions);client.emit('event',permissions);await page.locator('.approval-permissions').waitFor();assert.equal(await page.locator('.permission-choice input:checked').count(),0);assert.equal(await page.getByRole('button',{name:'仅本轮授予所选权限'}).isDisabled(),true);
 await page.locator('.permission-choice input').first().check();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'仅本轮授予所选权限'}).click();await page.locator('.approval').waitFor({state:'detached'});assert.deepEqual(recordedResponse.result,{permissions:{network:{enabled:true}},scope:'turn'});
 const elicitation={id:803,method:'mcpServer/elicitation/request',params:{threadId:first,turnId:null,serverName:'local-fixture-only',mode:'form',_meta:null,message:'Demo form',requestedSchema:{type:'object',properties:{label:{type:'string',title:'Fixture label',minLength:2},count:{type:'integer',minimum:1,maximum:5}},required:['label']}}};
 client.requests.set('803',elicitation);client.emit('event',elicitation);await page.locator('.approval-form').waitFor();await page.getByLabel('Fixture label（必填）').fill('safe');await page.getByLabel('count（选填）').fill('3');page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'发送表单给此服务'}).click();await page.locator('.approval').waitFor({state:'detached'});assert.deepEqual(recordedResponse.result,{action:'accept',content:{label:'safe',count:3},_meta:null});
 const expired={...elicitation,id:804};client.requests.set('804',expired);client.emit('event',expired);await page.locator('.approval-form').waitFor();client.requests.delete('804');client.emit('event',{method:'serverRequest/resolved',params:{requestId:804}});await page.locator('.approval').waitFor({state:'detached'});assert.equal(recordedResponse.id,803);check.push('Explicit permission subset, typed MCP form, and resolved request removal');
 // Record browser work, not model latency. Push 250 rows and 5000 stream chunks.
 await page.evaluate(()=>{window.longTasks=[];window.observer=new PerformanceObserver(l=>window.longTasks.push(...l.getEntries().map(e=>e.duration)));window.observer.observe({type:'longtask',buffered:false});window.stressStart=performance.now();});
 const start=performance.now();
 for(let i=0;i<400;i++)client.emit('event',{method:'item/completed',params:{threadId:first,item:{id:`stress-${i}`,type:'agentMessage',text:'合成消息 '+i+'\n'+'测试内容 '.repeat(100)}}});
 for(let i=0;i<5000;i++)client.emit('event',{method:'item/agentMessage/delta',params:{threadId:first,itemId:'stream',delta:'字'}});
 await page.waitForFunction(()=>document.querySelector('[data-item-id="stream"] .message-text')?.textContent.length===5000,{timeout:10000});
 const elapsed=performance.now()-start;const domCount=await page.locator('#messages .message').count();assert.ok(domCount<=300,`message DOM bounded by the 300-item window (got ${domCount})`);const longest=await page.evaluate(()=>Math.max(0,...window.longTasks));check.push('400 rows + 5000 deltas: message DOM bounded by the 300-item window, final streamed content complete');
 // History no raw HTML, tools details toggle, settings Cancel does not change cwd.
 await page.locator('#toggle-details').click();assert.equal(await page.locator('#details').isVisible(),true);await page.locator('#close-details').click();
 await page.locator('#settings').click();await page.locator('#cwd-input').fill('/should-not-save');await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.locator('#cwd-button').getAttribute('title'),os.tmpdir(),'Cancel keeps the original working directory');assert.equal(await page.locator('#chat-page').isVisible(),true);check.push('Tools panel opens/closes; settings Cancel preserves cwd');
 // Image-only sends require a local upload but no text; demo never invokes a model.
 await page.locator('#prompt').fill('');
 await page.locator('#attachment-input').setInputFiles({name:'one-pixel.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKhkAAAAASUVORK5CYII=','base64')});
 await page.waitForFunction(()=>!document.getElementById('send').disabled);
 await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#stop:not(.hidden)')&&[...document.querySelectorAll('.turn .turn-process-label')].some(n=>/用时|已处理/.test(n.textContent)));
 assert.ok(lastTurnParams.input.some(item=>item.type==='localImage'));assert.ok(!lastTurnParams.input.some(item=>item.type==='text'&&!item.text));
 check.push('Image-only draft uploads locally and sends resolved image input; selected effort/model forwarded');
 // Opening work surfaces must not silently create a shell or issue Git commands.
 const beforeCommands=calledMethods.filter(method=>method==='command/exec').length;
 await page.locator('#rail-terminal').click();assert.equal(await page.locator('#terminal-page').isVisible(),true);await page.locator('#terminal-tab-git').click();assert.equal(await page.locator('#terminal-git-workspace').isVisible(),true);assert.equal(calledMethods.filter(method=>method==='command/exec').length,beforeCommands);
 await page.locator('#rail-plugins').click();assert.equal(await page.locator('#settings-plugins').isVisible(),true);await page.waitForTimeout(100);assert.ok(calledMethods.includes('plugin/list'));
 await page.locator('#rail-usage').click();assert.equal(await page.locator('#usage-page').isVisible(),true);assert.equal(await page.locator('#stats-root .kpi-row').isVisible(),true);await page.locator('#rail-account').click();assert.equal(await page.locator('#account-page').isVisible(),true);await page.waitForTimeout(150);assert.ok(calledMethods.includes('account/usage/read'));await page.locator('#rail-home').click();
 check.push('Workspace navigation never auto-opens shell/Git; plugins, analytics and official account usage load only on explicit page entry');
 await page.screenshot({path:fileURLToPath(new URL('../.tmp/ui-smoke/gui-conversation.png',import.meta.url))});
 const report={date:new Date().toISOString(),checks:check,synthetic:{rows:400,deltas:5000,renderedMessages:domCount,elapsedMs:Math.round(elapsed),maxObservedLongTaskMs:Math.round(longest)},pageErrors:errors,limits:[`${process.platform} headless Chromium synthetic UI test, not a native-window test`,'No paid model inference; no comparison to official app performance','Demo history is in memory; real history uses Codex app-server']};
 assert.deepEqual(errors,[]);await writeFile(new URL('../.tmp/ui-smoke/ui-test-results.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {await browser.close();await app.close();}
