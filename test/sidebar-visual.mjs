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
 await page.goto(app.url);await page.locator('#connection-text').filter({hasText:'演示模式'}).waitFor();
 assert.equal(await page.locator('#rail-dsh').count(),0);
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:920});
  for(const [entry,route] of [['rail-home','chat'],['rail-usage','usage'],['rail-account','account'],['rail-terminal','terminal'],['rail-settings','settings']]){
   await page.locator('#'+entry).click();
   const toggle=page.locator('#rail-sidebar');assert.equal(await toggle.isVisible(),true,`${width} ${route} toggle`);
   if(await toggle.getAttribute('aria-expanded')==='true'){if(width<760)await page.locator(route==='settings'?'#settings-sidebar-close':'#close-sidebar').click();else await toggle.click();}
   assert.equal(await toggle.getAttribute('aria-expanded'),'false');await toggle.click();
   assert.equal(await toggle.getAttribute('aria-expanded'),'true');
   assert.equal(await page.locator(route==='settings'?'#settings-sidebar':'#chat-sidebar').isVisible(),true,`${width} ${route} sidebar content`);
   if(width<760){
    assert.equal(await toggle.evaluate(n=>!!n.closest('.stage:not(.hidden)')),true,`${route} visible stage toggle`);
    assert.equal(await page.locator('#sidebar-overlay').isVisible(),true);await page.keyboard.press('Escape');
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await toggle.evaluate(n=>n===document.activeElement),true);
   }
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false,'no horizontal viewport overflow');
   await page.screenshot({path:path.join(out,`${width}-${route}.png`)});checks.push(`${width} ${route}: visible toggle, correct sidebar, repeated toggle, keyboard, viewport`);
  }
 }
 assert.deepEqual(errors,[]);console.log(checks.join('\n'));
}finally{await writeFile(path.join(out,'checks.json'),JSON.stringify({checks,errors},null,2));await browser.close();await app.close?.();client.close();}
process.exit(0);
