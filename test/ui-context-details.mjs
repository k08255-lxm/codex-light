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
if(process.platform==='win32')known.path=path.toNamespacedPath(known.path);
await writeFile(known.path,[
 {type:'session_meta',payload:{id:known.id,model_provider:'local'}},
 {type:'turn_context',payload:{model:'usage-fixture',turn_id:'older'}},
 {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:0,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:0}}}},
 {type:'event_msg',payload:{type:'task_complete',turn_id:'older',time_to_first_token_ms:1250,duration_ms:3000}},
 {type:'event_msg',payload:{type:'token_count',info:{model_context_window:1000,
  last_token_usage:{input_tokens:230,cached_input_tokens:80,cache_write_input_tokens:0,output_tokens:20,reasoning_output_tokens:5,total_tokens:250},
  total_token_usage:{input_tokens:7900,cached_input_tokens:2000,output_tokens:100,reasoning_output_tokens:40,total_tokens:8000},
 }}},
 {type:'response_item',payload:{text:'PRIVATE_ROLLOUT_CONTENT'}},
].map(JSON.stringify).join('\n')+'\n');
let costHistoryReads=0;
const app=await createServer({client,cwd:root,demo:true,desktop:true,desktopStateRoot:path.join(dir,'desktop'),projectsRoot:path.join(dir,'projects'),statisticsRoot:path.join(dir,'statistics'),
 contextHistoryReader:options=>{if(options.includeCost)costHistoryReads++;return readInlineHistoryContext({...options,roots:[dir]});}});
await app.started;
const headers={Authorization:'Bearer '+app.token,'Content-Type':'application/json'};
assert.equal((await fetch(app.origin+'/api/pricing/configure',{method:'POST',headers,body:JSON.stringify({mode:'manual',provider:'local',model:'usage-fixture',input:2,cacheRead:1,cacheWrite:2,output:4})})).status,200);
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
  assert.equal(await dialog.locator('[data-scope="total"][data-metric="totalTokens"]').textContent(),'8k');
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
  const usage=page.locator('#session-usage-details');
  await page.locator('#session-cost-label').filter({hasText:'≈$0.0142'}).waitFor();
  assert.equal(await usage.isVisible(),false);
  const geometry=await page.locator('.composer-foot').evaluate(foot=>{
   const rect=id=>document.getElementById(id).getBoundingClientRect();
   return {right:foot.getBoundingClientRect().right,speed:rect('session-speed').right,
    hit:rect('session-hit-label').right,cost:rect('session-cost-label').left,overflows:foot.scrollWidth>foot.clientWidth};
  });
  assert.ok(!geometry.overflows&&Math.abs(geometry.right-geometry.speed)<2&&geometry.hit<=geometry.cost,JSON.stringify(geometry));
  await page.locator('.composer-dock').screenshot({path:path.join(output,`footer-${width}.png`)});
  await page.locator('#session-usage').click();await usage.waitFor();
  assert.equal(await usage.locator('#session-token-total').textContent(),'8k tok');
  assert.equal(await usage.locator('#session-token-total').getAttribute('title'),'8,000 tokens');
  assert.equal(await usage.locator('#session-cache-hit').textContent(),'25.3%');
  assert.equal(await page.locator('#session-hit-label').textContent(),'· 缓存命中 25.3%');
  assert.equal(await usage.locator('#session-input').textContent(),'5.9k tok');
  assert.equal(await usage.locator('#session-output').textContent(),'100 tok');
  await usage.locator('#session-cost').filter({hasText:'$0.0142'}).waitFor();
  assert.equal(await usage.locator('#session-cost').textContent(),'$0.0142');
  const bounds=await usage.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width&&bounds.y>=0&&bounds.y+bounds.height<=height);
  const usageShot=await page.screenshot({path:path.join(output,`usage-${width}.png`)});
  if(mobile)assert.deepEqual([usageShot.readUInt32BE(16),usageShot.readUInt32BE(20)],[1220,2656]);
  await page.keyboard.press('Escape');await usage.waitFor({state:'hidden'});
  await openThread(unknown.name);await meter.click();await dialog.waitFor();
  assert.equal(await dialog.locator('[data-scope="last"][data-metric="totalTokens"]').textContent(),'未知');
  assert.equal(await page.locator('#session-token-label').textContent(),'Token 用量');
  assert.equal(await page.locator('#session-cost-label').textContent(),'· 费用 —');
  await page.keyboard.press('Escape');await openThread(known.name);await meter.filter({hasText:'25%'}).waitFor();await meter.click();
  pages.push({page,meter,dialog});
 }
 client.emit('event',{method:'thread/tokenUsage/updated',params:{threadId:known.id,tokenUsage:{modelContextWindow:1000,last:{totalTokens:500,inputTokens:475},total:{totalTokens:9999}}}});
 for(const {page,meter,dialog} of pages){
  await meter.filter({hasText:'50%'}).waitFor();
  await dialog.locator('#context-details-status').filter({hasText:'最近一次用量更新'}).waitFor();
  await page.locator('#session-cost-label').filter({hasText:'已知部分'}).waitFor();
  assert.equal(await dialog.locator('[data-scope="last"][data-metric="cachedInputTokens"]').textContent(),'未知');
 }
 client.connected=false;client.emit('event',{method:'bridge/status',params:{connected:false}});
 for(const {meter,dialog} of pages){
  await meter.filter({hasText:'—'}).waitFor();await dialog.waitFor({state:'hidden'});
 }
 client.connected=true;client.emit('event',{method:'bridge/status',params:{connected:true}});
 for(const {meter} of pages)await meter.filter({hasText:'25%'}).waitFor();
 const statsId='calendar-fixture';
 const account={type:'chatgpt',email:'sample@example.test',planType:'plus'};
 const originalCall=client.call.bind(client);
 const nextReset=Math.floor(Date.now()/1000)+3600;
 client.call=(method,params)=>{
  if(method==='account/read')return Promise.resolve({account,requiresOpenaiAuth:true});
  if(method==='account/rateLimits/read')return Promise.resolve({rateLimits:{limitId:'codex',planType:'plus',primary:{usedPercent:25,windowDurationMins:300,resetsAt:nextReset},secondary:{usedPercent:50,windowDurationMins:10080,resetsAt:nextReset}}});
  return originalCall(method,params);
 };
 app.statistics.setAccount(account);
 app.statistics.acknowledge('thread/start',{}, {thread:{id:statsId,model:'usage-fixture',modelProvider:'local'}});
 app.statistics.observe({method:'turn/started',params:{threadId:statsId,turn:{id:'one',status:'inProgress'}}});
 const total={inputTokens:3200000,cachedInputTokens:3000000,cacheWriteInputTokens:0,outputTokens:13418,reasoningOutputTokens:0,totalTokens:3213418};
 app.statistics.observe({method:'thread/tokenUsage/updated',params:{threadId:statsId,turnId:'one',tokenUsage:{last:total,total}}});
 for(const {page} of pages){
  await page.locator('#rail-usage').click();
  const balance=page.locator('.balance-window').first();
  await page.getByRole('heading',{name:'预估订阅总额'}).waitFor();
  await balance.locator('strong').filter({hasText:'$13.81'}).waitFor();
  assert.match(await balance.textContent(),/5 小时窗口.*已用 25%/);
  const kpi=page.locator('.kpi').filter({has:page.locator('.kpi-label',{hasText:'Tokens'})});
  await kpi.locator('.kpi-value').filter({hasText:'3.2M'}).waitFor();
  assert.match(await kpi.getAttribute('title'),/3,213,418/);
  assert.match(await kpi.locator('.kpi-sub').textContent(),/13\.4k/);
  const bar=page.locator('.bar-chart .bar').first(), hit=page.locator('.bar-chart .hit').first();
  await hit.focus();await page.locator('.chart-readout').waitFor();
  const tip=await page.locator('.chart-readout').boundingBox(),column=await bar.boundingBox();
  assert.ok(Math.abs(tip.x+tip.width/2-column.x-column.width/2)<2 && tip.y+tip.height<=column.y);
  const cost=page.locator('.cost-trigger').first(),details=page.getByRole('dialog',{name:'费用明细'});
  const rowHeight=()=>cost.evaluate(n=>n.closest('tr').getBoundingClientRect().height);
  const before=await rowHeight();
  await cost.click();await details.locator('.cost-parts').waitFor();
  assert.equal(await rowHeight(),before);
  const costBox=await details.boundingBox();
  assert.ok(costBox.width<=312 && costBox.height<page.viewportSize().height/2);
  await page.screenshot({path:path.join(output,`cost-${page.viewportSize().width}.png`)});
  await page.keyboard.press('Escape');await details.waitFor({state:'hidden'});
  assert.equal(await cost.evaluate(n=>document.activeElement===n),true);
  await page.locator('.stats-overview').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,`balance-${page.viewportSize().width}.png`)});
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.waitForFunction(()=>document.documentElement.dataset.reducedMotion==='false');
  const trigger=page.locator('[aria-controls="usage-range-panel"]'),picker=page.getByRole('dialog',{name:'统计时间范围'});
  await trigger.scrollIntoViewIfNeeded();
  for(const opening of [true,false]){
   const samples=await trigger.evaluate(async button=>{
    const panel=document.getElementById(button.getAttribute('aria-controls')),values=[];
    button.click();
    const start=performance.now();
    do{await new Promise(requestAnimationFrame);values.push(Number(getComputedStyle(panel).opacity));}while(performance.now()-start<240);
    return values;
   });
   assert.ok(samples.some(value=>value>0&&value<1),'actual opacity frames during '+(opening?'entry':'exit')+': '+samples);
   assert.equal(samples.at(-1),opening?1:0);
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await trigger.click();await picker.waitFor();
  assert.equal(parseFloat(await picker.evaluate(n=>getComputedStyle(n).transitionDuration)),0);
  const request=page.waitForRequest(r=>r.url().endsWith('/api/statistics/query')&&r.postDataJSON()?.from===new Date((nextReset-300*60)*1000).toISOString());
  await picker.getByRole('button',{name:'上次重置以来',exact:true}).click();
  assert.equal((await request).postDataJSON().bucket,'hour');
  await trigger.filter({hasText:'上次重置以来'}).click();
  await picker.getByRole('button',{name:'近 14 天',exact:true}).click();await picker.waitFor({state:'hidden'});
  await trigger.filter({hasText:'近 14 天'}).click();
  assert.equal(await picker.locator('.usage-calendar-day').count(),42);
  const calendarMonth=await picker.locator('.usage-calendar-nav button').nth(1).textContent();
  await picker.getByRole('button',{name:'上个月'}).click();
  assert.notEqual(await picker.locator('.usage-calendar-nav button').nth(1).textContent(),calendarMonth);
  await picker.locator('.usage-calendar-day:not(.outside)').first().click();
  await picker.getByRole('checkbox').check();
  assert.equal(await picker.getByLabel('结束时间日期').isDisabled(),true);
  const box=await picker.boundingBox(),size=page.viewportSize();
  const bounds=await page.locator('.stats .page-head').boundingBox();
  assert.ok(box.x>=Math.max(16,bounds.x)-1&&box.y>=15&&box.x+box.width<=Math.min(size.width-16,bounds.x+bounds.width)+1&&box.y+box.height<=size.height-15,JSON.stringify({box,size,bounds}));
  await page.screenshot({path:path.join(output,`stats-range-${size.width}.png`)});
  await picker.getByRole('button',{name:'确定'}).click();await trigger.filter({hasText:'现在'}).waitFor();
  await trigger.click();await picker.getByRole('button',{name:'全部',exact:true}).click();
  await trigger.click();await page.keyboard.press('Escape');await picker.waitFor({state:'hidden'});
 }
 for(const {page} of pages){
  await page.locator('#rail-home').click();
  await page.locator('#session-cost-label').filter({hasText:'$0.0142'}).waitFor();
  assert.equal(await page.locator('#session-usage-details').isVisible(),false);
 }
 const readsBeforeLive=costHistoryReads;
 app.statistics.thread({id:known.id,model:'usage-fixture',modelProvider:'local'});
 app.statistics.observe({method:'turn/started',params:{threadId:known.id,turn:{id:'live-meter',status:'inProgress'}}});
 let lastAmount=0.0142;
 const last={inputTokens:1000,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:20,reasoningOutputTokens:0,totalTokens:1020};
 for(let i=1;i<=2;i++){
  const total={...last,inputTokens:7900+1000*i,cachedInputTokens:2000,outputTokens:100+20*i,reasoningOutputTokens:40,totalTokens:8000+1020*i};
  client.emit('event',{method:'thread/tokenUsage/updated',params:{threadId:known.id,turnId:'live-meter',tokenUsage:{last,total}}});
  for(const {page} of pages)await page.waitForFunction(previous=>Number(document.querySelector('#session-cost-label').textContent.split('$').at(-1))>previous,lastAmount);
  lastAmount=Number((await pages[0].page.locator('#session-cost-label').textContent()).split('$').at(-1));
 }
 assert.equal(costHistoryReads,readsBeforeLive,'new receipts extend cached historical cost with the popover closed');
 assert.deepEqual(errors,[]);
 console.log('Desktop and 1220×2656 simulated phone: anchored context and speed, historical TTFT, focus, outside dismissal, live updates and reconnection passed.');
}finally{await browser?.close();await app.close();await rm(dir,{recursive:true,force:true});}
