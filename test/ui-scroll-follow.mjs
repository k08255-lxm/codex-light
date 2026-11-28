// Reproduce streaming scroll jumps in the real app with isolated synthetic DemoClient history.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { DemoClient } from '../src/demo.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = process.cwd(), out = path.join(root, '.tmp', 'scroll-follow'); await mkdir(out, { recursive: true });
const temporary = await mkdtemp(path.join(out, 'session-')), client = new DemoClient();
const thread = (await client.call('thread/start', { cwd: root })).thread; thread.name = 'Scroll preservation fixture';
const paragraph = index => `Reading marker ${index}. ` + 'A stable paragraph for reading while work continues. '.repeat(5);
for (let index = 0; index < 12; index++) {
  const item = { id: `answer-${index}`, type: 'agentMessage', text: Array.from({ length: 8 }, (_, n) => paragraph(`${index}-${n}`)).join('\n\n') };
  client.turns.get(thread.id).push({ id: `turn-${index}`, status: 'completed', items: [item] }); client.items.get(thread.id).push({ turnId: `turn-${index}`, item });
}
const live = { id: 'live-answer', type: 'agentMessage', text: Array.from({ length: 10 }, (_, n) => paragraph(`live-${n}`)).join('\n\n') };
const turn = { id: 'live-turn', status: 'inProgress', items: [live] }; client.turns.get(thread.id).push(turn); client.items.get(thread.id).push({ turnId: turn.id, item: live });
const archive=(await client.call('thread/start',{cwd:root})).thread;archive.name='Paged scroll fixture';
for(let i=0;i<320;i++){
  const items=[{id:'uq'+i,type:'userMessage',content:[{type:'text',text:'Question '+i}]},{id:'ar'+i,type:'agentMessage',text:paragraph(i),phase:'final_answer'}];
  client.turns.get(archive.id).push({id:'pg'+i,status:'completed',items});
  client.items.get(archive.id).push(...items.map(item=>({turnId:'pg'+i,item})));
}
const app = await createServer({ client, demo: true, cwd: root, projectsRoot: path.join(temporary, 'projects'), desktopStateRoot: path.join(temporary, 'desktop'), fileAttachmentRoot: path.join(temporary, 'attachments') }); await app.started;
let browser, page; const checks = [], errors = [];
const emit = (method, data) => client.emit('event', { method, params: { threadId: thread.id, turnId: turn.id, ...data } });
function append(text) { live.text += text; emit('item/agentMessage/delta', { itemId: live.id, delta: text }); }
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const width = Number(process.env.SCROLL_VIEWPORT_WIDTH) || 1280, mobile = width < 760;
  page = await browser.newPage({ viewport: { width, height: mobile ? 886 : 850 }, deviceScaleFactor: mobile ? 2656/886 : 1, isMobile: mobile, hasTouch: mobile }); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  if (mobile) await page.addInitScript(() => { window.CodexLightNative = { isNativeApp: () => true, setToolbarIntegrated() {} }; });
  await page.goto(app.url);
  await page.getByRole('button', {name:'使用此主题'}).click();
  if (mobile) await page.locator('#rail-sidebar').click();
  const threadButton = page.locator('.project-group-thread').filter({ hasText: thread.name });
  await threadButton.click();
  await page.locator('[data-item-id="live-answer"]').waitFor();
  const gap = () => page.locator('#conversation').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
  await page.waitForFunction(() => { const c = document.querySelector('#conversation'); return c.scrollHeight - c.scrollTop - c.clientHeight < 3; });
  const box = await page.locator('#conversation').boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const cdp = mobile ? await page.context().newCDPSession(page) : null;
  const scrollUp = async amount => {
    if (cdp) {
      for (let remaining = amount; remaining > 0; remaining -= 140) {
        const distance = Math.min(remaining, 140), x = box.x + box.width / 2, y = box.y + box.height / 3;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let step = 1; step <= 8; step++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + distance * step / 8 }] });
          await page.waitForTimeout(20);
        }
        await page.waitForTimeout(100); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
    }
    else await page.mouse.wheel(0, -amount);
  };
  const anchor = () => page.locator('#conversation').evaluate(c => {
    const top = c.getBoundingClientRect().top;
    const node = [...c.querySelectorAll('.markdown-segment p')].find(n => { const r = n.getBoundingClientRect(); return r.height && r.bottom > top && r.top < top + c.clientHeight; });
    return { text: node?.textContent.slice(0, 90), offset: node?.getBoundingClientRect().top - top, scrollTop: c.scrollTop };
  });
  const assertAnchor = async (before, label) => { const after = await anchor(); assert.equal(after.text, before.text, label + ': same paragraph'); assert.ok(Math.abs(after.offset - before.offset) < 3, label + ': offset ' + (after.offset - before.offset)); };
  if (!mobile) {
    const pending = Promise.withResolvers(), release = Promise.withResolvers();
    const holdRead = async route => {
      if (route.request().postDataJSON()?.method === 'thread/read') {
        pending.resolve(); await release.promise;
      }
      await route.continue();
    };
    await page.route('**/api/rpc', holdRead);
    await threadButton.click();
    await pending.promise;
    await page.locator('#conversation').focus();
    await page.keyboard.press('PageUp');
    await page.waitForTimeout(300);
    const whileLoading = await anchor();
    assert.ok(whileLoading.text && await gap() > 200);
    release.resolve();
    await page.waitForFunction(() => document.querySelector('#conversation').ariaBusy === 'false');
    await page.waitForTimeout(220);
    await assertAnchor(whileLoading, 'keyboard reading while the same thread reloads');
    await page.unroute('**/api/rpc', holdRead);
    await page.locator('.scroll-to-bottom').click();
    await page.waitForFunction(() => { const c = document.querySelector('#conversation'); return c.scrollHeight - c.scrollTop - c.clientHeight < 3; });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    checks.push('a delayed thread refresh keeps the position chosen with Page Up');
  }
  await scrollUp(80); await page.waitForTimeout(180); const near = await anchor();
  const firstGap = await gap(); assert.ok(firstGap > 30 && firstGap < 160, `deliberate scroll gap=${firstGap}`);
  append('\n\n' + Array.from({ length: 8 }, (_, n) => paragraph(`new-${n}`)).join('\n\n'));
  await page.waitForTimeout(220); await assertAnchor(near, 'small deliberate upward scroll');
  checks.push('80px upward reading is preserved when text streams below');

  await scrollUp(500); await page.waitForTimeout(180); const reading = await anchor();
  const tool = { id: 'live-tool', type: 'commandExecution', command: 'echo fixture', aggregatedOutput: 'running', status: 'inProgress' };
  turn.items.push(tool); client.items.get(thread.id).push({ turnId: turn.id, item: tool }); emit('item/started', { item: tool });
  const question = { id: 'live-question', type: 'agentMessage', delivery: 'async', questions: [{ title: 'A synthetic question', options: ['One', 'Two'] }] };
  turn.items.push(question); client.items.get(thread.id).push({ turnId: turn.id, item: question }); emit('item/completed', { item: question });
  await page.waitForTimeout(240); await assertAnchor(reading, 'tool and async question below');
  checks.push('tool and async question activity below does not move the reader');

  const beforeGrowth = await anchor();
  await page.evaluate(text => {
    const target = [...document.querySelectorAll('.markdown-segment p')].find(node => node.textContent.startsWith(text));
    const details = document.createElement('details'); details.id = 'late-growth'; details.innerHTML = '<summary>Delayed preview fixture</summary><div style="height:260px"></div>';
    target.before(details); details.open = true;
  }, beforeGrowth.text);
  await page.waitForTimeout(180); await assertAnchor(beforeGrowth, 'expanded content above anchor');
  await page.locator('#late-growth').evaluate(node => { node.lastElementChild.style.height = '510px'; });
  await page.waitForTimeout(180); await assertAnchor(beforeGrowth, 'late preview resize');
  checks.push('expanded content and delayed height growth above preserve the reading anchor');

  const beforeLong = await anchor(); append('\n\n' + Array.from({ length: 180 }, (_, n) => paragraph(`long-${n}`)).join('\n\n'));
  await page.waitForTimeout(240); await assertAnchor(beforeLong, 'crossing long-text segments');
  const segments = await page.locator('[data-item-id="live-answer"] [data-segment]').evaluateAll(nodes => nodes.map(node => node.dataset.segment));
  append('\n\n' + Array.from({ length: 60 }, (_, n) => paragraph(`tail-${n}`)).join('\n\n'));
  await page.waitForTimeout(240); assert.deepEqual(await page.locator('[data-item-id="live-answer"] [data-segment]').evaluateAll(nodes => nodes.map(node => node.dataset.segment)), segments);
  await assertAnchor(beforeLong, 'segmented stream while paused'); checks.push('streaming long-text windows stop chasing the tail while reading');

  await page.locator('.scroll-to-bottom').click(); await page.waitForTimeout(450); append('\n\n' + paragraph('following'));
  await page.waitForTimeout(240); assert.ok(await gap() < 3, 'explicit bottom resumes following');
  checks.push('explicit return to bottom resumes streaming follow');
  if(!mobile){
    const started=Promise.withResolvers(),release=Promise.withResolvers();
    const cursors=[];
    await page.route('**/api/rpc',async route=>{
      const rpc=route.request().postDataJSON();
      if(rpc?.method==='thread/items/list'&&rpc.params?.threadId===archive.id){
        cursors.push(rpc.params.cursor??'first');
        if(rpc.params.cursor==='400'){started.resolve();await release.promise;}
      }
      await route.continue();
    });
    await page.locator('.project-group-thread').filter({hasText:archive.name}).click();
    await page.locator('[data-item-id="ar319"]').waitFor();
    const marks=page.locator('#turn-timeline .turn-marks button');
    await Promise.race([started.promise,page.waitForTimeout(3000).then(()=>{throw Error('older history was not requested automatically');})]);
    assert.ok(await gap()<3,'background loading starts at the newest reply');
    const first=await marks.first().getAttribute('data-turn');
    assert.ok(await page.locator('[data-virtual-turn-id="'+first+'"]').count());
    await marks.first().click();
    const target=page.locator('[data-turn-id="'+first+'"]');
    await target.waitFor();
    const targetOffset=()=>target.evaluate(n=>n.getBoundingClientRect().top-document.querySelector('#conversation').getBoundingClientRect().top);
    assert.ok(Math.abs(await targetOffset()-8)<2);
    await page.waitForTimeout(120);assert.ok(Math.abs(await targetOffset()-8)<2);
    checks.push('timeline lands on the selected virtual turn and stays aligned');
    const scroller=page.locator('#conversation');
    const box=await scroller.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.wheel(0,430);await page.waitForTimeout(180);
    assert.ok(await scroller.evaluate(n=>n.scrollTop>350),'wheel down releases timeline anchor');
    await page.mouse.wheel(0,-24);
    try{
      await page.waitForTimeout(50);
      const before=await targetOffset();
      for(let i=0;i<4;i++)await page.mouse.wheel(0,-18);
      await page.waitForTimeout(80);
      const moved=await targetOffset()-before;
      assert.ok(Math.abs(moved-72)<4,'reader keeps moving during pending page, actual '+moved);
      const last=await targetOffset();release.resolve();
      for(let i=0;i<5;i++){await page.mouse.wheel(0,-18);await page.waitForTimeout(25);}
      await page.waitForFunction(initial=>document.querySelector('#turn-timeline .turn-marks button')?.dataset.turn!==initial,first);
      await page.waitForTimeout(180);
      const delta=await targetOffset()-last;
      assert.ok(Math.abs(delta-90)<4,'page insertion must preserve wheel movement, actual '+delta);
      checks.push('nine wheel inputs continue through delayed history insertion without a jump');
      await page.waitForFunction(()=>document.querySelectorAll('#turn-timeline .turn-marks button').length===320);
      assert.equal(new Set(cursors).size,cursors.length);
      checks.push('all 320 timeline turns load automatically, with one read per cursor');
    }finally{release.resolve();}
    await threadButton.click();await page.locator('[data-item-id="live-answer"]').waitFor();
    await page.locator('.project-group-thread').filter({hasText:archive.name}).click();
    await page.waitForFunction(()=>document.querySelectorAll('#turn-timeline .turn-marks button').length===320);
    await page.locator('#earlier').waitFor({state:'hidden'});
    assert.ok(await gap()<3,'without gestures all history loads while the newest reply stays in view');
    checks.push('reopening alone fills the entire timeline without moving away from the latest reply');
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.evaluate(()=>{
      const el=document.querySelector('#conversation'), rect=Element.prototype.getBoundingClientRect, query=el.querySelectorAll;
      const counts={geometryReads:0,fullItemScans:0};
      Element.prototype.getBoundingClientRect=function(){if(el.contains(this))counts.geometryReads++;return rect.call(this);};
      el.querySelectorAll=function(selector){if(selector==='[data-item-id]')counts.fullItemScans++;return query.call(this,selector);};
      window.finishScrollSample=()=>{Element.prototype.getBoundingClientRect=rect;delete el.querySelectorAll;return counts;};
    });
    const profile=await page.context().newCDPSession(page);
    await profile.send('Performance.enable');
    const timings=async()=>Object.fromEntries((await profile.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
    const initial=await timings();
    for(let i=0;i<48;i++)await page.mouse.wheel(0,-90);
    await page.waitForTimeout(180);
    const final=await timings(),counts=await page.evaluate(()=>window.finishScrollSample());
    await profile.detach();
    console.log('320-turn continuous scroll',JSON.stringify({...counts,scriptMs:Math.round(1000*(final.ScriptDuration-initial.ScriptDuration)),layoutMs:Math.round(1000*(final.LayoutDuration-initial.LayoutDuration))}));
    assert.equal(counts.fullItemScans,0,'continuous scrolling must not walk every message to locate the reader');
    assert.ok(await gap()>3000,'sustained wheel input moves through several viewports');
    const beforeReturn=await anchor();
    const reads=[],watch=route=>{
      const method=route.request().postDataJSON()?.method;
      if(['thread/read','thread/items/list','thread/turns/list'].includes(method)){reads.push(method);return route.abort();}
      return route.continue();
    };
    await page.route('**/api/rpc',watch);
    await page.locator('#rail-usage').click();
    if(await page.locator('#rail-sidebar').getAttribute('aria-expanded')!=='true')await page.locator('#rail-sidebar').click();
    await page.locator('.project-group-thread').filter({hasText:archive.name}).click();
    await assertAnchor(beforeReturn,'return from usage');
    assert.deepEqual(reads,[]);
    await page.unroute('**/api/rpc',watch);
    checks.push('returning to the open conversation restores the paragraph without rereading history');
    const ladder=page.locator('#turn-timeline .turn-marks'),card=page.getByRole('tooltip');
    await ladder.evaluate(n=>{n.scrollTop=1800;});
    await marks.nth(192).hover();await card.waitFor();await page.waitForTimeout(160);
    assert.equal(await card.locator('.turn-preview-prompt').textContent(),'Question 192');
    assert.match(await card.locator('.turn-preview-response').textContent(),/^Reading marker 192\./);
    const top=await card.evaluate(n=>n.offsetTop);
    await marks.nth(198).hover();await marks.nth(202).hover();
    assert.equal(await card.locator('.turn-preview-prompt').textContent(),'Question 202');
    assert.match(await card.locator('.turn-preview-response').textContent(),/^Reading marker 202\./);
    const motion=await card.evaluate(n=>({duration:getComputedStyle(n).transitionDuration,property:getComputedStyle(n).transitionProperty}));
    assert.deepEqual(motion,{duration:'0.14s',property:'top'});
    await page.waitForTimeout(165);assert.ok((await card.evaluate(n=>n.offsetTop))>top+40);
    const id=await card.getAttribute('id');
    assert.equal(await marks.nth(202).getAttribute('aria-describedby'),id);
    await marks.nth(201).focus();await page.keyboard.press('ArrowUp');
    assert.match(await card.locator('.turn-preview-response').textContent(),/^Reading marker 200\./);
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await card.evaluate(n=>getComputedStyle(n).transitionDuration),'0s');
    await page.screenshot({path:path.join(out,'turn-preview.png')});
    checks.push('rapid pointer moves and arrow keys keep the paired prompt and reply in one moving tooltip; reduced motion is instant');
    await threadButton.click();await page.locator('[data-item-id="live-answer"]').waitFor();
    emit('item/started',{item:{id:'fresh-reply',type:'agentMessage',text:''}});
    await page.locator('[data-item-id="fresh-reply"]').waitFor({state:'attached'});
    await marks.last().hover();
    emit('item/agentMessage/delta',{itemId:'fresh-reply',delta:'New streamed answer'});
    await card.locator('.turn-preview-response').filter({hasText:'New streamed answer'}).waitFor();
    emit('item/agentMessage/delta',{itemId:'fresh-reply',delta:' in the same preview'});
    await card.locator('.turn-preview-response').filter({hasText:'in the same preview'}).waitFor();
    checks.push('a stationary pointer sees new answer tokens in the current turn');
  }
  assert.deepEqual(errors, []); await page.screenshot({ path: path.join(out, `following-${width}.png`) }); console.log(JSON.stringify({ width, input: mobile ? 'touch' : 'wheel', checks, pageErrors: errors }, null, 2));
} catch (error) { if (page) await page.screenshot({ path: path.join(out, 'failure.png') }); console.error(JSON.stringify({ checks, errors })); throw error; }
finally { await browser?.close(); await app.close(); await rm(temporary, { recursive: true, force: true }); }
