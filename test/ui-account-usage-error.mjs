// Real Chromium account rendering with synthetic responses; no model or real account requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
const temporary=await mkdtemp(path.join(os.tmpdir(),'codecang-account-error-'));
const app=await createServer({client:new DemoClient(),demo:true,cwd:process.cwd(),projectsRoot:path.join(temporary,'projects'),desktopStateRoot:path.join(temporary,'state'),fileAttachmentRoot:path.join(temporary,'files')});
await app.started;
let browser;
const pageErrors=[],checks=[];
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:320,height:800}});
 page.on('pageerror',error=>pageErrors.push(error.message));
 await page.route('**/__account-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body style="margin:0;overflow:auto"><main id="fixture"></main></body></html>'}));
 await page.goto(app.origin+'/__account-fixture');
 await page.evaluate(async()=>{
  const {mountAccount}=await import('/ui/account-view.js');
  window.fixtureMode='thread-failure';
  window.fixtureAccount=mountAccount(document.querySelector('#fixture'),{getThreadId:()=> 'current',rpc:async(method,params)=>{
   if(method==='account/read')return {account:null};
   if(method==='account/rateLimits/read')return {rateLimits:{primary:{usedPercent:24,windowDurationMins:300}}};
   if((window.fixtureMode==='thread-failure'&&params.threadId)||(window.fixtureMode==='account-failure'&&!params.threadId))throw Object.assign(new Error('HTTP 500 Internal Server Error https://example.test?token=PRIVATE_TOKEN'),{code:-32603});
   if(params.threadId)return {threadUsage:window.fixtureMode==='unavailable'?null:{threadId:'current',estimatedUsageCreditsMicros:1000000,groups:[]}};
   return {summary:{lifetimeTokens:1200},dailyUsageBuckets:[]};
  }});
  await window.fixtureAccount.activate();
 });
 const section=page.locator('.acct-usage');
 assert.match(await section.textContent(),/当前对话.*HTTP 500.*RPC -32603/);
 assert.doesNotMatch(await section.textContent(),/PRIVATE_TOKEN|https|封禁|风控/);
 assert.match(await page.locator('.acct-quota').textContent(),/剩余 76%/);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 checks.push('320 px: safe thread error preserves account totals/quota with no horizontal page overflow');
 await page.evaluate(async()=>{window.fixtureMode='account-failure';await window.fixtureAccount.refresh();});
 assert.match(await section.textContent(),/估算 Credits1/);
 assert.match(await section.textContent(),/官方账户汇总.*HTTP 500/);
 assert.match(await section.locator('.acct-usage-caption').textContent(),/当前对话/);
 checks.push('account failure still displays successful current-thread estimate');
 await page.evaluate(async()=>{window.fixtureMode='unavailable';await window.fixtureAccount.refresh();});
 assert.match(await section.textContent(),/官方尚未提供当前对话的用量估算/);
 assert.equal(await section.locator('.inline-error').count(),0);
 assert.deepEqual(pageErrors,[]);
 checks.push('null official estimate is distinct from a failed read; recovered error disappears');
 console.log(JSON.stringify({checks,pageErrors},null,2));
}finally{
 await browser?.close();await app.close();
 if(path.dirname(temporary)!==path.resolve(os.tmpdir())||!path.basename(temporary).startsWith('codecang-account-error-'))throw new Error('Unexpected test cleanup path');
 await rm(temporary,{recursive:true,force:true});
}
