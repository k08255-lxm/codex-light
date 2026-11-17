// Real Chromium app regression: progress must preserve diff readers and delayed send acknowledgements.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { DemoClient } from '../src/demo.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = process.cwd(), out = path.join(root, '.tmp', 'diff-reading'); await mkdir(out, { recursive: true });
const temporary = await mkdtemp(path.join(out, 'session-')), client = new DemoClient(), original = client.call.bind(client);
const thread = (await original('thread/start', { cwd: root })).thread; thread.name = 'Diff reading fixture';
const sendThread = (await original('thread/start', { cwd: root })).thread; sendThread.name = 'Delayed acknowledgement fixture';
const source = '@@ -1 +1,120 @@\n-old\n' + Array.from({ length: 120 }, (_, i) => `+line ${i} ` + 'wide source '.repeat(15)).join('\n');
const file = { id: 'live-file', type: 'fileChange', status: 'inProgress', changes: [{ path: 'src/fixture.js', kind: { type: 'update' }, diff: source }] };
const turn = { id: 'diff-turn', status: 'inProgress', items: [file] };
client.turns.get(thread.id).push(turn); client.items.get(thread.id).push({ turnId: turn.id, item: file });
const answer = { id: 'old-answer', type: 'agentMessage', text: Array.from({ length: 35 }, (_, i) => `Reading paragraph ${i}. ` + 'Stable old text for reviewing during a delayed send. '.repeat(6)).join('\n\n') };
client.turns.get(sendThread.id).push({ id: 'old-turn', status: 'completed', items: [answer] }); client.items.get(sendThread.id).push({ turnId: 'old-turn', item: answer });
let releaseSend, sendStarted = false; const sendGate = new Promise(resolve => { releaseSend = resolve; });
client.call = async (method, params) => {
  if (method === 'turn/start' && params.threadId === sendThread.id) { sendStarted = true; await sendGate; }
  return original(method, params);
};
const app = await createServer({ client, demo: true, cwd: root, projectsRoot: path.join(temporary, 'projects'), desktopStateRoot: path.join(temporary, 'desktop'), fileAttachmentRoot: path.join(temporary, 'attachments') }); await app.started;
let browser, page; const checks = [], errors = [];
const emit = (method, data) => client.emit('event', { method, params: { threadId: thread.id, turnId: turn.id, ...data } });
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const width = Number(process.env.SCROLL_VIEWPORT_WIDTH) || 1280, mobile = width < 760;
  page = await browser.newPage({ viewport: { width, height: 850 }, isMobile: mobile, hasTouch: mobile }); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  if (mobile) await page.addInitScript(() => { window.CodexLightNative = { isNativeApp: () => true, setToolbarIntegrated() {} }; });
  const openThread = async name => { if (mobile) await page.locator('#rail-sidebar').click(); await page.locator('.project-group-thread').filter({ hasText: name }).click(); };
  await page.goto(app.url); await openThread(thread.name);
  await page.locator('.turn-process > summary').click(); await page.locator('[data-item-id="live-file"] > summary').click();
  const running = page.locator('[data-item-id="live-file"] .diff-view'); await running.waitFor();
  const mark = async locator => locator.evaluate(node => { node.scrollTop = 440; node.scrollLeft = 210; window.readingDiff = node; return { top: node.scrollTop, left: node.scrollLeft }; });
  const check = async (locator, saved, label) => {
    const value = await locator.evaluate(node => ({ same: node === window.readingDiff, top: node.scrollTop, left: node.scrollLeft }));
    assert.equal(value.same, true, label + ': same diff node'); assert.equal(value.top, saved.top, label + ': vertical position'); assert.equal(value.left, saved.left, label + ': horizontal position');
  };
  const saved = await mark(running); assert.ok(saved.top > 400 && saved.left > 200, 'fixture scrolls both axes');
  const progress = { id: 'progress', type: 'commandExecution', command: 'synthetic progress', status: 'inProgress', aggregatedOutput: 'one' };
  turn.items.push(progress); client.items.get(thread.id).push({ turnId: turn.id, item: progress }); emit('item/started', { item: progress });
  await page.waitForTimeout(220); await check(running, saved, 'unrelated progress');
  emit('item/started', { item: file }); await page.waitForTimeout(220); await check(running, saved, 'same file status refresh');
  file.changes = [{ ...file.changes[0], diff: source + '\n+appended real diff' }]; emit('item/fileChange/patchUpdated', { itemId: file.id, changes: file.changes });
  await page.waitForTimeout(220); await check(running, saved, 'actual changed diff'); assert.ok((await running.textContent()).includes('appended real diff'), 'real patch update is rendered');
  checks.push('open operation diff retains node and both scroll axes through unrelated progress, status refresh and real diff updates');

  file.status = 'completed'; progress.status = 'completed'; turn.status = 'completed'; emit('item/completed', { item: file }); emit('item/completed', { item: progress }); emit('turn/completed', { turn });
  await page.locator('.files-card .file-row-head').click(); const completed = page.locator('.files-card .diff-view'); await completed.waitFor();
  const completedSaved = await mark(completed); file.changes = [{ ...file.changes[0], diff: file.changes[0].diff + '\n+corrected final diff' }]; emit('item/completed', { item: file });
  await page.waitForTimeout(220); await check(completed, completedSaved, 'corrected completed diff'); assert.ok((await completed.textContent()).includes('corrected final diff'), 'final correction is rendered');
  checks.push('completed file-summary diff retains node and both scroll axes after correction');

  await openThread(sendThread.name); await page.locator('[data-item-id="old-answer"]').waitFor();
  await page.locator('#prompt').fill('Delayed acknowledgement regression'); await page.locator('#send').click();
  for (let i = 0; i < 40 && !sendStarted; i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(sendStarted, 'send reaches gated RPC');
  const box = await page.locator('#conversation').boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -430); await page.waitForTimeout(180);
  const anchor = () => page.locator('#conversation').evaluate(c => {
    const top = c.getBoundingClientRect().top;
    const node = [...c.querySelectorAll('.markdown-segment p')].find(n => { const r = n.getBoundingClientRect(); return r.bottom > top && r.top < top + c.clientHeight; });
    return { text: node?.textContent, offset: node?.getBoundingClientRect().top - top };
  });
  const before = await anchor(); assert.ok(before.text?.startsWith('Reading paragraph'), 'reading existing history while send awaits'); releaseSend();
  await page.waitForTimeout(950); const after = await anchor(); assert.equal(after.text, before.text, 'delayed acknowledgement keeps reading paragraph'); assert.ok(Math.abs(after.offset - before.offset) < 3, 'delayed acknowledgement keeps reading offset');
  checks.push('delayed turn acknowledgement and subsequent output do not pull a manually scrolled reader to bottom');
  assert.deepEqual(errors, []); await page.screenshot({ path: path.join(out, `reading-${width}.png`) }); console.log(JSON.stringify({ width, checks, pageErrors: errors }, null, 2));
} catch (error) { if (page) await page.screenshot({ path: path.join(out, `failure.png`) }); console.error(JSON.stringify({ checks, errors })); throw error; }
finally { releaseSend(); await browser?.close(); await app.close(); await rm(temporary, { recursive: true, force: true }); }
