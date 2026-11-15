// Headless only. Uses DemoClient and a fresh profile, never real Codex data or inference.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {createServer} from '../src/server.mjs';import {DemoClient} from '../src/demo.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const out=path.join(root,'.tmp','sidebar-visual');await mkdir(out,{recursive:true});
const profile=await mkdtemp(path.join(out,'profile-'));
const client=new DemoClient();
const app=await createServer({client,demo:true,cwd:root,fileAttachmentRoot:path.join(profile,'attachments'),projectsRoot:path.join(profile,'projects'),desktopStateRoot:path.join(profile,'desktop')});await app.started;
const browser=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:1440,height:920},executablePath:process.env.CHROMIUM_PATH,args:['--no-first-run','--no-default-browser-check']});
const page=browser.pages()[0];const errors=[];page.on('pageerror',e=>errors.push(e.message));const checks=[];
try{
 await page.goto(app.url);await page.waitForFunction(()=>document.querySelector('#connection-text')?.textContent.includes('演示模式'));
 const snap=()=>page.evaluate(()=>{const s=document.querySelector('#sidebar'),app=document.querySelector('#app'),o=document.querySelector('#sidebar-overlay');return{width:s.getBoundingClientRect().width,opacity:getComputedStyle(s).opacity,visibility:getComputedStyle(s).visibility,inert:s.inert,expanded:document.querySelector('#rail-sidebar').getAttribute('aria-expanded'),animating:app.classList.contains('sidebar-animating'),transition:getComputedStyle(s).transitionDuration,overlayVisible:getComputedStyle(o).visibility,overlayPointer:getComputedStyle(o).pointerEvents,active:document.activeElement?.id,overflow:document.documentElement.scrollWidth>innerWidth}});
 for(const width of [1440,900,390]){
  await page.setViewportSize({width,height:920});await page.waitForTimeout(350);
  const toggle=page.locator('#rail-sidebar');
  if(await toggle.getAttribute('aria-expanded')==='true'){await toggle.evaluate(n=>n.click());await page.waitForTimeout(350);}
  const closed=await snap();assert.equal(closed.inert,true);assert.equal(closed.visibility,'hidden');
  await toggle.evaluate(n=>n.click());await page.waitForTimeout(100);const middle=await snap();
  await page.screenshot({path:path.join(out,width+'-mid-open.png')});
  await page.waitForTimeout(270);const opened=await snap();assert.equal(opened.inert,false);assert.equal(opened.expanded,'true');assert.equal(opened.animating,false);assert.equal(opened.overflow,false);
  await toggle.evaluate(n=>n.click());await page.waitForTimeout(80);await toggle.evaluate(n=>n.click());await page.waitForTimeout(350);assert.equal((await snap()).expanded,'true');
  await toggle.evaluate(n=>n.click());await page.waitForTimeout(100);await page.setViewportSize({width:width+15,height:920});await page.waitForTimeout(50);const resized=await snap();assert.equal(resized.animating,false);assert.equal(resized.inert,true);await page.waitForTimeout(400);const settledResize=await snap();assert.equal(settledResize.visibility,'hidden');if(width>760)assert.equal(settledResize.width,0);
  await page.evaluate(()=>document.documentElement.dataset.reducedMotion='true');await toggle.evaluate(n=>n.click());const reduced=await snap();assert.equal(reduced.transition,'0s');
  await page.evaluate(()=>delete document.documentElement.dataset.reducedMotion);await page.waitForTimeout(350);
  checks.push({width,closed,middle,opened,resized,reduced});
 }
 await page.setViewportSize({width:390,height:920});await page.waitForTimeout(350);const t=page.locator('#rail-sidebar');if(await t.getAttribute('aria-expanded')==='true'){await page.locator('#close-sidebar').click();await page.waitForTimeout(350);}await t.click();await page.waitForTimeout(350);await page.keyboard.press('Escape');await page.waitForTimeout(350);assert.equal(await t.evaluate(n=>document.activeElement===n),true);
 await page.setViewportSize({width:1440,height:920});await page.waitForTimeout(350);
 await page.evaluate(async()=>{const {mountUpdateIndicator}=await import('/ui/update-indicator.js');document.querySelector('#app-update-indicator')?.remove();const q=document.querySelector('#account-quota');q.hidden=false;q.classList.remove('hidden');q.textContent='72%';const i=mountUpdateIndicator(q.parentElement,{onOpen(){}});i.update({supported:true,latest:{available:true,version:'0.4.7'},phase:'available'});});
 const order=await page.evaluate(()=>{let b=document.querySelector('#app-update-indicator'),q=document.querySelector('#account-quota');return{adjacent:b.nextElementSibling===q,b:b.getBoundingClientRect().toJSON(),q:q.getBoundingClientRect().toJSON()}});console.log('ORDER',order);assert.equal(order.adjacent,true);assert.ok(order.b.bottom<=order.q.top+1);checks.push({order});await page.screenshot({path:path.join(out,'1440-update-quota.png')});
 assert.deepEqual(errors,[]);console.log(JSON.stringify(checks,null,2));
}finally{await writeFile(path.join(out,'checks.json'),JSON.stringify({checks,errors},null,2));await browser.close();await app.close?.();client.close();}
process.exit(0);
