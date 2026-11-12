// Explicit run only (not part of npm test): headless Chrome against the local DemoClient.
// No real model, no user conversations, no visible window. Writes screenshots to .tmp/ui-shots.
//   $env:NODE_PATH=<Codex runtime node_modules>; $env:CHROMIUM_PATH=<chrome.exe>; node test/ui-visual.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.mjs';
import { DemoClient } from '../src/demo.mjs';

const require = createRequire(import.meta.url); const { chromium } = require('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const shots = path.join(root, '.tmp', 'ui-shots'); await mkdir(shots, { recursive: true });
const workdir = path.join(root, '.tmp', 'test-runtime'); await mkdir(workdir, { recursive: true });
const profile = await mkdtemp(path.join(workdir, 'ui-profile-'));
const client = new DemoClient();
const app = await createServer({ client, demo: true, cwd: root, fileAttachmentRoot: path.join(profile, 'attachments'), projectsRoot: path.join(profile, 'projects'), desktopStateRoot: path.join(profile, 'desktop') }); await app.started;
const browser = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1440, height: 920 }, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-first-run', '--no-default-browser-check'] });
const page = browser.pages()[0] || await browser.newPage();
// Methods the BROWSER sends to /api/rpc (the backend may legitimately resume before real work).
const frontendRpc = [];
page.on('request', request => { if (request.url().endsWith('/api/rpc') && request.method() === 'POST') { try { frontendRpc.push(JSON.parse(request.postData() || '{}').method); } catch {} } });
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const checks = []; const ok = text => { checks.push(text); console.log('✔', text); };

// Instrument the demo backend: record calls and optionally keep the next turn running.
const calls = []; let holdNext = false; const original = client.call.bind(client);
client.call = async (method, params) => {
  calls.push({ method, params: structuredClone(params) });
  const result = await original(method, params);
  if (method === 'turn/start' && holdNext) { holdNext = false; for (const timer of client.timers.get(result.turn.id) || []) clearTimeout(timer); client.timers.delete(result.turn.id); }
  return result;
};
const emit = (method, params) => client.emit('event', { method, params });
const count = method => calls.filter(row => row.method === method).length;
const shot = async name => { await page.screenshot({ path: path.join(shots, name + '.png') }); };
const setLook = (theme, style) => page.evaluate(([t, s]) => { document.documentElement.dataset.theme = t; document.documentElement.dataset.visualStyle = s; }, [theme, style]);

try {
  await page.goto(app.url); await page.locator('#connection-text').filter({ hasText: '演示模式' }).waitFor();
  await page.waitForFunction(() => document.getElementById('cwd-label').textContent !== '设置工作目录');
  await shot('01-welcome-wide-dark-codex');

  // Slash menu: open, navigate, Escape, IME, real action.
  await page.locator('#prompt').click(); await page.keyboard.type('/');
  await page.locator('#slash-menu .slash-option').first().waitFor();
  const labels = await page.locator('#slash-menu .slash-label').allTextContents();
  assert.deepEqual(labels.slice(0, 6), ['/new', '/compact', '/review', '/fork', '/rename', '/model']);
  assert.equal(await page.locator('#slash-menu [aria-disabled="true"]').filter({ hasText: '/compact' }).count(), 1, 'compact disabled on draft');
  const selected = () => page.locator('#slash-menu [aria-selected="true"] .slash-label').textContent();
  assert.equal(await selected(), '/new'); await page.keyboard.press('ArrowDown');
  assert.notEqual(await selected(), '/compact', 'arrow navigation skips disabled entries');
  await page.locator('#prompt').dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  assert.equal(await page.locator('#slash-menu').isVisible(), true, 'IME Enter does not choose');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#slash-menu').isVisible(), false);
  assert.equal(await page.locator('#prompt').inputValue(), '/', 'Escape keeps the typed text');
  await page.keyboard.type('mod'); await page.keyboard.press('Enter');
  await page.locator('#reasoning-popover').waitFor(); assert.equal(await page.locator('#prompt').inputValue(), '');
  await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('第一行'); await page.locator('#prompt').press('Shift+Enter');
  assert.match(await page.locator('#prompt').inputValue(), /第一行\n/); await page.locator('#prompt').fill('');
  ok('Slash menu: commands listed, disabled state, arrow/Escape/IME/Enter, Shift+Enter newline');

  // New chat is a draft until first send.
  await page.locator('#new-thread').click(); assert.equal(client.threads.size, 0);
  assert.equal(count('thread/start'), 0); ok('New chat stays a frontend draft (no thread/start before send)');

  // First send creates the thread and the turn; history uses read, never resume.
  await page.locator('#prompt').fill('界面测试 <img src=x onerror="window.injected=1">'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#messages .turn').length === 1 && !document.querySelector('#stop:not(.hidden)'));
  assert.equal(client.threads.size, 1); assert.deepEqual(calls.filter(r => ['thread/start', 'turn/start'].includes(r.method)).map(r => r.method), ['thread/start', 'turn/start']);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  const threadId = [...client.threads.keys()][0];
  ok('First send = thread/start then turn/start; user HTML is inert');

  // Long running turn: steer, queue, live process, files, context.
  const backendResumeBeforeWork = count('thread/resume');
  holdNext = true; await page.locator('#prompt').fill('重构项目'); await page.keyboard.press('Enter');
  await page.locator('#stop').waitFor({ state: 'visible' });
  assert.equal(count('thread/resume'), backendResumeBeforeWork + 1, 'sending to a released thread lazily resumes the backend exactly once');
  const turn = client.turns.get(threadId).at(-1); assert.equal(turn.status, 'inProgress');
  assert.equal(await page.locator('#send').getAttribute('data-mode'), 'steer');
  await page.locator('#prompt').fill('顺便更新 README'); assert.equal(await page.locator('#queue-send').isVisible(), true);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('prompt').value === '');
  const steer = calls.find(r => r.method === 'turn/steer');
  assert.deepEqual(Object.keys(steer.params).sort(), ['expectedTurnId', 'input', 'threadId']); assert.equal(steer.params.expectedTurnId, turn.id);
  await page.locator('.userMessage.steer').waitFor();
  ok('Steer sends only threadId/expectedTurnId/input, clears draft after ack, shows steer in the running turn');

  const starts = count('turn/start');
  await page.locator('#prompt').fill('排队：再跑一次测试'); await page.keyboard.press('Tab');
  await page.locator('#queue .queue-item').waitFor(); assert.equal(count('turn/start'), starts, 'queue does not send');
  assert.equal(await page.locator('#prompt').inputValue(), '');
  await page.locator('#queue .queue-item .queue-action').filter({ hasText: '编辑' }).click();
  await page.locator('.queue-edit').fill('排队：再跑一次测试（已编辑）'); await page.locator('.queue-edit').press('Enter');
  assert.match(await page.locator('#queue .queue-text').textContent(), /已编辑/);
  ok('Tab queues the draft per thread with visible edit, nothing sent yet');

  const now = Date.now(); const t = turn.id;
  emit('item/completed', { threadId, turnId: t, completedAtMs: now, item: { id: 'c1', type: 'agentMessage', phase: 'commentary', text: '我先阅读项目结构，再修改 `app.js`。' } });
  emit('item/completed', { threadId, turnId: t, completedAtMs: now, item: { id: 'r1', type: 'reasoning', summary: ['比较两种实现方式'], content: [] } });
  emit('item/completed', { threadId, turnId: t, item: { id: 'x1', type: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: 'ok', commandActions: [] } });
  emit('item/started', { threadId, turnId: t, startedAtMs: now, item: { id: 'f1', type: 'fileChange', status: 'inProgress', changes: [
    { path: path.join(root, 'public', 'app.js'), kind: { type: 'update', move_path: null }, diff: '@@ -1,2 +1,3 @@\n-old\n+new\n+more\n keep\n' },
    { path: path.join(root, 'public', 'state.js'), kind: { type: 'add' }, diff: 'a\nb\nc\n' },
    { path: path.join(root, 'docs', '设计 说明.md'), kind: { type: 'update', move_path: null }, diff: '@@ -3 +3 @@\n-x\n+y\n' },
    { path: path.join(root, 'test', 'a.test.mjs'), kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-1\n+2\n' } ] } });
  emit('thread/tokenUsage/updated', { threadId, turnId: t, tokenUsage: { total: { totalTokens: 5000000, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }, last: { totalTokens: 64000, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }, modelContextWindow: 256000 } });
  await page.locator('.files-card').waitFor();
  assert.match(await page.locator('.files-title').textContent(), /正在编辑 4 个文件/);
  assert.match(await page.locator('.turn-process.first .turn-process-label').last().textContent(), /正在工作/);
  assert.equal(await page.locator('#context-label').textContent(), '75%');
  await shot('02-running-wide-dark-codex');
  ok('Running turn: live elapsed label, steps, live edited-file count, context 75% from last/window');

  // Complete the turn: process collapses, final answer + Markdown local link, queue drains once.
  emit('item/completed', { threadId, turnId: t, item: { id: 'f1', type: 'fileChange', status: 'completed', changes: [
    { path: path.join(root, 'public', 'app.js'), kind: { type: 'update', move_path: null }, diff: '@@ -1,2 +1,3 @@\n-old\n+new\n+more\n keep\n' },
    { path: path.join(root, 'public', 'state.js'), kind: { type: 'add' }, diff: 'a\nb\nc\n' },
    { path: path.join(root, 'docs', '设计 说明.md'), kind: { type: 'update', move_path: null }, diff: '@@ -3 +3 @@\n-x\n+y\n' },
    { path: path.join(root, 'test', 'a.test.mjs'), kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-1\n+2\n' } ] } });
  const answer = '已整理到 [sample.md](C:/Users/TestUser/demo-project/sample.md)，并更新 [app.js](public/app.js#L12)。\n\n- 链接 [官网](https://example.com)\n- 危险链接 [x](javascript:alert(1)) 保持文本';
  emit('item/completed', { threadId, turnId: t, item: { id: 'final1', type: 'agentMessage', phase: 'final_answer', text: answer } });
  turn.status = 'completed'; emit('turn/completed', { threadId, turn: { ...turn, items: [], durationMs: 18000 } });
  await page.waitForFunction(() => [...document.querySelectorAll('.turn-process-label')].some(n => n.textContent === '用时 18s'));
  await page.waitForFunction(() => !document.querySelector('#queue .queue-item'), null, { timeout: 5000 });
  const drained = calls.filter(r => r.method === 'turn/start').at(-1);
  assert.equal(count('turn/start'), starts + 1); assert.match(drained.params.input[0].text, /已编辑/);
  assert.equal(await page.locator('.turn-process.first[open]').count() >= 0, true);
  const collapsed = await page.evaluate(() => { const done = [...document.querySelectorAll('.turn')].find(n => n.textContent.includes('用时 18s')); return { open: done.querySelector('.turn-process').open, link: done.querySelector('.md-file-link')?.textContent, raw: done.textContent.includes('](C:'), anchors: [...done.querySelectorAll('a')].map(a => a.href) }; });
  assert.equal(collapsed.open, false); assert.equal(collapsed.link, 'sample.md'); assert.equal(collapsed.raw, false); assert.deepEqual(collapsed.anchors, ['https://example.com/']);
  assert.match(await page.locator('.files-title').first().textContent(), /已编辑 4 个文件/);
  assert.equal(await page.locator('.files-card .file-row').first().locator('xpath=..').locator('.file-row').count(), 3);
  ok('Completion: collapsed "用时 18s", final answer outside, local path link control, queue drained exactly once');
  await page.waitForFunction(() => !document.querySelector('#stop:not(.hidden)'));
  await page.locator('#conversation').evaluate(n => { n.scrollTop = 0; });
  await page.evaluate(() => { const done = [...document.querySelectorAll('.turn')].find(n => n.textContent.includes('用时 18s')); done.scrollIntoView({ block: 'start' }); });
  await shot('03-completed-wide-dark-codex');
  await page.locator('.files-more').first().click(); await page.locator('.file-row-head').first().click();
  await page.locator('.diff-view').first().waitFor(); await shot('04-files-expanded-dark-codex');
  ok('Files card expands to all files and shows a real diff');

  // Theme/style/layout matrix.
  for (const [theme, style] of [['light', 'codex'], ['dark', 'claude'], ['light', 'claude']]) { await setLook(theme, style); await shot(`05-completed-wide-${theme}-${style}`); }
  await page.setViewportSize({ width: 720, height: 860 });
  for (const [theme, style] of [['dark', 'codex'], ['light', 'claude']]) { await setLook(theme, style); await shot(`06-narrow-${theme}-${style}`); }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.getElementById('conversation').scrollWidth > document.getElementById('conversation').clientWidth + 1);
  assert.equal(overflow, false, 'no horizontal overflow at 720px');
  await page.locator('#rail-sidebar').click(); await page.locator('#sidebar-overlay:not(.hidden)').waitFor(); await shot('07-narrow-sidebar-light-claude');
  await page.keyboard.press('Escape'); await page.locator('#sidebar-overlay').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1440, height: 920 }); await setLook('dark', 'codex');
  ok('Wide/narrow × light/dark × Codex/Claude screenshots; no horizontal overflow; narrow sidebar overlay opens/closes');

  // Leaving and reopening history uses read APIs only and keeps turn grouping.
  await page.locator('#new-thread').click();
  await page.waitForFunction(() => document.getElementById('thread-title').textContent === '新对话');
  assert.ok(calls.some(r => r.method === 'thread/unsubscribe' && r.params.threadId === threadId), 'leaving an idle thread unsubscribes');
  const backendResumeBefore = count('thread/resume'); const frontendBefore = frontendRpc.length;
  await page.locator('.project-group-thread').first().click();
  await page.waitForFunction(() => document.querySelectorAll('#messages .turn').length >= 2);
  assert.equal(frontendRpc.includes('thread/resume'), false, 'the browser never sends thread/resume');
  assert.equal(count('thread/resume'), backendResumeBefore, 'opening history causes no new backend resume');
  const historyRpc = frontendRpc.slice(frontendBefore);
  assert.ok(historyRpc.includes('thread/read'), 'history uses the browser read API');
  assert.ok(historyRpc.includes('thread/items/list'), 'history loads items through the browser read API');
  ok('History reopen: thread/read + items/list, unsubscribe on leave, never resume');

  // Interruption pauses the queue; nothing is auto-sent.
  holdNext = true; await page.locator('#prompt').fill('会被停止的任务'); await page.keyboard.press('Enter');
  await page.locator('#stop').waitFor({ state: 'visible' });
  await page.locator('#prompt').fill('不应自动发送'); await page.keyboard.press('Tab'); await page.locator('#queue .queue-item').waitFor();
  const before = count('turn/start'); await page.locator('#stop').click();
  await page.locator('#queue .queue-note').filter({ hasText: '已暂停' }).waitFor();
  await page.waitForTimeout(300); assert.equal(count('turn/start'), before, 'interrupted turn does not drain the queue');
  await shot('08-queue-paused-dark-codex');
  ok('Stop pauses the queue with a visible reason; no automatic submission');

  assert.deepEqual(errors, []); ok('No page errors');
} finally {
  await writeFile(path.join(shots, 'checks.json'), JSON.stringify({ checks, errors }, null, 2));
  await browser.close(); await app.close?.(); client.close(); await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(`${checks.length} checks passed; screenshots in ${shots}`);
process.exit(0);
