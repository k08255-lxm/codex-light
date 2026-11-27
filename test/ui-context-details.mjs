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
const turns=[1,2,3].map(index=>({id:'turn-'+index,status:'completed',items:[{id:'user-'+index,type:'userMessage',content:[{type:'text',text:'测试消息 '+index}]},{id:'reply-'+index,type:'agentMessage',text:'测试回答 '+index}]}));
client.turns.set(known.id,turns);client.items.set(known.id,turns.flatMap(turn=>turn.items.map(item=>({turnId:turn.id,item}))));
known.path=path.join(dir,`rollout-${known.id}.jsonl`);
await writeFile(known.path,[
 {type:'session_meta',payload:{id:known.id}},
 {type:'event_msg',payload:{type:'task_complete',turn_id:'older',time_to_first_token_ms:1250,duration_ms:3000}},
 {type:'event_msg',payload:{type:'token_count',info:{model_context_window:1000,
  last_token_usage:{input_tokens:230,cached_input_tokens:80,cache_write_input_tokens:0,output_tokens:20,reasoning_output_tokens:5,total_tokens:250},
  total_token_usage:{input_tokens:7900,cached_input_tokens:2000,output_tokens:100,reasoning_output_tokens:40,total_tokens:8000},
 }}},
 {type:'response_item',payload:{text:'PRIVATE_ROLLOUT_CONTENT'}},
].map(JSON.stringify).join('\n')+'\n');
const app=await createServer({client,cwd:root,demo:true,desktop:true,desktopStateRoot:path.join(dir,'desktop'),projectsRoot:path.join(dir,'projects'),statisticsRoot:path.join(dir,'statistics'),
 contextHistoryReader:options=>readInlineHistoryContext({...options,roots:[dir]})});
await app.started;
const headers={Authorization:'Bearer '+app.token,'Content-Type':'application/json'};
const preferences=await (await fetch(app.origin+'/api/desktop/preferences',{headers})).json();
assert.equal((await fetch(app.origin+'/api/desktop/preferences',{method:'POST',headers,body:JSON.stringify({preferences:preferences.preferences})})).status,200);
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const pages=[];
 for(const width of [1320,407]){
  const mobile=width===407,height=mobile?886:820;
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:mobile?2656/886:1,isMobile:mobile,hasTouch:mobile,reducedMotion:'reduce'});
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
  const rail=page.locator('#turn-timeline');
  await rail.waitFor({state:mobile?'hidden':'visible'});
  assert.equal(await rail.locator('button').count(),mobile?0:3);
  await meter.focus();await page.keyboard.press('Enter');await dialog.waitFor();
  await page.locator('#context-details-status').filter({hasText:'历史用量记录'}).waitFor();
  assert.equal(await dialog.locator('#context-window-metrics [data-metric="remaining"]').textContent(),'750');
  assert.equal(await dialog.locator('[data-scope="last"][data-metric="cacheWriteInputTokens"]').textContent(),'0');
  assert.equal(await dialog.locator('[data-scope="total"][data-metric="cacheWriteInputTokens"]').textContent(),'未知');
  assert.equal(await dialog.locator('[data-scope="total"][data-metric="totalTokens"]').textContent(),'8,000');
  assert.doesNotMatch(await dialog.textContent(),/PRIVATE_ROLLOUT_CONTENT/);
  assert.equal(await page.locator('#context-details-close').evaluate(el=>el===document.activeElement),true);
  const rect=await dialog.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=width&&rect.y>=0&&rect.y+rect.height<=height&&rect.height<=height*.56);
  const png=await page.screenshot({path:path.join(output,`history-${width}.png`)});
  if(mobile)assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[1220,2656]);
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.id==='context-meter');
  await meter.click();await dialog.getByRole('button',{name:'关闭上下文详情'}).click();
  await dialog.waitFor({state:'hidden'});
  await page.locator('#session-speed').click();
  await page.locator('#speed-ttft').filter({hasText:'1.3 秒'}).waitFor();
  assert.doesNotMatch(await page.locator('#speed-details').innerText(), /\d+\s*[轮步]/);
  await page.locator('#thread-title').click();await page.locator('#speed-details').waitFor({state:'hidden'});
  await openThread(unknown.name);await meter.click();await dialog.waitFor();
  assert.equal(await dialog.locator('[data-scope="last"][data-metric="totalTokens"]').textContent(),'未知');
  await page.keyboard.press('Escape');await openThread(known.name);await meter.filter({hasText:'25%'}).waitFor();await meter.click();
  pages.push({page,meter,dialog});
 }
 client.emit('event',{method:'thread/tokenUsage/updated',params:{threadId:known.id,tokenUsage:{modelContextWindow:1000,last:{totalTokens:500,inputTokens:475},total:{totalTokens:9999}}}});
 for(const {meter,dialog} of pages){
  await meter.filter({hasText:'50%'}).waitFor();
  await dialog.locator('#context-details-status').filter({hasText:'最近一次用量更新'}).waitFor();
  assert.equal(await dialog.locator('[data-scope="last"][data-metric="cachedInputTokens"]').textContent(),'未知');
 }
 client.connected=false;client.emit('event',{method:'bridge/status',params:{connected:false}});
 for(const {meter,dialog} of pages){
  await meter.filter({hasText:'—'}).waitFor();await dialog.waitFor({state:'hidden'});
 }
 client.connected=true;client.emit('event',{method:'bridge/status',params:{connected:true}});
 for(const {meter} of pages)await meter.filter({hasText:'25%'}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('Desktop and 1220×2656 simulated phone: anchored context and speed, historical TTFT, focus, outside dismissal, live updates and reconnection passed.');
}finally{await browser?.close();await app.close();await rm(dir,{recursive:true,force:true});}
