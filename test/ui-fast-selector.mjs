// Explicit Playwright test against the local demo. No external model calls.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DemoClient} from '../src/demo.mjs';
import {createServer} from '../src/server.mjs';

const {chromium}=createRequire(import.meta.url)('playwright');
test('Fast in the model selector follows projects, threads, capabilities and keyboard changes',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codecang-fast-ui-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const client=new DemoClient(),call=client.call.bind(client);
 client.call=async(method,params)=>{
  const result=await call(method,params);
  if(method==='model/list')for(const row of result.data)row.serviceTiers=row.model==='demo'?[{id:'priority'}]:[];
  return result;
 };
 const app=await createServer({demo:true,client,projectsRoot:path.join(root,'metadata')});
 t.after(()=>app.close());
 await app.started;
 for(const project of ['Standard','Fast']){
  const directory=path.join(root,project);
  await mkdir(directory);
  await app.projectStore.add(directory,false);
 }
 const {thread}=await call('thread/start',{cwd:path.join(root,'Standard'),model:'demo'});
 thread.name='Previous standard conversation';
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
 t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1360,height:850}});
 const errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.setDefaultTimeout(6000);
 await page.route('**/api/status',async route=>{
  const response=await route.fetch();
  await route.fulfill({response,json:{...await response.json(),demo:false}});
 });
 await page.route('**/api/session/defaults',route=>route.fulfill({json:{model:'demo',reasoningEffort:'high',serviceTier:route.request().postDataJSON()?.cwd===path.join(root,'Fast')?'fast':'default'}}));
 await page.goto(app.url);
 await page.waitForFunction(()=>document.querySelector('#model option[value="demo-six"]'));
 const trigger=page.locator('#model-trigger'), badge=page.locator('#model-trigger-fast'), toggle=page.getByRole('switch',{name:'Fast 模式'});
 async function project(name){
  await page.locator('#cwd-button').click();
  await page.locator('#project-choices').getByRole('button',{name,exact:true}).click();
  await page.locator('#cwd-label').getByText(name,{exact:true}).waitFor();
 }
 async function visible(enabled){
  await badge.waitFor({state:enabled?'visible':'hidden'});
  assert.equal((await trigger.getAttribute('aria-label')).includes('Fast 模式已开启'),enabled);
  assert.equal((await trigger.getAttribute('title')).includes('Fast 模式已开启'),enabled);
 }
 async function screenshot(name,locator){
  if(!process.env.FAST_UI_SCREENSHOT_DIR)return;
  await mkdir(process.env.FAST_UI_SCREENSHOT_DIR,{recursive:true});
  await locator.screenshot({path:path.join(process.env.FAST_UI_SCREENSHOT_DIR,name+'.png')});
 }
 await project('Standard');await visible(false);
 await project('Fast');await visible(true);
 await trigger.click();assert.equal(await toggle.isChecked(),true);
 await toggle.focus();await toggle.press('Space');assert.equal(await toggle.isChecked(),false);
 await toggle.press('Escape');await visible(false);
 assert.equal(await trigger.evaluate(n=>n===document.activeElement),true);
 await trigger.click();await toggle.check();await screenshot('open',page.locator('#reasoning-popover'));
 await page.locator('#model-list-open').click();
 await page.getByRole('button',{name:'演示六档模型（不调用 AI）'}).click();
 assert.equal(await toggle.isDisabled(),true);
 await page.keyboard.press('Escape');await visible(false);
 await trigger.click();await page.locator('#model-list-open').click();
 await page.getByRole('button',{name:'演示模型（不调用 AI）',exact:true}).click();
 await page.keyboard.press('Escape');await visible(true);
 await page.getByRole('button',{name:thread.name,exact:true}).click();
 await page.locator('#thread-title').filter({hasText:thread.name}).waitFor();await visible(false);
 await trigger.click();await toggle.check();await page.keyboard.press('Escape');await visible(true);
 await page.locator('#new-thread').click();
 await project('Standard');await visible(true); // The draft still has its own explicit choice.
 await trigger.click();await toggle.uncheck();await page.keyboard.press('Escape');await visible(false);
 await page.getByRole('button',{name:thread.name,exact:true}).click();
 await page.locator('#thread-title').filter({hasText:thread.name}).waitFor();await visible(true);
 await page.setViewportSize({width:360,height:800});
 await badge.waitFor({state:'visible'});
 const containsBadge=await trigger.evaluate(node=>{
  const box=node.getBoundingClientRect(),badge=node.querySelector('#model-trigger-fast').getBoundingClientRect();
  return box.left>=0&&box.right<=window.innerWidth&&badge.width>0&&badge.left>=box.left&&badge.right<=box.right;
 });
 assert.ok(containsBadge);
 await screenshot('closed-narrow',trigger);
 await trigger.click();
 const bounds=await page.locator('#reasoning-popover').boundingBox();
 assert.ok(bounds.x>=0&&bounds.x+bounds.width<=360);
 await screenshot('open-narrow',page.locator('#reasoning-popover'));
 assert.deepEqual(errors,[]);
});
