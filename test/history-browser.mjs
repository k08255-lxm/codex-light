// Headless, synthetic histories only. No real account or model requests.
import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {createServer} from '../src/server.mjs';import {DemoClient} from '../src/demo.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');const root=fileURLToPath(new URL('..',import.meta.url));const out=path.join(root,'.tmp','history-browser');await mkdir(out,{recursive:true});const profile=await mkdtemp(path.join(out,'profile-'));const client=new DemoClient();
for(let n=0;n<80;n++){const id='th'+n;client.threads.set(id,{id,name:n===0?'History fixture':'Thread '+n,cwd:root,updatedAt:1000-n});client.items.set(id,[]);client.turns.set(id,[]);}
for(let i=0;i<120;i++){const id='t'+i;const items=[{id:'u'+i,type:'userMessage',content:[{type:'text',text:'Question '+i}]},{id:'c'+i,type:'agentMessage',phase:'commentary',text:'Inspecting '+i},{id:'x'+i,type:'commandExecution',command:'echo fixture',aggregatedOutput:'ok',status:'completed',exitCode:0},{id:'a'+i,type:'agentMessage',phase:'final_answer',text:'Final answer '+i+'\n\n'+'A readable paragraph. '.repeat(12)}];client.turns.get('th0').push({id,status:'completed',durationMs:34000,items});client.items.get('th0').push(...items.map(item=>({turnId:id,item})));}
const calls=[];const call=client.call.bind(client);client.call=async(m,p)=>{calls.push({m,p});return call(m,p)};
const app=await createServer({client,demo:true,cwd:root,fileAttachmentRoot:path.join(profile,'attachments'),projectsRoot:path.join(profile,'projects'),desktopStateRoot:path.join(profile,'desktop')});await app.started;
const browser=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:1440,height:920},executablePath:process.env.CHROMIUM_PATH,args:['--no-first-run','--no-default-browser-check']});const page=browser.pages()[0];const errors=[];page.on('pageerror',e=>errors.push(e.message));const checks=[];
try{for(const width of [1440,390]){
 await page.setViewportSize({width,height:844});await page.goto(app.url);await page.waitForTimeout(1200); await page.screenshot({path:path.join(out,'initial-'+width+'.png')});
 if(width===390)await page.locator('#rail-sidebar').click();
 await page.locator('button.project-group-thread').filter({hasText:'History fixture'}).click();await page.locator('[data-item-id="a119"]').waitFor();
 assert.equal(await page.locator('#review-thread,#review-view').count(),0);
 const work=page.locator('.turn-work').last();assert.equal(await work.getAttribute('open'),null);assert.equal(await work.locator('.turn-work-label').textContent(),'用时 34s');
 const final=page.locator('[data-item-id="a119"]');assert.ok((await work.boundingBox()).y<(await final.boundingBox()).y);
 await work.locator('summary').first().click();assert.equal(await work.locator('[data-item-id="c119"]').isVisible(),true);await work.locator('summary').first().click();assert.equal(await work.locator('[data-item-id="c119"]').isVisible(),false);
 const before=calls.filter(x=>x.m==='thread/items/list').length;
 await page.locator('#conversation').evaluate(n=>{n.scrollTop=100;});await page.waitForFunction(()=>document.querySelector('#earlier').disabled===false&&document.querySelector('[data-item-id="u30"]'));
 assert.ok(calls.filter(x=>x.m==='thread/items/list').length>before);assert.ok(await page.locator('#conversation').evaluate(n=>n.scrollTop>100));
 // The loading status itself enters/leaves the scroll flow. At the hard top the
 // browser does not preserve its anchor automatically. Check the actual message,
 // not merely scrollTop > 0 (which missed the old 34px jump).
 for (let round=0;round<2;round++) {
  const anchor=await page.locator('#conversation').evaluate(c=>{
   c.scrollTop=0;const node=[...c.querySelectorAll('[data-item-id]')].find(n=>n.getBoundingClientRect().height>0);
   return {id:node.dataset.itemId,offset:node.getBoundingClientRect().top-c.getBoundingClientRect().top};
  });
  await page.locator('#conversation').evaluate(c=>c.dispatchEvent(new WheelEvent('wheel',{deltaY:-40})));
  await page.waitForFunction(()=>!document.querySelector('#earlier').disabled);await page.waitForTimeout(100);
  const offset=await page.locator('#conversation').evaluate((c,id)=>c.querySelector('[data-item-id="'+id+'"]')?.getBoundingClientRect().top-c.getBoundingClientRect().top,anchor.id);
  assert.ok(Math.abs(offset-anchor.offset)<2, 'history feedback moved the reading anchor by '+(offset-anchor.offset)+'px');
 }
 await page.screenshot({path:path.join(out,'chat-'+width+'.png')});
 // sidebar auto paging while at the lower edge, without pressing its old button.
 if(width===390)await page.locator('#rail-sidebar').click();const count=calls.filter(x=>x.m==='thread/list').length;
 await page.locator('#thread-scroll').evaluate(n=>n.dispatchEvent(new WheelEvent('wheel',{deltaY:80})));
 await page.waitForTimeout(200);assert.ok(calls.filter(x=>x.m==='thread/list').length>count);
 await page.screenshot({path:path.join(out,width+'.png')});checks.push(width+'px: folded work/timing before answer, auto older history with retained position, automatic thread list paging');
}assert.deepEqual(errors,[]);console.log(checks.join('\n'));}finally{await writeFile(path.join(out,'checks.json'),JSON.stringify({checks,errors},null,2));await browser.close();await app.close?.();client.close();}process.exit(0);
