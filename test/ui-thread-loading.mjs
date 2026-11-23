// Exercise navigation through the real sidebar with controlled, read-only demo responses.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';

const {chromium} = createRequire(import.meta.url)('playwright');
const client = new DemoClient(), call = client.call.bind(client);
const threads = [];
for (const name of ['Fast history', 'Slow history', 'Other history']) {
  const {thread} = await call('thread/start', {cwd:process.cwd()});
  thread.name = name;
  threads.push(thread);
}
const [fast, slow, other] = threads, holds = new Map();
client.call = async (method, params) => {
  if (method === 'thread/read') await holds.get(params.threadId)?.promise;
  return call(method, params);
};
function hold(thread) {
  const gate = Promise.withResolvers();
  holds.set(thread.id,gate);
  return error => { holds.delete(thread.id); if (error) gate.reject(new Error(error)); else gate.resolve(); };
}
const app = await createServer({client,demo:true});
await app.started;
let browser;
try {
  browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(app.url);
  const select = thread => page.locator('.project-group-thread').filter({hasText:thread.name}).click();
  const settled = name => page.waitForFunction(name =>
    document.querySelector('#thread-title').textContent === name &&
    document.querySelector('#conversation').ariaBusy === 'false', name);
  const indicator = page.locator('#thread-load-indicator');
  await page.locator('.project-group-thread').filter({hasText:fast.name}).waitFor();
  await indicator.evaluate(node=>{
    window.indicatorShows = 0;
    new MutationObserver(records=>{
      for (const r of records) if (r.oldValue === null) window.indicatorShows++;
    }).observe(node,{attributes:true,attributeOldValue:true,attributeFilter:['data-visible']});
  });
  await select(fast);
  await settled(fast.name);
  assert.equal(await page.evaluate(()=>window.indicatorShows),0);

  await page.locator('#prompt').fill('draft');
  const composer = page.locator('#compose'), title = page.locator('#thread-title');
  const before = await Promise.all([composer.boundingBox(),title.boundingBox()]);
  let release = hold(slow);
  await select(slow);
  await indicator.waitFor({state:'visible'});
  assert.deepEqual(await Promise.all([composer.boundingBox(),title.boundingBox()]),before);
  assert.equal(await page.locator('#conversation').getAttribute('aria-busy'),'true');
  assert.equal(await page.locator('#send').isDisabled(),true);
  assert.equal(await page.locator('#send-state').isVisible(),false);
  assert.doesNotMatch(await page.locator('#activity').innerText(),/加载|载入|恢复/);
  assert.match(await page.locator('#thread-open-status').innerText(),/Slow history/);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>document.documentElement.dataset.reducedMotion==='true');
  assert.equal(await indicator.evaluate(n=>getComputedStyle(n).animationName),'none');
  release();
  await settled(slow.name);
  assert.equal(await indicator.isVisible(),false);
  assert.equal(await page.locator('#send').isEnabled(),true);

  release = hold(fast);
  await select(fast);
  await indicator.waitFor({state:'visible'});
  release('指定的历史读取失败');
  await page.locator('#notice').filter({hasText:'指定的历史读取失败'}).waitFor();
  await settled(slow.name);
  assert.equal(await indicator.isVisible(),false);
  await page.locator('#dismiss-notice').click();
  await select(fast);
  await settled(fast.name);

  release = hold(slow);
  await select(slow);
  await indicator.waitFor({state:'visible'});
  await select(other);
  await settled(other.name);
  const late = page.waitForResponse(r=>r.url().endsWith('/api/rpc')&&r.request().postDataJSON()?.method==='thread/read'&&r.request().postDataJSON().params.threadId===slow.id);
  release('过时的读取失败');
  await late;
  await page.waitForTimeout(320);
  assert.equal(await title.innerText(),other.name);
  assert.equal(await indicator.isVisible(),false);
  assert.doesNotMatch(await page.locator('#notice').textContent(),/过时的读取失败/);

  release = hold(slow);
  await select(slow);
  await indicator.waitFor({state:'visible'});
  await page.locator('#new-thread').click();
  await settled('新对话');
  release();
  await page.waitForTimeout(320);
  assert.equal(await title.innerText(),'新对话');
  assert.equal(await indicator.isVisible(),false);
  release = hold(slow);
  await select(slow);
  await indicator.waitFor({state:'visible'});
  client.connected = false;
  client.emit('event',{method:'bridge/status',params:{connected:false}});
  await settled('新对话');
  assert.equal(await indicator.isVisible(),false);
  assert.equal(await page.locator('#send-state-action').innerText(),'重新检查连接');
  release('连接已断开');
  client.connected = true;
  client.emit('event',{method:'bridge/status',params:{connected:true}});
  await page.waitForFunction(()=>document.querySelector('#connection-dot').classList.contains('ok'));
  await select(slow);
  await settled(slow.name);
  assert.equal(await indicator.isVisible(),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: fast/slow navigation, layout, send gate, reduced motion, errors/retry, stale reads, new draft and reconnect');
} finally {
  for (const gate of holds.values()) gate.resolve();
  await browser?.close();
  await app.close();
}
