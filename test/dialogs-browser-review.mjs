import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
const out=path.resolve('.tmp/dialogs-browser');await mkdir(out,{recursive:true});
const profile=await mkdtemp(path.join(out,'profile-'));
const app=await createServer({demo:true,cwd:process.cwd(),desktopStateRoot:path.join(profile,'state'),fileAttachmentRoot:path.join(profile,'attachments'),projectsRoot:path.join(profile,'projects')});await app.started;
const browser=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.CHROMIUM_PATH,viewport:{width:1440,height:920}});
const page=browser.pages()[0],errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(app.url);await page.waitForTimeout(500);
 for(const width of [1440,390])for(const theme of ['dark','light']){
  await page.setViewportSize({width,height:844});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  await page.evaluate(async()=>{const {confirmApp}=await import('/app-confirm-dialog.js');window.dialogResult=null;confirmApp(document,'这次操作仅影响所选的测试项目。\n取消会保留当前内容，不会自动执行。',{titleText:'确认操作',acceptText:'继续'}).then(v=>window.dialogResult=v);});
  const dialog=page.locator('dialog.lan-confirm-dialog');await dialog.waitFor();
  const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1);
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'取消');
  assert.equal(await dialog.evaluate(n=>n.scrollWidth<=n.clientWidth),true);
  await page.screenshot({path:path.join(out,`${width}-${theme}.png`)});
  await page.keyboard.press('Escape');await page.waitForFunction(()=>window.dialogResult===false);
  checks.push({width,theme,contained:true,cancelDefault:true,escapeDeclines:true});
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify(checks));
}finally{await writeFile(path.join(out,'checks.json'),JSON.stringify({checks,errors},null,2));await browser.close();await app.close();}process.exit(0);
