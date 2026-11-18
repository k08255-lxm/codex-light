// Real Chromium exercises both composer layouts with a scoped synthetic rollout.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {readInlineHistoryContext} from '../src/inline-history.mjs';
import {DemoClient} from '../src/demo.mjs';

const {chromium}=createRequire(import.meta.url)('playwright');
const root=process.cwd(),output=path.join(root,'.tmp','context-details');
await mkdir(output,{recursive:true});
const dir=await mkdtemp(path.join(output,'run-')),client=new DemoClient(),errors=[];
const known=(await client.call('thread/start',{cwd:root})).thread,unknown=(await client.call('thread/start',{cwd:root})).thread;
known.name='上下文已有记录';unknown.name='上下文暂无记录';
known.path=path.join(dir,`rollout-${known.id}.jsonl`);
await writeFile(known.path,[
 {type:'session_meta',payload:{id:known.id}},
 {type:'event_msg',payload:{type:'token_count',info:{model_context_window:1000,
  last_token_usage:{input_tokens:230,cached_input_tokens:80,cache_write_input_tokens:0,output_tokens:20,reasoning_output_tokens:5,total_tokens:250},
  total_token_usage:{input_tokens:7900,cached_input_tokens:2000,output_tokens:100,reasoning_output_tokens:40,total_tokens:8000},
 }}},
 {type:'response_item',payload:{text:'PRIVATE_ROLLOUT_CONTENT'}},
].map(JSON.stringify).join('\n')+'\n');
const app=await createServer({client,cwd:root,demo:true,desktop:true,desktopStateRoot:path.join(dir,'desktop'),projectsRoot:path.join(dir,'projects'),
 contextHistoryReader:options=>readInlineHistoryContext({...options,roots:[dir]})});
await app.started;
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const pages=[];
 for(const width of [1320,393]){
  const page=await browser.newPage({viewport:{width,height:820},isMobile:width<760,hasTouch:width<760,reducedMotion:'reduce'});
  page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
  const openThread=async name=>{
   const sidebar=page.locator('#rail-sidebar');
   if(await sidebar.getAttribute('aria-expanded')!=='true')await sidebar.click();
   await page.locator('.project-group-thread').filter({hasText:name}).click();
   await page.locator('#thread-title').filter({hasText:name}).waitFor();
  };
  await page.goto(app.url);await openThread(known.name);
  const meter=page.locator('#context-meter'),dialog=page.getByRole('dialog',{name:'上下文用量'});
  await meter.filter({hasText:'25%'}).waitFor();
  await meter.focus();await page.keyboard.press('Enter');await dialog.waitFor();
  await page.locator('#context-details-status').filter({hasText:'历史用量记录'}).waitFor();
  assert.equal(await dialog.locator('#context-window-metrics [data-metric="remaining"]').textContent(),'750');
  assert.equal(await dialog.locator('#context-last-metrics [data-metric="cacheWriteInputTokens"]').textContent(),'0');
  assert.equal(await dialog.locator('#context-total-metrics [data-metric="cacheWriteInputTokens"]').textContent(),'未知');
  assert.equal(await dialog.locator('#context-total-metrics [data-metric="totalTokens"]').textContent(),'8,000');
  assert.doesNotMatch(await dialog.textContent(),/PRIVATE_ROLLOUT_CONTENT/);
  assert.equal(await page.locator('#context-details-close').evaluate(el=>el===document.activeElement),true);
  const rect=await dialog.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=width&&rect.y>=0&&rect.y+rect.height<=820);
  await page.screenshot({path:path.join(output,`history-${width}.png`)});
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.id==='context-meter');
  await meter.click();await dialog.getByRole('button',{name:'关闭上下文详情'}).click();
  await dialog.waitFor({state:'hidden'});
  await openThread(unknown.name);await meter.click();await dialog.waitFor();
  assert.equal(await dialog.locator('#context-last-metrics [data-metric="totalTokens"]').textContent(),'未知');
  await page.keyboard.press('Escape');await openThread(known.name);await meter.filter({hasText:'25%'}).waitFor();await meter.click();
  pages.push({page,meter,dialog});
 }
 client.emit('event',{method:'thread/tokenUsage/updated',params:{threadId:known.id,tokenUsage:{modelContextWindow:1000,last:{totalTokens:500,inputTokens:475},total:{totalTokens:9999}}}});
 for(const {meter,dialog} of pages){
  await meter.filter({hasText:'50%'}).waitFor();
  await dialog.locator('#context-details-status').filter({hasText:'最近一次用量更新'}).waitFor();
  assert.equal(await dialog.locator('#context-last-metrics [data-metric="cachedInputTokens"]').textContent(),'未知');
 }
 client.connected=false;client.emit('event',{method:'bridge/status',params:{connected:false}});
 for(const {meter,dialog} of pages){
  await meter.filter({hasText:'—'}).waitFor();await dialog.waitFor({state:'hidden'});
 }
 client.connected=true;client.emit('event',{method:'bridge/status',params:{connected:true}});
 for(const {meter} of pages)await meter.filter({hasText:'25%'}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('Context detail: desktop and 393px history, keyboard/focus, isolation, live updates and engine reconnection passed.');
}finally{await browser?.close();await app.close();await rm(dir,{recursive:true,force:true});}
