// Run explicitly with Playwright and Chromium. All model calls use the local demo.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { DemoClient } from '../src/demo.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const client = new DemoClient();
let browser, app, root;
function configuredDefaults(cwd) {
  if (cwd === path.join(root, 'Active')) return { model: 'demo-six', reasoningEffort: 'high' };
  if (cwd === path.join(root, 'Older')) return { model: 'demo-five', reasoningEffort: 'ultra' };
  return {};
}
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codex-light-draft-ui-'));
  const call = client.call.bind(client);
  client.call = (method, params) => {
    if (method === 'thread/start' && !params.model) {
      const { model } = configuredDefaults(params.cwd);
      if (model) return call(method, { ...params, model });
    }
    return call(method, params);
  };
  app = await createServer({ client, demo: true, projectsRoot: path.join(root, 'state') });
  await app.started;
  for (const name of ['Older', 'Pinned', 'Active']) {
    const cwd = path.join(root, name);
    await mkdir(cwd);
    const saved = await app.projectStore.add(cwd, false);
    if (name === 'Pinned') await app.projectStore.updateMetadata(saved.selectedId, { pinned: true });
    if (name === 'Active') {
      const { thread } = await client.call('thread/start', { cwd, model: 'demo' });
      thread.name = 'Historical conversation';
      thread.reasoningEffort = 'high';
    }
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
});
after(async () => {
  await browser?.close();
  await app?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
async function draftPage(t, width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(6000);
  t.after(() => page.close());
  return page;
}
async function open(t, width = 1440) {
  const page = await draftPage(t, width);
  await page.goto(app.url);
  await page.waitForFunction(() => document.querySelector('#model option[value="demo-six"]'));
  return page;
}
async function chooseProject(page, name) {
  await page.locator('#cwd-button').click();
  await page.locator('#project-choices').getByRole('button', { name, exact: true }).click();
  await page.locator('#cwd-label').getByText(name, { exact: true }).waitFor();
}
async function sendDraft(page, message) {
  await page.locator('#prompt').fill(message);
  const sent = page.waitForResponse(response => response.url().endsWith('/api/rpc') &&
    response.request().postDataJSON()?.method === 'turn/start');
  await page.locator('#send').click();
  const response = await sent;
  assert.ok(response.ok(), await response.text());
  return response.request().postDataJSON().params;
}

test('new drafts and reload restore the chosen model and effort, independently of history', async t => {
  const page = await open(t);
  await page.locator('#model-trigger').click();
  await page.locator('#model-list-open').click();
  await page.getByRole('button', { name: '演示六档模型（不调用 AI）' }).click();
  await page.locator('#reasoning-range').press('End');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#effort').inputValue(), 'ultra');
  await page.locator('#new-thread').click();
  assert.equal(await page.locator('#effort').inputValue(), 'ultra');
  await page.getByRole('button', { name: 'Historical conversation', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#reasoning-label').textContent === '高');
  assert.equal(await page.locator('#effort').inputValue(), '');
  await page.keyboard.press('Control+n');
  assert.equal(await page.locator('#model').inputValue(), 'demo-six');
  assert.equal(await page.locator('#effort').inputValue(), 'ultra');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#model').value === 'demo-six');
  assert.equal(await page.locator('#effort').inputValue(), 'ultra');
  await page.getByRole('region', { name: 'Active', exact: true }).getByRole('button', { name: '新建聊天' }).click();
  await page.waitForFunction(() => document.querySelector('#cwd-label').textContent === 'Active');
  await page.locator('#prompt').fill('Verify first turn');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#messages .turn'));
  assert.equal(client.modelTurns.at(-1)?.effort, 'ultra');
});

test('automatic mode gates a pending project default and restores its override only for the matching model', async t => {
  const page = await draftPage(t);
  const older = path.join(root, 'Older');
  await page.addInitScript(cwd => sessionStorage.setItem('codex-light-cwd', cwd), path.join(root, 'Active'));
  await page.route('**/api/status', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), demo: false } });
  });
  let releaseOlder;
  const olderDefaults = new Promise(resolve => { releaseOlder = resolve; });
  await page.route('**/api/session/defaults', async route => {
    const { cwd } = route.request().postDataJSON();
    if (cwd === older) await olderDefaults;
    await route.fulfill({ json: configuredDefaults(cwd) });
  });
  await page.goto(app.url);
  await page.waitForFunction(() => document.querySelector('#model-trigger').textContent.includes('演示六档模型') &&
    document.querySelector('#model option[value="demo-six"]'));
  assert.equal(await page.locator('#model').inputValue(), '');
  assert.equal(await page.locator('#effort').inputValue(), '');
  await page.locator('#model-trigger').click();
  await page.locator('#reasoning-range').press('End');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#effort').inputValue(), 'ultra');
  try {
    await chooseProject(page, 'Older');
    await page.locator('#prompt').fill('Different configured model');
    assert.equal(await page.locator('#send').isDisabled(), true);
    assert.match(await page.locator('#send-state-text').textContent(), /恢复新对话的模型和思考强度/);
    assert.equal(await page.locator('#effort').inputValue(), '');
  } finally { releaseOlder(); }
  await page.waitForFunction(() => document.querySelector('#reasoning-label').title.includes('不在当前模型支持范围'));
  const onOlder = await sendDraft(page, 'Different configured model');
  assert.equal(Object.hasOwn(onOlder, 'model'), false);
  assert.equal(Object.hasOwn(onOlder, 'effort'), false);
  assert.equal(client.modelTurns.at(-1)?.model, 'demo-five');
  await page.locator('#new-thread:enabled').waitFor();
  await chooseProject(page, 'Active');
  await page.waitForFunction(() => document.querySelector('#effort').value === 'ultra');
  const onActive = await sendDraft(page, 'Restore original configured model override');
  assert.equal(Object.hasOwn(onActive, 'model'), false);
  assert.equal(onActive.effort, 'ultra');
  assert.equal(client.modelTurns.at(-1)?.model, 'demo-six');
});

test('a legacy model-only preference waits for the catalog and sends no effort override', async t => {
  const page = await draftPage(t);
  await page.addInitScript(() => localStorage.setItem('codex-light-model', 'demo-five'));
  let releaseModelList;
  const modelList = new Promise(resolve => { releaseModelList = resolve; });
  const requests = [];
  await page.route('**/api/rpc', async route => {
    const { method, params } = route.request().postDataJSON();
    if (['thread/start', 'turn/start'].includes(method)) requests.push({ method, params });
    if (method === 'model/list') await modelList;
    await route.continue();
  });
  try {
    const pending = page.waitForRequest(request => request.url().endsWith('/api/rpc') && request.postDataJSON()?.method === 'model/list');
    await page.goto(app.url);
    await pending;
    await page.locator('#prompt').fill('Restore old model');
    assert.equal(await page.locator('#send').isDisabled(), true);
    await page.locator('#prompt').press('Enter');
    assert.equal(await page.locator('#prompt').inputValue(), 'Restore old model');
    assert.deepEqual(requests, []);
  } finally { releaseModelList(); }
  await page.waitForFunction(() => document.querySelector('#model').value === 'demo-five');
  const sent = await sendDraft(page, 'Restore old model');
  assert.equal(requests.find(request => request.method === 'thread/start').params.model, 'demo-five');
  assert.equal(sent.model, 'demo-five');
  assert.equal(Object.hasOwn(sent, 'effort'), false);
});

test('a saved effort no longer supported by the same model is omitted on first send', async t => {
  const page = await draftPage(t);
  await page.addInitScript(() => localStorage.setItem('codex-light-draft-model', JSON.stringify({
    model: 'demo-five', effortModel: 'demo-five', effort: 'ultra'
  })));
  await page.goto(app.url);
  await page.waitForFunction(() => document.querySelector('#model').value === 'demo-five');
  assert.equal(await page.locator('#effort').inputValue(), '');
  const sent = await sendDraft(page, 'Unsupported saved effort');
  assert.equal(sent.model, 'demo-five');
  assert.equal(Object.hasOwn(sent, 'effort'), false);
});

test('project picker matches the pinned and active order in the conversation sidebar', async t => {
  const page = await open(t);
  await page.getByRole('button', { name: 'Historical conversation', exact: true }).waitFor();
  const sidebar = await page.locator('.project-group-select:visible').allTextContents();
  assert.deepEqual(sidebar, ['Pinned', 'Active', 'Older']);
  await page.locator('#cwd-button').click();
  const choices = await page.locator('#project-choices button').allTextContents();
  assert.deepEqual(choices.filter(name => name !== '无项目'), sidebar);
  assert.ok(choices.includes('无项目'));
  const older = page.locator('#project-choices').getByRole('button', { name: 'Older', exact: true });
  await older.click();
  await page.locator('#project-dialog').waitFor({ state: 'hidden' });
  await page.locator('#cwd-button').click();
  assert.equal(await older.getAttribute('aria-pressed'), 'true');
  assert.equal(await older.evaluate(button => button === document.activeElement), true);
  assert.deepEqual(await page.locator('#project-choices button').allTextContents(), choices);
});

test('usage loading and data share their horizontal bounds and responsive column count', async t => {
  const page = await open(t, 1680);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/statistics/query', async route => { await gate; await route.continue(); });
  await page.locator('#rail-usage').click();
  const placeholder = page.locator('.stats-loading-placeholder');
  // Compare within one frame even when the sidebar is animating.
  const checkBounds = async selector => {
    const [actual, header] = await page.evaluate(selector => [selector, '#stats-root .page-head'].map(s => {
      const { left, right } = document.querySelector(s).getBoundingClientRect();
      return [left, right];
    }), selector);
    assert.deepEqual(actual, header);
  };
  const columns = locator => locator.evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
  try {
    await placeholder.waitFor();
    await checkBounds('.stats-loading-placeholder');
    await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().width === 0);
    await checkBounds('.stats-loading-placeholder');
    await checkBounds('#stats-root > .page-status');
    assert.equal(await columns(placeholder), 4);
    await page.setViewportSize({ width: 720, height: 900 });
    assert.equal(await columns(placeholder), 2);
  } finally { release(); }
  await placeholder.waitFor({ state: 'hidden' });
  assert.equal(await columns(page.locator('.kpi-row')), 2);
  await page.setViewportSize({ width: 1680, height: 900 });
  await checkBounds('.stats-overview');
});
