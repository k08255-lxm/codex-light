// Explicit browser regression: isolated demo server, no real conversations or model calls.
// NODE_PATH=<Playwright modules> CHROMIUM_PATH=<Chrome executable> node test/ui-thread-navigation.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from '../src/server.mjs';
import { DemoClient } from '../src/demo.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = process.cwd();
const temporary = await mkdtemp(path.join(root, '.tmp', 'navigation-'));
const client = new DemoClient(), original = client.call.bind(client);
const calls = [], results = [], errors = [];
let pendingThreadId = null, pickedFolder = null, folderCalls = 0;
client.call = async (method, params) => {
  calls.push({ method, params });
  const result = await original(method, params);
  if (method === 'turn/start') {
    pendingThreadId = params.threadId;
    for (const timer of client.timers.get(result.turn.id) || []) clearTimeout(timer);
    client.timers.delete(result.turn.id);
  }
  // Reproduce native history indexing lag during the first response.
  if (method === 'thread/list' && pendingThreadId) return { ...result, data: result.data.filter(row => row.id !== pendingThreadId) };
  return result;
};
const app = await createServer({ client, demo: true, desktop: true, onDesktopPickFolder: async () => { folderCalls++; return pickedFolder; }, cwd: root, projectsRoot: path.join(temporary, 'projects'), desktopStateRoot: path.join(temporary, 'desktop'), fileAttachmentRoot: path.join(temporary, 'attachments') });
await app.started;
let browser;
const check = async (name, run) => {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
  console.log(JSON.stringify(results.at(-1)));
};
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  if (process.argv.includes('--baseline')) {
    for (const file of ['app.js', 'ui/composer.js', 'activity-feed.js', 'state.js', 'style.css']) {
      const body = execFileSync('git', ['show', 'HEAD:public/' + file], { encoding: 'utf8' });
      await page.route(app.origin + '/' + file, route => route.fulfill({ body, contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript' }));
    }
  }
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator('#connection-text').filter({ hasText: '演示模式' }).waitFor();
  if (!process.argv.includes('--baseline')) {
    await page.locator('#rail-settings').click();
    await page.locator('#settings-cwd-browse').waitFor();
    await page.locator('#cwd-input').fill(root + '\\draft');
    pickedFolder = root;
    await page.locator('#settings-cwd-browse').click();
    await page.waitForFunction(expected => document.getElementById('cwd-input').value === expected, root);
    assert.equal(client.threads.size, 0, 'choosing a settings folder must never create a thread');
    pickedFolder = null;
    await page.locator('#cwd-input').fill(root + '\\unsaved');
    await page.locator('#settings-cwd-browse').click();
    await page.waitForFunction(() => !document.getElementById('settings-cwd-browse').disabled);
    assert.equal(await page.locator('#cwd-input').inputValue(), root + '\\unsaved');
    assert.equal(folderCalls, 2);
    await page.locator('#rail-home').click();
  }
  await page.locator('#prompt').fill('首轮未结束也能找回');
  await page.locator('#send').click();
  await page.waitForFunction(() => !document.getElementById('new-thread').disabled && !document.getElementById('stop').classList.contains('hidden'));
  if (!process.argv.includes('--baseline')) await check('new chat sends the automatic approval default to both thread and turn', async () => {
    const created = calls.find(row => row.method === 'thread/start').params;
    const started = calls.find(row => row.method === 'turn/start').params;
    assert.equal(created.approvalsReviewer, 'auto_review'); assert.equal(created.approvalPolicy, 'on-request');
    assert.equal(created.sandbox, 'workspace-write');
    assert.equal(started.approvalsReviewer, 'auto_review'); assert.equal(started.approvalPolicy, 'on-request');
    assert.equal(started.sandboxPolicy.type, 'workspaceWrite');
  });
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/rpc') && response.request().postDataJSON()?.method === 'thread/list'),
    page.locator('#refresh').click(),
  ]);
  await check('first running thread survives a stale history list', async () => {
    await page.locator('.project-group-thread.running').waitFor({ timeout: 2000 });
  });
  if (!process.argv.includes('--baseline')) await check('running conversations have no blue unread dot',async()=>{
    assert.equal(await page.locator('.project-group-thread.running .thread-unread-indicator:visible').count(),0);
  });
  await check('model-only work shows continuous running feedback', async () => {
    await page.locator('.turn-working[data-running="true"]').waitFor({ timeout: 2000 });
    const name = await page.locator('.turn-working').evaluate(node => getComputedStyle(node, '::before').animationName);
    assert.equal(name, 'working-dot');
  });
  await check('leave a first running turn and reopen it before history indexing', async () => {
    await page.locator('#new-thread').click();
    await page.locator('.project-group-thread.running').click({ timeout: 2000 });
    await page.locator('#stop:not(.hidden)').waitFor({ timeout: 2000 });
    assert.match(await page.locator('#messages').textContent(), /首轮未结束也能找回/);
  });
  // Make the server list catch up so the route regression remains independent.
  const runningId = pendingThreadId; pendingThreadId = null;
  await page.locator('#refresh').click();
  await page.locator('.project-group-thread').waitFor();
  for (const [rail, stage] of [['usage', 'usage-page'], ['account', 'account-page'], ['terminal', 'terminal-page']]) {
    await page.locator('#rail-' + rail).click();
    await page.locator('#' + stage).waitFor();
    await check(`project sidebar closes by default on ${rail}`, async () => assert.equal(await page.locator('#rail-sidebar').getAttribute('aria-expanded'), 'false'));
    await check(`conversation click returns from ${rail} to chat`, async () => {
      // Baseline dispatch reaches the old callback even when its sidebar is hidden.
      if (process.argv.includes('--baseline')) await page.locator('.project-group-thread').dispatchEvent('click');
      else {await page.locator('#rail-sidebar').click();await page.locator('.project-group-thread').click();}
      await page.locator('#chat-page').waitFor({ timeout: 2000 });
      assert.equal(await page.locator('#app').getAttribute('data-view'), 'chat');
    });
  }
  await page.locator('#rail-home').click();
  await page.locator('#new-thread').click();
  await page.locator('.project-group-thread').click();
  await page.locator('#stop:not(.hidden)').waitFor();
  if (!process.argv.includes('--baseline')) {
    await page.setViewportSize({ width: 707, height: 650 });
    await page.locator('#rail-usage').click();
    await page.locator('#rail-sidebar').click();
    await page.locator('.project-group-thread').click();
    assert.equal(await page.locator('#chat-page').isVisible(), true);
    await page.locator('#sidebar-overlay').waitFor({ state: 'hidden' });
    await page.evaluate(() => document.documentElement.dataset.reducedMotion = 'true');
    assert.equal(await page.locator('.turn-working').evaluate(node => getComputedStyle(node, '::before').animationName), 'none');
    await page.evaluate(() => document.documentElement.dataset.reducedMotion = 'false');
    await page.screenshot({ path: path.join(root, '.tmp', 'thread-navigation-narrow.png') });
    await page.setViewportSize({ width: 1440, height: 920 });
  }
  assert.equal(calls.filter(row => row.method === 'turn/start').length, 1, 'navigation must never resend');
  await page.locator('#new-thread').click();
  const turn = client.turns.get(runningId)[0];
  pendingThreadId = runningId;
  turn.status = 'completed';
  client.emit('event', { method: 'turn/completed', params: { threadId: runningId, turn } });
  await page.waitForFunction(() => !document.querySelector('.project-group-thread.running'));
  if (!process.argv.includes('--baseline')) await check('a background completed turn shows an unread dot',async()=>{
    await page.locator('.project-group-thread .thread-unread-indicator:visible').waitFor({timeout:2000});
    assert.match(await page.locator('.project-group-thread').getAttribute('aria-label'),/新一轮已完成，未读/);
  });
  await page.locator('.project-group-thread').click();
  await page.locator('#stop').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.turn-working[data-running="true"]').count(), 0);
  if (!process.argv.includes('--baseline')) {
    await check('opening the completed conversation clears its unread dot',async()=>{
      await page.waitForFunction(()=>document.querySelector('.thread-unread-indicator')?.hidden===true);
    });
    await page.locator('#new-thread').click();
    await check('completion replay after reading does not restore an unread dot',async()=>{
      client.emit('event', { method: 'turn/completed', params: { threadId: runningId, turn } });
      // The event triggers a list refresh; waiting for its response gives the event a deterministic fence.
      await page.waitForResponse(response=>response.url().endsWith('/api/rpc')&&response.request().postDataJSON()?.method==='thread/list');
      assert.equal(await page.locator('.thread-unread-indicator:visible').count(),0);
    });
    await page.locator('.project-group-thread').click();
    await page.waitForFunction(()=>!document.querySelector('#thread-menu-button').disabled);
    await check('a separate browser session restores the saved approval choice and uses it on the next turn',async()=>{
      await page.locator('#permissions-info').click();
      await Promise.all([
        page.waitForResponse(response=>response.url().endsWith('/api/session/permission')&&response.request().postDataJSON()?.mode==='request'&&response.ok()),
        page.locator('#permission-menu [data-value="request"]').click(),
      ]);
      pendingThreadId=null;
      const other=await browser.newPage({viewport:{width:1440,height:900}});
      try{
        await other.goto(app.url);
        await other.locator('.project-group-thread').click();
        await other.locator('#permissions-info .label').filter({hasText:'请求批准'}).waitFor();
        await other.locator('#prompt').fill('验证此对话的审批方式');
        await other.locator('#send').click();
        await other.locator('#stop:not(.hidden)').waitFor();
        const sent=calls.filter(row=>row.method==='turn/start').at(-1).params;
        assert.equal(sent.threadId,runningId);assert.equal(sent.approvalsReviewer,'user');assert.equal(sent.approvalPolicy,'on-request');assert.deepEqual(sent.sandboxPolicy,{type:'workspaceWrite'});
        const next=client.turns.get(runningId).at(-1);next.status='completed';
        client.emit('event',{method:'turn/completed',params:{threadId:runningId,turn:next}});
        await other.locator('#stop').waitFor({state:'hidden'});
      }finally{await other.close();pendingThreadId=null;}
    });
    await page.locator('#thread-menu-button').click();
    await page.locator('#archive-thread').click();
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.project-group-thread'));
    assert.equal(client.threads.get(runningId).archived, true);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
  assert.ok(results.every(row => row.passed), 'navigation regression failed');
} finally {
  await browser?.close(); await app.close();
  await rm(temporary, { recursive: true, force: true });
}
