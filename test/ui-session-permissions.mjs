// Independent Chromium contexts use the normal local and LAN routes. All engine calls use DemoClient.
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';

const {chromium}=createRequire(import.meta.url)('playwright');
const root=process.cwd(), output=path.join(root,'.tmp','ui-session-permissions');
await mkdir(output,{recursive:true});
const temporary=await mkdtemp(path.join(output,'session-'));
const client=new DemoClient(), call=client.call.bind(client), sent=[], errors=[], checks=[];
const first=(await call('thread/start',{cwd:root})).thread, second=(await call('thread/start',{cwd:root})).thread;
first.name='跨端批准方式';second.name='独立会话批准方式';
client.call=async(method,params)=>{
 if(method==='turn/start')sent.push(structuredClone(params));
 return call(method,params);
};
const address='192.168.75.20', phoneEvents=new Set();
let phoneOffline=false;
function loopbackLanServer(handler){
 const server=http.createServer((req,res)=>{
  const host=`${address}:${server.address().port}`;
  // Keep test traffic on loopback while exercising LAN authentication and event delivery.
  req.headers.host=host;
  if(req.headers.origin)req.headers.origin='http://'+host;
  if(req.url==='/api/events'){
   if(phoneOffline){res.writeHead(503);res.end();return;}
   phoneEvents.add(res);
   res.once('close',()=>phoneEvents.delete(res));
  }
  handler(req,res);
 });
 const listen=server.listen.bind(server);
 server.listen=options=>listen({...options,host:'127.0.0.1'});
 return server;
}
const app=await createServer({client,demo:true,desktop:true,cwd:root,desktopStateRoot:path.join(temporary,'desktop'),
 projectsRoot:path.join(temporary,'projects'),fileAttachmentRoot:path.join(temporary,'attachments'),
 lanOptions:{networkInterfaces:()=>({Synthetic:[{address,family:'IPv4',internal:false}]}),serverFactory:loopbackLanServer}});
await app.started;
let browser, phone;
const chip=page=>page.locator('#permissions-info');
const label=(page,text)=>chip(page).locator('.label').filter({hasText:text}).waitFor();
async function openThread(page,name){
 const row=page.locator('.project-group-thread').filter({hasText:name});
 const sidebar=page.locator('#rail-sidebar');
 if(await sidebar.getAttribute('aria-expanded')!=='true')await sidebar.click();
 await row.click();
 await page.locator('#thread-title').filter({hasText:name}).waitFor();
}
async function choose(page,mode){
 await chip(page).click();
 await page.locator(`#permission-menu [data-value="${mode}"]`).click();
}
try{
 const lanResponse=await fetch(app.origin+'/api/lan/enable',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify({address})});
 assert.equal(lanResponse.status,200);
 const lan=await lanResponse.json(), phoneUrl=new URL(lan.url);phoneUrl.hostname='127.0.0.1';
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const desktop=await browser.newPage({viewport:{width:1360,height:900}});
 phone=await browser.newPage({viewport:{width:393,height:852},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
 for(const page of [desktop,phone]){page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));}
 await Promise.all([desktop.goto(app.url),phone.goto(phoneUrl.href)]);
 await phone.locator('html[data-access="lan"]').waitFor();
 for(const page of [desktop,phone])await openThread(page,first.name);
 await choose(desktop,'request');
 await label(desktop,'请求批准');await label(phone,'请求批准');
 await choose(desktop,'auto');
 await label(desktop,'帮我批准');await label(phone,'帮我批准');
 checks.push('desktop save updates the already-open LAN page without reloading');

 await phone.locator('#prompt').fill('Synthetic approval sync exercise');
 const turnResponse=phone.waitForResponse(response=>response.url().endsWith('/api/rpc')&&response.request().postDataJSON()?.method==='turn/start');
 await phone.locator('#send').click();
 await phone.locator('.userMessage').filter({hasText:'Synthetic approval sync exercise'}).waitFor();
 assert.equal((await turnResponse).status(),200);
 assert.equal(sent.length,1);
 assert.equal(sent[0].threadId,first.id);
 assert.equal(sent[0].approvalPolicy,'on-request');
 assert.equal(sent[0].approvalsReviewer,'auto_review');
 assert.deepEqual(sent[0].sandboxPolicy,{type:'workspaceWrite'});
 checks.push('LAN send forwards the actual automatic reviewer and sandbox to turn/start');

 let failWrite=true;
 await desktop.route('**/api/session/permission',async route=>{
  if(failWrite&&route.request().postDataJSON()?.mode){
   failWrite=false;await route.fulfill({status:409,json:{error:'模拟保存失败'}});return;
  }
  await route.continue();
 });
 await choose(desktop,'request');
 await desktop.locator('#notice').filter({hasText:'模拟保存失败'}).waitFor();
 await label(phone,'帮我批准');
 await label(desktop,'帮我批准');
 await choose(desktop,'auto');
 await label(desktop,'帮我批准');
 checks.push('a rejected write does not change the other page and the next explicit save recovers');

 phoneOffline=true;
 for(const response of phoneEvents)response.end();
 await label(phone,'读取批准方式');
 await choose(desktop,'request');await label(desktop,'请求批准');
 phoneOffline=false;
 await label(phone,'请求批准');
 await phone.locator('#thread-menu-button:enabled').waitFor();
 checks.push('LAN reconnect reloads the saved mode after missing the change event');

 await openThread(phone,second.name);await choose(phone,'request');await label(phone,'请求批准');
 await choose(desktop,'auto');await label(desktop,'帮我批准');
 assert.equal(await chip(phone).locator('.label').textContent(),'请求批准');
 await openThread(phone,first.name);await label(phone,'帮我批准');
 checks.push('another active conversation keeps its own setting and restores the original on return');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks,pageErrors:errors},null,2));
}catch(error){
 if(phone)await phone.screenshot({path:path.join(output,'failure.png')});
 console.error(JSON.stringify({checks,errors,sent:sent.map(({threadId,approvalPolicy,approvalsReviewer,sandboxPolicy})=>({threadId,approvalPolicy,approvalsReviewer,sandboxPolicy}))}));
 throw error;
}finally{
 await browser?.close();await app.close();await rm(temporary,{recursive:true,force:true});
}
