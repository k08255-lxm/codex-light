// Isolated DemoClient reproduces large file edits during a long turn; no model calls.
// NODE_PATH=.tmp/visual-runtime/node_modules CHROMIUM_PATH=<Chrome executable> node test/ui-turn-lifecycle.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
const {chromium} = createRequire(import.meta.url)('playwright');
const temporary = await fs.mkdtemp(path.join(process.cwd(), '.tmp', 'turn-lifecycle-'));
const client = new DemoClient(), {thread} = await client.call('thread/start', {cwd: temporary}); thread.name = '长任务状态回归';
const startedAt = Math.floor(Date.now() / 1000) - 2722, turnId = 'real-long-turn';
const prompt = {id: 'prompt', type: 'userMessage', content: [{type: 'text', text: '保持这轮任务运行，并读取多文件差异'}]};
const changes = Array.from({length: 4}, (_, index) => ({path: `file-${index}.txt`, kind: {type: 'update'}, diff: '@@ -1 +1 @@\n-a\n+' + 'x'.repeat(33000)}));
const edit = {id: 'large-edit', type: 'fileChange', status: 'completed', changes};
const turn = {id: turnId, status: 'inProgress', startedAt, items: [prompt, edit]};
client.turns.set(thread.id, [turn]);
client.items.set(thread.id, [{turnId, item: prompt}, {turnId, item: edit, startedAtMs: startedAt * 1000 + 1000, completedAtMs: startedAt * 1000 + 20000}]);
const app = await createServer({demo: true, client, cwd: temporary, projectStore: {list: async () => ({projects: [{id: 'project', path: temporary}], selectedId: 'project'}), queue: Promise.resolve()}, fileAttachmentRoot: path.join(temporary, 'attachments')});
await app.started;
let browser;
const errors = [], checks = [];
async function check(name, run) {await run(); checks.push(name); console.log('PASS ' + name);}
try {
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH});
  const page = await browser.newPage({viewport: {width: 320, height: 740}, isMobile: true, hasTouch: true}); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(()=>{
    window.badges=[];
    window.chrome ||= {};
    window.chrome.webview={addEventListener(){},postMessage(message){if(message.type==='desktopTaskbarBadge')window.badges.push(message);}};
  });
  await page.goto(app.url); await page.locator('#connection-text').filter({hasText: '演示模式'}).waitFor({state: 'attached'});
  if (await page.locator('#rail-sidebar').getAttribute('aria-expanded') !== 'true') await page.locator('#rail-sidebar').click();
  await page.locator('.project-group-thread').filter({hasText: '长任务状态回归'}).click();
  await page.locator('.turn-working[data-running="true"]').waitFor();
  await check('large file changes stay inside the real running turn without a fabricated 19-second footer', async () => {
    assert.equal(await page.locator('#messages .turn').count(), 1);
    assert.equal(await page.locator('#messages .turn').getAttribute('data-turn-id'), turnId);
    assert.equal(await page.locator('.turn-working[data-running="true"]').count(), 1);
    assert.match(await page.locator('.turn-working').textContent(), /正在工作.*45m/);
    assert.doesNotMatch(await page.locator('#messages').textContent(), /用时约 19s/);
    assert.equal(await page.locator('.turn-work').count(), 0);
  });
  await check('steered input stays in that turn and does not reset its running timer', async () => {
    const steer = {id: 'steer', type: 'userMessage', content: [{type: 'text', text: '运行中补充检查'}]};
    turn.items.push(steer); client.items.get(thread.id).push({turnId, item: steer});
    client.emit('event', {method: 'item/completed', params: {threadId: thread.id, turnId, item: steer}});
    await page.locator('.userMessage.steer').waitFor();
    assert.equal(await page.locator('#messages .turn').count(), 1); assert.match(await page.locator('.turn-working').textContent(), /45m/);
  });
  await check('matching real completion settles that one turn and removes its running feedback', async () => {
    turn.status = 'completed'; turn.durationMs = 2722000;
    client.emit('event', {method: 'turn/completed', params: {threadId: thread.id, turn}});
    await page.locator('.turn-working[data-running="true"]').waitFor({state: 'hidden'});
    assert.equal(await page.locator('#messages .turn').count(), 1);
    assert.equal(await page.locator('.turn-work[data-kind="completed"]').count(), 1);
    assert.doesNotMatch(await page.locator('#messages').textContent(), /用时约 19s/);
  });
  await check('two unread completions in one conversation count separately until the conversation is read',async()=>{
    await page.locator('#rail-usage').click();
    for(const id of ['unread-one','unread-two','unread-two']){
      client.emit('event',{method:'turn/completed',params:{threadId:thread.id,turn:{id,status:'completed'}}});
    }
    await page.waitForFunction(()=>window.badges.at(-1)?.count===2);
    await page.locator('#rail-home').click();
    await page.waitForFunction(()=>window.badges.at(-1)?.count===0);
    assert.deepEqual(await page.evaluate(()=>window.badges.slice(-3).map(message=>message.count)),[1,2,0]);
  });
  await check('an interrupted submission without its native echo stays before the next user message',async()=>{
    const originalCall=client.call.bind(client),firstText='先发送后暂停',nextText='暂停后发送下一条';
    client.call=async(method,params)=>{
      if(method!=='turn/start'||params.input?.[0]?.text!==firstText)return originalCall(method,params);
      const incomplete={id:'interrupted-before-echo',status:'inProgress',items:[]};
      client.turns.get(thread.id).push(incomplete);
      client.emit('event',{method:'turn/started',params:{threadId:thread.id,turn:incomplete}});
      return {turn:incomplete};
    };
    await page.locator('#prompt').fill(firstText);await page.locator('#send').click();
    await page.locator('#messages .userMessage').filter({hasText:firstText}).waitFor();
    await page.locator('#stop').click();await page.locator('#stop').waitFor({state:'hidden'});
    await page.locator('#prompt').fill(nextText);await page.locator('#send').click();
    await page.locator('#messages .userMessage').filter({hasText:nextText}).waitFor();
    const messages=await page.locator('#messages .userMessage').allTextContents();
    assert.deepEqual(messages.filter(text=>text.includes(firstText)||text.includes(nextText)),[firstText,nextText]);
    await page.locator('.optimistic-message').waitFor({state:'detached'});
  });
  await check('external work finishes while browsing another conversation and an old running history entry stays inactive',async()=>{
    await page.locator('#stop').waitFor({state:'hidden'});
    const history=client.turns.get(thread.id);
    history.unshift({id:'historical-unclosed',status:'inProgress',items:[]});
    const external={id:'external-observed',status:'inProgress',items:[]};
    history.push(external);client.emit('event',{method:'turn/started',params:{threadId:thread.id,turn:external}});
    const row=page.locator('.project-group-thread').first();
    await page.locator('.project-group-thread.running').waitFor({state:'attached'});
    await page.locator('#rail-sidebar').click();await page.locator('#new-thread').click();
    external.status='completed'; // The other client completes without sending us an event.
    await page.locator('.project-group-thread.running').waitFor({state:'detached',timeout:12000});
    if(await page.locator('#rail-sidebar').getAttribute('aria-expanded')!=='true')await page.locator('#rail-sidebar').click();
    await row.click();await page.locator('#prompt:not([disabled])').waitFor();
    assert.equal(await row.evaluate(el=>el.classList.contains('running')),false);
    assert.equal(await page.locator('#stop').isVisible(),false);
  });
  await check('reconnect replaces a stale owned running turn when completion was missed',async()=>{
    const lost={id:'lost-during-disconnect',status:'inProgress',items:[]};client.turns.get(thread.id).push(lost);
    client.emit('event',{method:'bridge/threadSessions',params:{threads:[{threadId:thread.id,activeTurnId:lost.id,state:'active'}]}});
    await page.locator('.project-group-thread.running').waitFor({state:'attached'});
    lost.status='interrupted';
    const reconnect=page.waitForResponse(response=>response.url().endsWith('/api/status')&&response.ok());
    app.server.closeAllConnections();await reconnect;
    await page.locator('.project-group-thread.running').waitFor({state:'detached'});
    assert.equal(await page.locator('.thread-unread-indicator:visible').count(),0);
  });
  assert.deepEqual(errors, []); console.log(JSON.stringify({passed: checks.length, pageErrors: errors, checks}, null, 2));
} finally {await browser?.close(); await app.close(); await fs.rm(temporary, {recursive: true, force: true});}
