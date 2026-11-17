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
const app = await createServer({ client, demo: true, cwd: root, projectsRoot: path.join(temporary, 'projects'), desktopStateRoot: path.join(temporary, 'desktop'), fileAttachmentRoot: path.join(temporary, 'attachments') }); await app.started;
let browser, page; const checks = [], errors = [];
const emit = (method, data) => client.emit('event', { method, params: { threadId: thread.id, turnId: turn.id, ...data } });
function append(text) { live.text += text; emit('item/agentMessage/delta', { itemId: live.id, delta: text }); }
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const width = Number(process.env.SCROLL_VIEWPORT_WIDTH) || 1280, mobile = width < 760;
  page = await browser.newPage({ viewport: { width, height: 850 }, isMobile: mobile, hasTouch: mobile }); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  if (mobile) await page.addInitScript(() => { window.CodexLightNative = { isNativeApp: () => true, setToolbarIntegrated() {} }; });
  await page.goto(app.url); if (mobile) await page.locator('#rail-sidebar').click(); await page.locator('.project-group-thread').filter({ hasText: thread.name }).click();
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
  assert.deepEqual(errors, []); await page.screenshot({ path: path.join(out, `following-${width}.png`) }); console.log(JSON.stringify({ width, input: mobile ? 'touch' : 'wheel', checks, pageErrors: errors }, null, 2));
} catch (error) { if (page) await page.screenshot({ path: path.join(out, 'failure.png') }); console.error(JSON.stringify({ checks, errors })); throw error; }
finally { await browser?.close(); await app.close(); await rm(temporary, { recursive: true, force: true }); }
