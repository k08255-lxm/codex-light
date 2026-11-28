// Uses the real LAN and desktop web routes, loopback listeners, and DemoClient only.
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';

const {chromium} = createRequire(import.meta.url)('playwright');
const temporary = await mkdtemp(path.join(os.tmpdir(),'codecang-read-sync-'));
const client = new DemoClient();
const {thread:first} = await client.call('thread/start',{cwd:temporary});
const {thread:second} = await client.call('thread/start',{cwd:temporary});
const {thread:reading} = await client.call('thread/start',{cwd:temporary});
first.name = '手机阅读测试'; second.name = '另一个会话';
reading.name = '前台阅读中的回答';
const address = '192.168.79.19';
let browser, app, releaseFirstRead;
const errors = [];
function finish(thread,id,text='回复 '+id) {
 const item = {id:'answer-'+id,type:'agentMessage',phase:'final_answer',text};
 const turn = {id,status:'completed',items:[item]};
 client.turns.get(thread.id).push(turn);
 client.items.get(thread.id).push({turnId:id,item});
 client.emit('event',{method:'item/completed',params:{threadId:thread.id,turnId:id,item}});
 client.emit('event',{method:'turn/completed',params:{threadId:thread.id,turn}});
}
const badge = (page,count) => page.waitForFunction(value=>window.badges.at(-1)?.count===value,count);
const marker = (page,thread) => page.locator('.project-group-thread').filter({hasText:thread.name}).locator('.thread-unread-indicator');
const paint = page => page.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function openThread(page,thread) {
 const sidebar = page.locator('#rail-sidebar');
 if (await sidebar.getAttribute('aria-expanded')!=='true') await sidebar.click();
 await page.locator('.project-group-thread').filter({hasText:thread.name}).click();
}
try {
 app = await createServer({demo:true,client,desktop:true,cwd:temporary,desktopStateRoot:path.join(temporary,'desktop'),lanOptions:{
  networkInterfaces:()=>({Synthetic:[{address,family:'IPv4',internal:false}]}),
  serverFactory:handler=>{
   const server = http.createServer((req,res)=>{
    const host = `${address}:${server.address().port}`;
    req.headers.host = host;
    if (req.headers.origin) req.headers.origin = 'http://'+host;
    handler(req,res);
   });
   const listen = server.listen.bind(server);
   server.listen = options => listen({...options,host:'127.0.0.1'});
   return server;
  },
 }});
 await app.started;
 const lan = await app.lan.enable({address});
 const phoneUrl = new URL(lan.url); phoneUrl.hostname='127.0.0.1';
 browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const desktop = await browser.newPage({viewport:{width:1360,height:900}});
 const phone = await browser.newPage({viewport:{width:407,height:886},deviceScaleFactor:2656/886,isMobile:true,hasTouch:true,reducedMotion:'reduce'});
 await desktop.addInitScript(()=>{
  window.badges=[];
  window.chrome ||= {};
  window.chrome.webview={addEventListener(){},postMessage(message){if(message.type==='desktopTaskbarBadge')window.badges.push(message);}};
 });
 await phone.addInitScript(()=>{window.CodexLightNative={isNativeApp:()=>true,getPreferredTheme:()=>'system'};});
 for (const page of [desktop,phone]) {
  page.setDefaultTimeout(8000);
  page.on('pageerror',error=>errors.push(error.message));
 }
 await Promise.all([desktop.goto(app.url),phone.goto(phoneUrl.href)]);
 await desktop.getByRole('button',{name:'使用此主题'}).click();
 await phone.locator('html[data-access="lan"]').waitFor();
 await desktop.locator('.project-group-thread').filter({hasText:first.name}).waitFor();

 finish(first,'first');finish(second,'second');
 await badge(desktop,2);
 await marker(desktop,first).waitFor();await marker(desktop,second).waitFor();
 const blocked = phone.waitForRequest('**/api/thread-reads');
 const resume = new Promise(resolve=>{releaseFirstRead=resolve;});
 const observed = [];
 await phone.route('**/api/thread-reads',async route=>{
  const input = route.request().postDataJSON();
  observed.push(input);
  if (observed.length===1) await resume;
  await route.continue();
 });
 await phone.bringToFront();
 await openThread(phone,first);
 await phone.locator('#messages').getByText('回复 first').waitFor();
 const oldRead = (await blocked).postDataJSON();
 assert.equal(oldRead.threadId,first.id);
 assert.deepEqual(oldRead.turnIds,['first']);
 await phone.locator('#rail-usage').click();
 finish(first,'newer');
 await badge(desktop,3);
 releaseFirstRead();
 await badge(desktop,2);
 await marker(desktop,first).waitFor();await marker(desktop,second).waitFor();
 assert.equal(observed.length,1);
 console.log('PASS foreground reading sends the rendered turn; the delayed receipt preserves the newer completion and the other thread');

 let rejectDesktop = true;
 await desktop.route('**/api/events',route=>rejectDesktop?route.fulfill({status:503}):route.continue());
 app.server.closeAllConnections();
 await desktop.locator('#connection-dot.bad').waitFor({state:'attached'});
 const newerRead = phone.waitForResponse(response=>response.url().endsWith('/api/thread-reads') && response.request().postDataJSON()?.turnIds.includes('newer'));
 await openThread(phone,first);
 await phone.locator('#messages').getByText('回复 newer').waitFor();
 assert.equal((await newerRead).status(),200);
 await badge(desktop,2);
 rejectDesktop = false;
 await badge(desktop,1);
 await marker(desktop,first).waitFor({state:'hidden'});
 await marker(desktop,second).waitFor();
 console.log('PASS desktop reconnect replays the missed mobile receipt and updates the taskbar badge and sidebar');

 await phone.locator('#rail-sidebar').click();
 finish(first,'occluded');
 await badge(desktop,2);
 await phone.locator('#messages').getByText('回复 occluded').waitFor({state:'attached'});
 await paint(phone);
 assert.equal(observed.length,2,'the open mobile sidebar covers the conversation');
 await phone.locator('#close-sidebar').click();
 await badge(desktop,1);

 const longRead = phone.waitForResponse(response=>response.url().endsWith('/api/thread-reads') && response.request().postDataJSON()?.turnIds.includes('long-content'));
 finish(first,'long-content',Array.from({length:35},(_,i)=>`历史段落 ${i+1}。`).join('\n\n'));
 await phone.locator('#messages').getByText('历史段落 35。',{exact:true}).waitFor();
 await longRead;
 await badge(desktop,1);
 const scroller = phone.locator('#conversation');
 await scroller.focus();
 await phone.keyboard.press('Home');
 await phone.waitForFunction(()=>document.querySelector('#conversation').scrollTop<2);
 finish(first,'after-scroll');
 await badge(desktop,2);
 await phone.locator('.project-group-thread').filter({hasText:first.name})
  .locator('.thread-unread-indicator:not([hidden])').waitFor({state:'attached'});
 await paint(phone);
 assert.equal(observed.length,4,'viewing old history must leave the latest result unread');
 await phone.locator('.scroll-to-bottom').click();
 await badge(desktop,1);
 await phone.locator('#messages').getByText('回复 after-scroll').waitFor();
 console.log('PASS the mobile sidebar and older-scroll position defer the read until the reader returns to the latest response');
 await desktop.bringToFront();
 await openThread(desktop,reading);
 await desktop.locator('#conversation[aria-busy="false"]').waitFor();
 const reply=Array.from({length:40},(_,i)=>`正在读的第 ${i+1} 段。`).join('\n\n');
 const turnId='onscreen',item={id:'answer-'+turnId,type:'agentMessage',phase:'final_answer',text:reply};
 client.emit('event',{method:'turn/started',params:{threadId:reading.id,turn:{id:turnId,status:'inProgress'}}});
 client.emit('event',{method:'item/started',params:{threadId:reading.id,turnId,item}});
 const answer=desktop.locator('[data-item-id="answer-onscreen"]');
 await answer.waitFor();
 await desktop.waitForFunction(()=>{const c=document.getElementById('conversation');return c.scrollTop>200&&c.scrollHeight-c.scrollTop-c.clientHeight<3;});
 await desktop.locator('#conversation').hover();
 await desktop.mouse.wheel(0,-160);
 await desktop.waitForFunction(()=>{const c=document.getElementById('conversation');return c.scrollHeight-c.scrollTop-c.clientHeight>100;});
 const badgeCount=await desktop.evaluate(()=>window.badges.length);
 finish(reading,turnId,reply);
 await desktop.locator('[data-turn-id="onscreen"][data-state="completed"]').waitFor();
 await paint(desktop);
 assert.equal(await marker(desktop,reading).isVisible(),false,'a reader looking at the latest reply must not have to reopen it');
 assert.equal(await desktop.evaluate(n=>window.badges.slice(n).some(b=>b.count>1),badgeCount),false,'no transient unread badge for an onscreen reply');
 await marker(desktop,second).waitFor();
 console.log('PASS the visible streaming reply stays read with follow paused; another conversation keeps its dot');
 await desktop.locator('#conversation').focus();
 await desktop.keyboard.press('End');
 await desktop.waitForFunction(()=>{const c=document.getElementById('conversation');return c.scrollHeight-c.scrollTop-c.clientHeight<3;});
 await desktop.locator('#project-dialog').evaluate(dialog=>dialog.showModal());
 finish(reading,'behind-dialog');
 await badge(desktop,2);
 await marker(desktop,reading).waitFor();
 await desktop.locator('#project-close').click();
 await desktop.locator('#messages').getByText('回复 behind-dialog',{exact:true}).waitFor();
 await badge(desktop,1);
 await marker(desktop,reading).waitFor({state:'hidden'});
 await marker(desktop,second).waitFor();
 console.log('PASS closing a dialog clears the newly visible reply and its badge without a thread switch');
 assert.deepEqual(errors,[]);
} finally {
 releaseFirstRead?.();
 await browser?.close();
 await app?.close();
 await rm(temporary,{recursive:true,force:true});
}
