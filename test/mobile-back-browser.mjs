// Headless SPA contract test; not a physical Android gesture test.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {createServer} from '../src/server.mjs';import {DemoClient} from '../src/demo.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const out=path.join(root,'.tmp','mobile-back');await mkdir(out,{recursive:true});
const profile=await mkdtemp(path.join(out,'profile-'));const client=new DemoClient();
const app=await createServer({client,demo:true,cwd:root,fileAttachmentRoot:path.join(profile,'attachments'),projectsRoot:path.join(profile,'projects'),desktopStateRoot:path.join(profile,'desktop')});await app.started;
const browser=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:390,height:844},executablePath:process.env.CHROMIUM_PATH,args:['--no-first-run','--no-default-browser-check']});
const page=browser.pages()[0];const errors=[];page.on('pageerror',e=>errors.push(e.message));const checks=[];
const back=()=>page.evaluate(()=>window.CodexLightNavigation.back());
try {
 await page.goto(app.url);await page.waitForFunction(()=>window.CodexLightNavigation);
 const initialUrl=page.url();
 assert.equal(await back(),false);checks.push('root delegates to native fallback');
 await page.locator('#toggle-details').click();await page.locator('#details').waitFor({state:'visible'});
 await page.screenshot({path:path.join(out,'activity.png')});
 assert.equal(await back(),true);assert.equal(await page.locator('#details').isVisible(),false);checks.push('activity dismiss');
 await page.locator('#rail-sidebar').click();assert.equal(await back(),true);assert.equal(await page.locator('#rail-sidebar').getAttribute('aria-expanded'),'false');checks.push('sidebar dismiss');
 await page.locator('#rail-account').click();await page.locator('#rail-settings').click();
 // Settings opens its drawer on narrow screens: Back must dismiss before navigating.
 assert.equal(await back(),true);assert.equal(await page.locator('#app').getAttribute('data-view'),'settings');
 assert.equal(await back(),true);assert.equal(await page.locator('#app').getAttribute('data-view'),'account');
 assert.equal(await back(),true);assert.equal(await page.locator('#app').getAttribute('data-view'),'chat');checks.push('drawer then route stack');
 await page.locator('#cwd-button').click();assert.equal(await page.locator('#project-dialog').isVisible(),true);
 assert.equal(await back(),true);await page.locator('#project-dialog').waitFor({state:'hidden'});checks.push('modal cancel');
 await page.locator('#model-trigger').click();assert.equal(await back(),true);assert.equal(await page.locator('#reasoning-popover').isVisible(),false);checks.push('model popover dismiss');
 for(let i=0;i<3;i++){await page.locator('#rail-sidebar').click();assert.equal(await back(),true);assert.equal(await back(),false);}checks.push('repeated open/back has no stale history');
 await page.locator('#rail-usage').click();await page.locator('#rail-home').click();assert.equal(await back(),false);checks.push('explicit home clears route trail');
 assert.equal(page.url(),initialUrl);checks.push('SPA handling does not rewrite browser URL/history');
 await page.screenshot({path:path.join(out,'toolbar.png')});assert.deepEqual(errors,[]);console.log(checks.join('\n'));
} finally {await page.screenshot({path:path.join(out,'last.png')});await writeFile(path.join(out,'checks.json'),JSON.stringify({checks,errors},null,2));await browser.close();await app.close?.();client.close();}
process.exit(0);
