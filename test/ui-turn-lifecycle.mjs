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
  await page.getByRole('button',{name:'使用此主题'}).click();
  if (await page.locator('#rail-sidebar').getAttribute('aria-expanded') !== 'true') await page.locator('#rail-sidebar').click();
  await check('thread status identifies running work in the sidebar before opening its history', async () => {
    const row = page.locator('.project-group-thread').filter({hasText:thread.name});
    await row.waitFor();
    client.emit('event',{method:'thread/status/changed',params:{threadId:thread.id,status:{type:'active',activeFlags:[]}}});
    await row.locator('.thread-running-indicator').waitFor();
    client.emit('event',{method:'thread/status/changed',params:{threadId:thread.id,status:{type:'idle'}}});
    await row.locator('.thread-running-indicator').waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>window.badges.map(message=>message.count)),[0]);
  });
  await page.locator('.project-group-thread').filter({hasText: '长任务状态回归'}).click();
  await page.locator('.turn-working[data-running="true"]').waitFor();
  await check('restored work shows a rotating circle and ignores previous-turn and subagent completions', async () => {
    await page.locator('#rail-sidebar').click();
    const row = page.locator('.project-group-thread.running').filter({hasText:thread.name});
    const spinner = row.locator('.thread-running-indicator');
    await spinner.waitFor();
    assert.equal(await spinner.evaluate(node => getComputedStyle(node).animationName), 'thread-running-spin');
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>document.documentElement.dataset.reducedMotion==='true');
    assert.equal(await spinner.evaluate(node => getComputedStyle(node).animationName), 'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('#new-thread').click();
    thread.name = '仍在运行';
    client.emit('event',{method:'turn/completed',params:{threadId:thread.id,turn:{id:'previous-turn',status:'completed'}}});
    client.emit('event',{method:'thread/started',params:{thread:{id:'child-session',parentThreadId:thread.id}}});
    client.emit('event',{method:'turn/completed',params:{threadId:'child-session',turn:{id:'child-turn',status:'completed'}}});
    client.emit('event',{method:'thread/name/updated',params:{threadId:thread.id,threadName:'仍在运行'}});
    await page.locator('#rail-sidebar').click();
    const renamed = page.locator('.project-group-thread.running').filter({hasText:'仍在运行'});
    await renamed.locator('.thread-running-indicator').waitFor();
    assert.deepEqual(await page.evaluate(()=>window.badges.map(message=>message.count)),[0]);
    await renamed.click();
    await page.locator('.turn-working[data-running="true"]').waitFor();
  });
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
  await check('reopening with a live steer ahead of the history response keeps completed and running turns in order',async()=>{
    const message=(id,text)=>({id,type:'userMessage',content:[{type:'text',text}]});
    const now=Math.floor(Date.now()/1000);
    const previous={id:'z-earlier',status:'completed',startedAt:now-1900,durationMs:960000,items:[
      message('previous-prompt','请整理昨天的会议记录。'),
      {id:'previous-step',type:'reasoning',summary:['核对议程和记录。']},
      {id:'previous-final',type:'agentMessage',phase:'final_answer',text:'会议记录已整理完毕。'},
    ]};
    const current={id:'a-later',status:'inProgress',startedAt:now-900,items:[
      message('current-prompt','请继续整理今天的会议记录。'),
      message('current-steer','也请列出需要跟进的事项。'),
      {id:'current-activity',type:'agentMessage',phase:'commentary',text:'正在核对今天的待办事项。'},
    ]};
    const {thread:fixture}=await client.call('thread/start',{cwd:temporary});
    fixture.name='会议记录';client.turns.set(fixture.id,[previous,current]);
    client.items.set(fixture.id,[previous,current].flatMap(turn=>turn.items.map(item=>({turnId:turn.id,item}))));
    await page.setViewportSize({width:1280,height:850});await page.reload();
    await page.locator('#connection-text').filter({hasText:'演示模式'}).waitFor({state:'attached'});
    const row=page.locator('.project-group-thread').filter({hasText:fixture.name});
    await row.waitFor({state:'attached'});
    if(!await row.isVisible())await page.locator('#rail-sidebar').click();
    let requestCaptured,releaseHistory;
    const captured=new Promise(resolve=>{requestCaptured=resolve;}),release=new Promise(resolve=>{releaseHistory=resolve;});
    const original=client.call.bind(client);
    client.call=async(method,params)=>{
      const result=await original(method,params);
      if(method==='thread/items/list'&&params.threadId===fixture.id){requestCaptured();await release;}
      return result;
    };
    const turnIds=()=>page.locator('#messages .turn').evaluateAll(nodes=>nodes.map(node=>node.dataset.turnId));
    try {
      await row.click();await captured;
      for(const item of current.items.slice(1))client.emit('event',{method:'item/completed',params:{threadId:fixture.id,turnId:current.id,item}});
      await page.locator('[data-item-id="current-steer"]').waitFor();
    }finally{releaseHistory();client.call=original;}
    await page.locator('[data-item-id="previous-final"]').waitFor();
    const expected=[previous.id,current.id];
    assert.deepEqual(await turnIds(),expected);
    assert.deepEqual(await page.locator('#messages .userMessage').allTextContents(),[
      '请整理昨天的会议记录。','请继续整理今天的会议记录。','运行中补充也请列出需要跟进的事项。',
    ]);
    const old=page.locator('[data-turn-id="z-earlier"]'),active=page.locator('[data-turn-id="a-later"]');
    assert.match(await old.locator('.turn-work').textContent(),/用时 16m/);
    assert.match(await active.locator('.turn-working').textContent(),/正在工作.*15m/);
    assert.equal(await active.locator('.userMessage.steer').getAttribute('data-item-id'),'current-steer');
    const order=await page.locator('#messages').evaluate(root=>['[data-item-id="previous-prompt"]','.turn-work','[data-item-id="previous-final"]','[data-item-id="current-prompt"]','[data-item-id="current-steer"]','[data-item-id="current-activity"]','.turn-working'].map(selector=>root.querySelector(selector).getBoundingClientRect().top));
    assert.deepEqual(order,[...order].sort((a,b)=>a-b));
    if(process.env.CONVERSATION_ORDER_SCREENSHOT)await page.locator('#conversation').screenshot({path:process.env.CONVERSATION_ORDER_SCREENSHOT});
    if(!await row.isVisible())await page.locator('#rail-sidebar').click();
    await page.locator('#new-thread').click();await row.click();
    await page.locator('[data-item-id="previous-final"]').waitFor();assert.deepEqual(await turnIds(),expected);
  });
  assert.deepEqual(errors, []); console.log(JSON.stringify({passed: checks.length, pageErrors: errors, checks}, null, 2));
} finally {await browser?.close(); await app.close(); await fs.rm(temporary, {recursive: true, force: true});}
