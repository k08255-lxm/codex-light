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
  assert.deepEqual(errors, []); console.log(JSON.stringify({passed: checks.length, pageErrors: errors, checks}, null, 2));
} finally {await browser?.close(); await app.close(); await fs.rm(temporary, {recursive: true, force: true});}
