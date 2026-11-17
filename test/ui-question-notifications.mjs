// Real Chromium app wiring; synthetic DemoClient events and a fake native bridge only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { DemoClient } from '../src/demo.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = process.cwd(), output = path.join(root, '.tmp', 'question-notifications');
await mkdir(output, { recursive: true }); const temporary = await mkdtemp(path.join(output, 'session-'));
const client = new DemoClient(), original = client.call.bind(client), errors = [], checks = [];
const first = (await original('thread/start', { cwd: root })).thread, second = (await original('thread/start', { cwd: root })).thread;
first.name = '历史提问测试'; second.name = '待处理请求测试';
const asyncItem = id => ({ id, type: 'agentMessage', delivery: 'async', text: '', questions: [{ title: 'Question notification browser fixture', options: [] }] });
const old = asyncItem('historical-question');
client.turns.set(first.id, [{ id: 'old-turn', status: 'completed', items: [old] }]); client.items.set(first.id, [{ turnId: 'old-turn', item: old }]);
let releaseAnswer, answerStarted = false;
const answerGate = new Promise(resolve => { releaseAnswer = resolve; });
client.call = async (method, params) => {
  if (method === 'turn/start' && params.input?.some(item => item.text?.includes('Question notification browser fixture'))) {
    answerStarted = true; await answerGate;
  }
  return original(method, params);
};
const app = await createServer({ client, demo: true, desktop: true, cwd: root,
  projectsRoot: path.join(temporary, 'projects'), desktopStateRoot: path.join(temporary, 'desktop'), fileAttachmentRoot: path.join(temporary, 'attachments') });
await app.started;
let browser, page;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  page = await browser.newPage({ viewport: { width: 1440, height: 920 } }); page.setDefaultTimeout(8000);
  await page.addInitScript(() => {
    window.nativeQuestionCalls = []; window.testForeground = true;
    document.hasFocus = () => window.testForeground;
    window.codexLightQuestionNotifications = Object.fromEntries(['show', 'clear', 'clearAll'].map(name => [name, async value => window.nativeQuestionCalls.push({ name, value })]));
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url); await page.locator('#connection-text').filter({ hasText: '演示模式' }).waitFor();
  await page.locator('.project-group-thread').filter({ hasText: first.name }).click();
  await page.locator('.async-input-card').waitFor();
  assert.equal(await page.locator('#question-alert').isVisible(), false);
  assert.equal(await page.evaluate(() => window.nativeQuestionCalls.filter(call => call.name === 'show').length), 0);
  checks.push('loading old async questions is quiet');

  const question = { id: 'browser-question', method: 'item/tool/requestUserInput', params: { threadId: second.id,
    questions: [{ id: 'answer', header: '说明', question: 'Browser question', isOther: false, isSecret: false, options: null }] } };
  client.requests.set(question.id, question); client.emit('event', question);
  await page.locator('#question-alert').waitFor(); await page.locator('.question-alert-open').click();
  await page.waitForFunction(name => document.querySelector('#thread-title').textContent === name, second.name);
  assert.equal(await page.locator('#approvals').evaluate(node => node.contains(document.activeElement)), true);
  assert.equal(await page.evaluate(() => window.nativeQuestionCalls.filter(call => call.name === 'show').length), 0);
  await page.locator('#approvals textarea').fill('Explicit answer'); await page.locator('#approvals button').filter({ hasText: '提交回答' }).click();
  await page.locator('#question-alert').waitFor({ state: 'hidden' });
  checks.push('foreground request banner navigates and focuses the real approval card');

  await page.evaluate(() => { window.testForeground = false; });
  const approval = { id: 'browser-approval', method: 'item/commandExecution/requestApproval', params: { threadId: second.id, command: 'echo private-command' } };
  client.requests.set(approval.id, approval); client.emit('event', approval); client.emit('event', approval);
  await page.waitForFunction(() => window.nativeQuestionCalls.filter(call => call.name === 'show').length === 1);
  assert.equal(await page.evaluate(() => JSON.stringify(window.nativeQuestionCalls).includes('private-command')), false);
  await page.evaluate(() => { window.testForeground = true; const call = window.nativeQuestionCalls.find(value => value.name === 'show'); window.dispatchEvent(new CustomEvent('codex-light-question-open', { detail: call.value })); });
  await page.waitForFunction(() => document.querySelector('#approvals').contains(document.activeElement));
  client.respond(approval.id); await page.locator('#question-alert').waitFor({ state: 'hidden' });
  checks.push('background approval requests notify once and native click returns to the request');

  await page.evaluate(() => { window.testForeground = false; });
  const live = asyncItem('live-question'), turn = { id: 'live-turn', status: 'completed', items: [live] };
  client.turns.get(first.id).push(turn); client.items.get(first.id).push({ turnId: turn.id, item: live });
  const event = method => ({ method, params: { threadId: first.id, turnId: turn.id, item: live } });
  client.emit('event', event('item/started')); client.emit('event', event('item/completed'));
  await page.waitForFunction(() => window.nativeQuestionCalls.filter(call => call.name === 'show').length === 2);
  await page.evaluate(() => { window.testForeground = true; }); await page.locator('.question-alert-open').click();
  await page.waitForFunction(id => document.querySelector(`[data-item-id="${id}"]`)?.contains(document.activeElement), live.id);
  checks.push('async started/completed deduplicate and banner locates the async question');

  await page.locator('#rail-settings').click(); await page.locator('[data-settings-section="notifications"]').click();
  await page.locator('#preference-approval').uncheck(); await page.locator('#question-alert').waitFor({ state: 'hidden' });
  await page.locator('#preference-approval').check(); await page.locator('#question-alert').waitFor();
  assert.equal(await page.evaluate(() => window.nativeQuestionCalls.filter(call => call.name === 'show').length), 2);
  checks.push('notification preference immediately hides and restores the banner without replaying system alerts');

  await page.locator('.question-alert-open').click();
  const liveCard = page.locator(`[data-item-id="${live.id}"] .async-input-card`);
  await liveCard.locator('textarea').fill('Confirmed browser answer'); await liveCard.locator('button').filter({ hasText: '发送回答' }).click();
  await liveCard.locator('button').filter({ hasText: '正在发送' }).waitFor();
  assert.equal(await page.locator('#question-alert').isVisible(), true, 'pending send keeps reminder');
  await page.screenshot({ path: path.join(output, 'pending-answer.png') });
  assert.equal(answerStarted, true); releaseAnswer();
  await page.locator('#question-alert').waitFor({ state: 'hidden' });
  client.emit('event', event('item/completed'));
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#question-alert').isVisible(), false);
  assert.equal(await page.evaluate(() => window.nativeQuestionCalls.filter(call => call.name === 'show').length), 2);
  checks.push('async reminder remains during send and only clears after confirmed success; late replay stays cleared');
  assert.deepEqual(errors, []); console.log(JSON.stringify({ checks, pageErrors: errors }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') });
    console.error(JSON.stringify({ checks, answerStarted, pageErrors: errors,
      liveCard: await page.locator('[data-item-id="live-question"]').textContent().catch(() => ''),
      notice: await page.locator('#notice').textContent().catch(() => '') }, null, 2));
  }
  throw error;
} finally {
  releaseAnswer(); await browser?.close(); await app.close(); await rm(temporary, { recursive: true, force: true });
}
