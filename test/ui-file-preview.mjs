// Isolated demo fixtures, real HTTP file preview and Chrome's mobile layout. No model calls.
// NODE_PATH=.tmp/visual-runtime/node_modules CHROMIUM_PATH=<Chrome executable> node test/ui-file-preview.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
const {chromium} = createRequire(import.meta.url)('playwright');
const temporary = await fs.mkdtemp(path.join(process.cwd(), '.tmp', 'file-preview-ui-')), root = path.join(temporary, 'project'); await fs.mkdir(root);
const filename = path.join(root, '测试 文件.md'), missing = path.join(root, 'missing.txt'), imagePath = path.join(root, 'image.png');
const text = '# 文件正文\n这是要定位的第二行\n<script>window.filePreviewExecuted=true</script>\n' + 'long code '.repeat(60);
await fs.writeFile(filename, text);
await fs.writeFile(path.join(temporary, 'outside.txt'), 'outside');
await fs.writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64'));
const client = new DemoClient(), {thread} = await client.call('thread/start', {cwd: root}); thread.name = '文件预览回归';
const childRoot = path.join(temporary, 'child-project'); await fs.mkdir(childRoot); await fs.writeFile(path.join(childRoot, 'child.txt'), 'native child preview');
const {thread: child} = await client.call('thread/start', {cwd: childRoot}); child.name = '原生子代理';
const childItem = {id: 'child-answer', type: 'agentMessage', text: '[子代理文件](child.txt:1)'};
client.turns.set(child.id, [{id: 'child-turn', status: 'completed', items: [childItem]}]); client.items.set(child.id, [{turnId: 'child-turn', item: childItem}]);
const item = {id: 'fixture-answer', type: 'agentMessage', text: `[预览文档](<${filename}:2>)\n\n[图片](<${imagePath}>)\n\n[尚未生成](<${missing}>)\n\n[目录外文件](<${path.join(temporary, 'outside.txt')}>)`};
const activity = {id: 'child-event', type: 'subAgentActivity', kind: 'completed', agentThreadId: child.id, agentPath: '/root/preview-child'};
client.turns.set(thread.id, [{id: 'fixture-turn', status: 'completed', items: [item, activity]}]); client.items.set(thread.id, [item, activity].map(item => ({turnId: 'fixture-turn', item})));
const app = await createServer({demo: true, client, cwd: root, projectStore: {list: async () => ({projects: [{id: 'fixture-project', path: root}], selectedId: 'fixture-project'}), queue: Promise.resolve()}, fileAttachmentRoot: path.join(temporary, 'attachments')});
await app.started;
let browser;
const results = [], errors = [];
async function check(name, run) {await run(); results.push(name); console.log('PASS ' + name);}
try {
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH});
  const page = await browser.newPage({viewport: {width: 320, height: 740}, isMobile: true, hasTouch: true});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator('#connection-text').filter({hasText: '演示模式'}).waitFor({state: 'attached'});
  if (await page.locator('#rail-sidebar').getAttribute('aria-expanded') !== 'true') await page.locator('#rail-sidebar').click();
  await page.locator('.project-group-thread').filter({hasText: '文件预览回归'}).click();
  const link = page.getByRole('button', {name: new RegExp('文件 .*测试 文件.md')});
  const dialog = page.locator('.file-preview');
  await check('mobile markdown link fetches host text, focuses line and never executes HTML', async () => {
    await link.click(); await dialog.locator('.file-preview-source').filter({hasText: '这是要定位的第二行'}).waitFor();
    assert.equal(await dialog.locator('.file-preview-row.is-selected').getAttribute('data-line'), '2');
    assert.equal(await dialog.locator('script,iframe').count(), 0); assert.equal(await page.evaluate(() => window.filePreviewExecuted), undefined);
    const bounds = await dialog.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await dialog.locator('.file-preview-stage').evaluate(node => node.scrollWidth > node.clientWidth), true, 'long source scrolls inside its preview');
    await page.screenshot({path: path.join(process.cwd(), '.tmp', 'file-preview-320.png')});
    await dialog.getByRole('button', {name: '关闭文件预览'}).click();
    assert.equal(await link.evaluate(node => document.activeElement === node), true);
  });
  await check('images preview as passive images inside the mobile dialog', async () => {
    await page.getByRole('button', {name: new RegExp('文件 .*image.png')}).click();
    await dialog.locator('img').waitFor(); await page.waitForFunction(() => document.querySelector('.file-preview-image')?.naturalWidth === 1);
    assert.match(await dialog.locator('img').getAttribute('src'), /^data:image\/png;base64,/);
    await dialog.getByRole('button', {name: '关闭文件预览'}).click();
  });
  await check('missing files show an error and retry reads a newly available file', async () => {
    await page.getByRole('button', {name: new RegExp('文件 .*missing.txt')}).click();
    await dialog.getByRole('alert').filter({hasText: '文件不存在'}).waitFor();
    await fs.writeFile(missing, 'retry succeeded'); await dialog.getByRole('button', {name: '重试', exact: true}).click();
    await dialog.locator('.file-preview-source').filter({hasText: 'retry succeeded'}).waitFor();
    await dialog.getByRole('button', {name: '关闭文件预览'}).click();
  });
  await check('explicit outside-project local links preview without an extra confirmation', async () => {
    await page.getByRole('button', {name: new RegExp('文件 .*outside.txt')}).click();
    await dialog.locator('.file-preview-source').filter({hasText: 'outside'}).waitFor();
    assert.equal(await dialog.getByRole('alert').count(), 0);
    await page.keyboard.press('Escape'); assert.equal(await dialog.evaluate(node => node.open), false);
  });
  await check('loading is immediate, superseded and closed requests cannot replace current content', async () => {
    const result = await page.evaluate(async () => {
      const {createFilePreview} = await import('/ui/file-preview.js'); const pending = [];
      const viewer = createFilePreview({document, fetchPreview: (input, {signal}) => new Promise(resolve => pending.push({input, signal, resolve}))});
      const first = viewer.open({fullPath: 'first.txt'}, {threadId: 'fixture'});
      const modal = [...document.querySelectorAll('.file-preview')].at(-1);
      const loading = modal.textContent.includes('正在读取电脑上的文件') && modal.querySelector('[aria-busy="true"]') !== null;
      const second = viewer.open({fullPath: 'second.txt'}, {threadId: 'fixture'});
      const payload = name => ({kind: 'text', text: name, startLine: 1, totalLines: 1, line: null, endLine: null});
      pending[1].resolve(payload('second')); await second; pending[0].resolve(payload('first')); await first;
      const secondWon = modal.querySelector('.file-preview-source').textContent === 'second';
      const cancelledFirst = pending[0].signal.aborted;
      const third = viewer.open({fullPath: 'third.txt'}, {threadId: 'fixture'}); viewer.close();
      pending[2].resolve(payload('third')); await third;
      const closed = !modal.open && !modal.querySelector('.file-preview-source') && pending[2].signal.aborted;
      viewer.destroy(); return {loading, secondWon, cancelledFirst, closed};
    });
    assert.deepEqual(result, {loading: true, secondWon: true, cancelledFirst: true, closed: true});
  });
  await check('file preview respects reduced motion on narrow screens', async () => {
    await page.evaluate(() => {document.documentElement.dataset.reducedMotion = 'true';}); await link.click();
    assert.equal(await dialog.evaluate(node => getComputedStyle(node).animationName), 'none');
    await dialog.getByRole('button', {name: '关闭文件预览'}).click();
  });
  await check('native child links use that child thread and working directory', async () => {
    await page.locator('.agent-lifecycle-event[data-item-id="child-event"]').click();
    const childLink = page.locator('.agent-detail-content .md-file-link'); await childLink.waitFor();
    const response = page.waitForResponse(value => value.url().endsWith('/api/files/preview'));
    await childLink.click(); const preview = await response;
    assert.equal(preview.request().postDataJSON().threadId, child.id);
    assert.equal(preview.request().postDataJSON().path, path.join(childRoot, 'child.txt'));
    await dialog.locator('.file-preview-source').filter({hasText: 'native child preview'}).waitFor();
    await dialog.getByRole('button', {name: '关闭文件预览'}).click();
  });
  assert.deepEqual(errors, []); console.log(JSON.stringify({passed: results.length, pageErrors: errors, checks: results}, null, 2));
} finally {await browser?.close(); await app.close(); await fs.rm(temporary, {recursive: true, force: true});}
