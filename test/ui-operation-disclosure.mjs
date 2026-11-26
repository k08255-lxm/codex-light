// Isolated Chrome history with native summary activation and a streaming DemoClient turn.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';

const {chromium} = createRequire(import.meta.url)('playwright');
const root = await mkdtemp(path.join(os.tmpdir(),'codecang-disclosures-'));
const client = new DemoClient(), {thread} = await client.call('thread/start',{cwd:root});
thread.name = '操作记录与滚动回归';
for (let index=0;index<14;index++) {
  const items = [
    {id:'question-'+index,type:'userMessage',content:[{type:'text',text:'轮次 '+index}]},
    ...Array.from({length:index===8?34:7},(_,step)=>({id:'cmd-'+index+'-'+step,type:'commandExecution',command:'echo command '+step,aggregatedOutput:'sample line\n'.repeat(18),status:'completed'})),
    {id:'answer-'+index,type:'agentMessage',text:('段落 '+index+' 显示正在阅读的历史记录。\n\n').repeat(5)},
  ];
  const turn = {id:'turn-'+index,status:index===13?'inProgress':'completed',items};
  client.turns.get(thread.id).push(turn);
  client.items.get(thread.id).push(...items.map(item=>({turnId:turn.id,item})));
}
const {thread:longThread}=await client.call('thread/start',{cwd:root});
longThread.name='分段阅读定位';
const longText=Array.from({length:1800},(_,i)=>'第 '+i+' 段。用于验证正文和命令输出翻页后可以从开头阅读。').join('\n\n');
const longTurn={id:'segmented-turn',status:'completed',items:[
  {id:'segmented-command',type:'commandExecution',command:'echo fixture',aggregatedOutput:longText,status:'completed'},
  {id:'segmented-answer',type:'agentMessage',text:longText,phase:'final_answer'}
]};
client.turns.get(longThread.id).push(longTurn);
client.items.get(longThread.id).push(...longTurn.items.map(item=>({turnId:longTurn.id,item})));
const app=await createServer({demo:true,client,cwd:root,projectsRoot:path.join(root,'projects')});
let browser;
try {
  await app.started;
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
  const page=await browser.newPage({viewport:{width:1260,height:820},reducedMotion:'no-preference'});
  page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(app.url);
  await page.getByRole('button',{name:'使用此主题'}).click();
  await page.locator('.project-group-thread').filter({hasText:thread.name}).click();
  const conversation=page.locator('#conversation'), gap=()=>conversation.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight);
  await page.waitForFunction(()=>{const c=document.querySelector('#conversation');return c.scrollTop>0&&c.scrollHeight-c.scrollTop-c.clientHeight<3;});
  const work=page.locator('[data-turn-id="turn-8"] details.turn-work'), summary=work.locator(':scope > summary');
  const box=await conversation.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  for(let i=0;i<12 && !(await work.count());i++){await page.mouse.wheel(0,-260);await page.waitForTimeout(70);}
  await work.waitFor({state:'attached'});
  const offset=locator=>locator.evaluate(el=>el.getBoundingClientRect().top-el.closest('#conversation').getBoundingClientRect().top);
  await page.mouse.wheel(0,await offset(summary)-95);await page.waitForTimeout(260);
  const base=await offset(summary);assert.ok(base>=30 && base<180,'older turn visible in the middle of history: '+base);
  assert.ok(await gap()>700);
  function stream() {
    const delta='\n\n正在更新的最后一轮。';
    client.turns.get(thread.id).at(-1).items.at(-1).text+=delta;
    client.emit('event',{method:'item/agentMessage/delta',params:{threadId:thread.id,turnId:'turn-13',itemId:'answer-13',delta}});
  }
  // Sample accessibly triggered transitions in the browser's own animation frames.
  async function measure(details,key,expectedOpen,animated) {
    await details.locator(':scope > summary').focus();
    await details.evaluate(node=>{
      window.disclosureSamples=[node.getBoundingClientRect().height];
      window.disclosureFrames=new Promise(resolve=>{
        const start=performance.now();
        function frame(){window.disclosureSamples.push(node.getBoundingClientRect().height);if(performance.now()-start>430)resolve();else requestAnimationFrame(frame);}
        requestAnimationFrame(frame);
      });
    });
    await page.keyboard.press(key);
    const samples=await page.evaluate(async()=>{await window.disclosureFrames;return window.disclosureSamples;});
    const from=samples[0],to=samples.at(-1);
    assert.equal(await details.evaluate(el=>el.open),expectedOpen);
    assert.ok(expectedOpen?to>from+8:to<from-8,'native state changes body height: '+from+' -> '+to);
    const between=samples.filter(h=>h>Math.min(from,to)+2 && h<Math.max(from,to)-2);
    assert.equal(Boolean(between.length),animated,'intermediate heights: '+JSON.stringify(samples));
  }
  await measure(work,'Enter',true,true);
  const group=work.locator('details.turn-process').first(), row=group.locator('.step').first();
  await measure(group,'Space',true,true);
  await measure(row,'Enter',true,true);stream();
  await measure(row,'Enter',false,true);
  await measure(group,'Space',false,true);
  await group.locator('summary').first().focus();
  await page.keyboard.press('Enter');await page.waitForTimeout(45);await page.keyboard.press('Enter');
  await page.waitForTimeout(220);assert.equal(await group.evaluate(node=>node.open),false);
  await measure(work,'Enter',false,true);
  assert.ok(Math.abs(await offset(summary)-base)<4,'same history header after closing');
  stream();await page.waitForTimeout(220);assert.ok(await gap()>700);
  await summary.click();await group.locator(':scope > summary').click();await page.waitForTimeout(250);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  const padding=await conversation.evaluate(node=>parseFloat(getComputedStyle(node).paddingTop));
  for(let i=0;i<6 && await offset(summary)>padding+2;i++){await page.mouse.wheel(0,140);await page.waitForTimeout(110);}
  const stickyTop=await offset(summary);
  assert.ok(Math.abs(stickyTop-padding)<3,'older round header sticks while reading its commands: '+stickyTop);
  await summary.click();stream();await page.waitForTimeout(320);
  assert.ok(Math.abs(await offset(summary)-stickyTop)<4,'closing the sticky header keeps the older round at the top');
  assert.ok(await gap()>700);
  // A partially exposed header becomes sticky at the scroller's padding edge. Its
  // painted position can stay fixed even as the start of the expanded work drifts away.
  await page.mouse.wheel(0,await offset(summary)-4);
  await page.waitForTimeout(200);
  const openingTop=await offset(work);
  assert.ok(openingTop>=0 && openingTop<padding-2,'closed header inside the sticky inset: '+openingTop);
  await summary.click({position:{x:18,y:22}});
  await page.waitForTimeout(600);
  assert.equal(await work.evaluate(node=>node.open),true);
  assert.ok(Math.abs(await offset(work)-openingTop)<4,'first expanded operation stays at its opening position: '+await offset(work));
  await summary.click();
  await page.waitForTimeout(220);
  await page.emulateMedia({reducedMotion:'reduce'});
  await measure(work,'Enter',true,false);
  assert.equal(await group.evaluate(node=>node.open),true);
  await measure(group,'Space',false,false);
  const footerCloseTop=await offset(summary);
  await work.locator('.turn-work-close').click();
  await page.waitForTimeout(220);
  assert.ok(Math.abs(await offset(summary)-footerCloseTop)<4,'footer close keeps this turn in view');
  await page.locator('#preference-motion').selectOption('off',{force:true});
  await measure(work,'Enter',true,true);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.locator('#preference-motion').selectOption('on',{force:true});
  await measure(work,'Enter',false,false);
  await page.locator('.scroll-to-bottom').click();await page.waitForTimeout(200);
  stream();await page.waitForTimeout(220);assert.ok(await gap()<3,'explicit bottom resumes stream following');
  await page.locator('.project-group-thread').filter({hasText:longThread.name}).click();
  const longAnswer=page.locator('[data-item-id="segmented-answer"] .long-text');
  await longAnswer.locator('.long-text-more').waitFor();
  await page.waitForFunction(()=>{const c=document.querySelector('#conversation');return c.ariaBusy==='false'&&c.scrollHeight-c.clientHeight-c.scrollTop<3;});
  async function checkSegment(view,button,expected) {
    await view.getByRole('button',{name:button,exact:true}).click();
    await page.waitForTimeout(250);
    const start=view.locator('[data-segment]').first();
    assert.equal(await start.getAttribute('data-segment'),String(expected));
    const {y,barBottom}=await start.evaluate(node=>{
      const viewport=node.closest('.step-command') || node.closest('#conversation');
      const top=viewport.getBoundingClientRect().top;
      const bar=node.closest('.long-text').querySelector('.long-text-bar');
      return {y:node.getBoundingClientRect().top-top,barBottom:bar.getBoundingClientRect().bottom-top};
    });
    assert.ok(y>=barBottom-1&&y<barBottom+24,button+' opens segment '+expected+' below its toolbar: '+y+' / '+barBottom);
  }
  await checkSegment(longAnswer,'继续阅读下一段',2);
  await checkSegment(longAnswer,'下一段',3);
  await checkSegment(longAnswer,'上一段',2);
  await checkSegment(longAnswer,'开头',1);
  await page.locator('.turn-work-summary').click();
  await page.locator('.turn-process-summary').click();
  await page.locator('[data-item-id="segmented-command"] > summary').click();
  const output=page.locator('.step-command .long-text');
  await checkSegment(output,'继续阅读下一段',2);
  await checkSegment(output,'上一段',1);
  assert.deepEqual(errors,[]);
  console.log('PASS Chrome disclosure anchors, keyboard, reduced motion, streaming, explicit bottom follow and segmented answer and tool-output navigation.');
} finally {
  await browser?.close();await app.close();await rm(root,{recursive:true,force:true});
}
