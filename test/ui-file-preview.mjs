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
const relativeFolder = 'artifacts/settings-motion', folder = path.join(root, relativeFolder);
await fs.mkdir(folder, {recursive:true});
const screenshot = path.join(folder, '设置 截图.png');
const screenshotBytes = await fs.readFile(process.env.FILE_PREVIEW_TEST_PNG || imagePath);
await fs.writeFile(screenshot, screenshotBytes); await fs.writeFile(path.join(childRoot, '子 截图.png'), screenshotBytes);
const screenshotWidth = screenshotBytes.readUInt32BE(16), screenshotHeight = screenshotBytes.readUInt32BE(20);
const doc = path.join(folder, '说明.pdf'), pdf = Buffer.from('%PDF-1.4\n%\x00\xff\n%%EOF', 'latin1');
await fs.writeFile(doc, pdf);
const childDocs=path.join(childRoot,'docs');await fs.mkdir(childDocs);await fs.writeFile(path.join(childDocs,'report.pdf'),pdf);
await fs.mkdir(path.join(childRoot,'artifacts'));
const slashPath = value => (process.platform === 'win32' ? '/' : '') + value.split(path.sep).join('/');
const {thread: child} = await client.call('thread/start', {cwd: childRoot}); child.name = '原生子代理';
const childItem = {id: 'child-answer', type: 'agentMessage', text: '[子代理文件](child.txt:1)\n\n![子代理截图](子%20截图.png)'};
client.turns.set(child.id, [{id: 'child-turn', status: 'completed', items: [childItem]}]); client.items.set(child.id, [{turnId: 'child-turn', item: childItem}]);
const item = {id: 'fixture-answer', type: 'agentMessage', text: `[预览文档](<${filename}:2>)\n\n[图片](<${imagePath}>)\n\n[尚未生成](<${missing}>)\n\n[目录外文件](<${path.join(temporary, 'outside.txt')}>)`};
const activity = {id: 'child-event', type: 'subAgentActivity', kind: 'completed', agentThreadId: child.id, agentPath: '/root/preview-child'};
item.text += '\n\n[截图目录](<' + slashPath(folder) + '>)\n\n![设置截图](<' + encodeURI(slashPath(screenshot)) + '>)\n\n[说明文档](<' + slashPath(doc) + '>)\n\n![外部图片](https://example.invalid/external.png)';
const ordinaryScreenshot=process.env.FILE_PREVIEW_TEST_PNG||screenshot;
item.text+='\n\n[普通截图](<'+slashPath(ordinaryScreenshot)+'>)';
const memoryImage={id:'inline-png',type:'imageGeneration',status:'completed',result:screenshotBytes.toString('base64')};
const childReply={id:'child-projection',type:'collabAgentToolCall',status:'completed',tool:'wait',receiverThreadIds:[child.id],agentsStates:{[child.id]:{status:'completed',message:'[相对报告](./docs/report.pdf) [相对目录](./artifacts/)'}}};
client.turns.set(thread.id, [{id: 'fixture-turn', status: 'completed', items: [item, memoryImage, activity, childReply]}]); client.items.set(thread.id, [item, memoryImage, activity, childReply].map(item => ({turnId: 'fixture-turn', item})));
const app = await createServer({demo: true, client, cwd: root, projectStore: {list: async () => ({projects: [{id: 'fixture-project', path: root}], selectedId: 'fixture-project'}), queue: Promise.resolve()}, fileAttachmentRoot: path.join(temporary, 'attachments')});
await app.started;
let browser;
const results = [], errors = [];
async function check(name, run) {await run(); results.push(name); console.log('PASS ' + name);}
try {
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH});
  const page = await browser.newPage({viewport: {width: 320, height: 740}, isMobile: true, hasTouch: true});
  const external = []; page.on('request', request => {if (request.url().includes('example.invalid')) external.push(request.url());});
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
    const lightbox=page.locator('.lightbox');
    await page.waitForFunction(() => document.querySelector('.lightbox img')?.naturalWidth === 1);
    assert.match(await lightbox.locator('img').getAttribute('src'), /^data:image\/png;base64,/);
    assert.equal(await lightbox.getByRole('button',{name:'用默认应用打开'}).count(),0);
    await lightbox.getByRole('button', {name: '关闭预览'}).click();
  });
  await check('missing files show an error and retry reads a newly available file', async () => {
    await page.getByRole('button', {name: new RegExp('文件 .*missing.txt')}).click();
    await dialog.getByRole('alert').filter({hasText: '文件不存在'}).waitFor();
    await fs.writeFile(missing, 'retry succeeded'); await dialog.getByRole('button', {name: '重试', exact: true}).click();
    await dialog.locator('.file-preview-source').filter({hasText: 'retry succeeded'}).waitFor();
    await dialog.getByRole('button', {name: '关闭文件预览'}).click();
  });
  await check('folder lists real files and returns after previewing and downloading them', async () => {
    await page.locator('#messages .md-file-link').filter({hasText:'截图目录'}).click();
    await dialog.getByRole('button', {name:'文件 设置 截图.png'}).click();
    const lightbox=page.locator('.lightbox');
    const size = await lightbox.locator('img').evaluate(async img => {await img.decode(); return [img.naturalWidth, img.naturalHeight];});
    assert.deepEqual(size, [screenshotWidth,screenshotHeight]);
    await lightbox.getByRole('button',{name:'关闭预览'}).click();
    await dialog.getByRole('button', {name:'文件 说明.pdf'}).click();
    const downloading = page.waitForEvent('download');
    await dialog.getByRole('button',{name:'保存文件'}).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(),'说明.pdf');
    assert.deepEqual(await fs.readFile(await download.path()),pdf);
    await dialog.getByRole('button',{name:'关闭文件预览'}).click();
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
    const event = page.locator('.agent-lifecycle-event[data-item-id="child-event"]');
    await page.locator('.turn-work').filter({has:event}).locator(':scope > summary').click();
    await event.click();
    const childLink = page.locator('.agent-detail-content .md-file-link').filter({hasText:'子代理文件'}); await childLink.waitFor();
    const response = page.waitForResponse(value => value.url().endsWith('/api/files/preview'));
    await childLink.click(); const preview = await response;
    assert.equal(preview.request().postDataJSON().threadId, child.id);
    assert.equal(preview.request().postDataJSON().path, path.join(childRoot, 'child.txt'));
    await dialog.locator('.file-preview-source').filter({hasText: 'native child preview'}).waitFor();
    await dialog.getByRole('button', {name: '关闭文件预览'}).click();
  });
  await check('desktop capture hook sends directories and documents to native and lets main and child images open', async () => {
    const desktop = await browser.newPage({viewport:{width:1280,height:900}});
    try {
      desktop.on('pageerror', error => errors.push(error.message));
      const source = await fs.readFile(new URL('../desktop/LocalPathLinks.cs', import.meta.url), 'utf8');
      const script = source.split('internal const string ClickScript = """')[1].split('""";')[0];
      await desktop.addInitScript({content: 'window.posted=[];window.chrome=window.chrome||{};window.chrome.webview={postMessage:m=>posted.push(m),addEventListener(){},removeEventListener(){}};' + script});
      await desktop.goto(app.url);
      await desktop.locator('.project-group-thread').filter({hasText:'文件预览回归'}).click();
      const main = desktop.locator('#messages .md-file-link');
      for (const [label, file] of [['截图目录', folder],['说明文档', doc]]) {
        await main.filter({hasText:label}).click();
        assert.deepEqual(await desktop.evaluate(()=>posted.filter(m=>m.type==='revealLocalPath').at(-1)),{type:'revealLocalPath',path:slashPath(file)});
      }
      const show = async (button,file) => {
        await button.click();
        const dialog = desktop.locator('.lightbox');
        const dimensions=await dialog.locator('img').evaluate(async img=>{await img.decode();return [img.naturalWidth,img.naturalHeight];});
        assert.deepEqual(dimensions,[screenshotWidth,screenshotHeight]);
        for(const [label,action] of [['在资源管理器中显示','reveal'],['用默认应用打开','open']]){
          const count=await desktop.evaluate(()=>posted.filter(m=>m.type==='previewImageAction').length);
          await dialog.getByRole('button',{name:label}).click();
          await desktop.waitForFunction(previous=>posted.filter(m=>m.type==='previewImageAction').length>previous,count);
          const sent=await desktop.evaluate(()=>posted.filter(m=>m.type==='previewImageAction').at(-1));
          assert.equal(sent.action,action);
          if(file)assert.equal(sent.path,file);
          else{assert.equal(sent.path,undefined);assert.deepEqual([...Buffer.from(sent.png,'base64').subarray(0,8)],[137,80,78,71,13,10,26,10]);}
        }
        await dialog.getByRole('button',{name:'关闭预览'}).click();
      };
      await show(main.filter({hasText:'普通截图'}),slashPath(ordinaryScreenshot));
      await show(main.filter({hasText:'设置截图'}),slashPath(screenshot));
      await show(desktop.locator('.artifact[data-kind="referenced"] .artifact-frame').first(),screenshot);
      await show(desktop.locator('.artifact[data-kind="generated"] .artifact-frame').first(),null);
      const projected=desktop.locator('.agent-reply .md-file-link');
      const collapsed=desktop.locator('.turn-work:not([open])').filter({has:projected});
      if(await collapsed.count())await collapsed.locator(':scope > summary').click();
      for(const [label,file] of [['相对报告',path.join(childDocs,'report.pdf')],['相对目录',path.join(childRoot,'artifacts')+path.sep]]){
        await projected.filter({hasText:label}).click();
        await desktop.waitForFunction(expected=>window.posted.filter(m=>m.type==='revealLocalPath').at(-1)?.path===expected,file);
      }
      await main.filter({hasText:'预览文档'}).click();
      await desktop.locator('.file-preview-row.is-selected[data-line="2"]').waitFor();
      await desktop.getByRole('button',{name:'关闭文件预览'}).click();
      const event=desktop.locator('.agent-lifecycle-event[data-item-id="child-event"]');
      if(!await event.isVisible())await desktop.locator('.turn-work').filter({has:event}).locator(':scope > summary').click();
      await event.click();
      await show(desktop.locator('.agent-detail-content .md-file-link').filter({hasText:'子代理截图'}),path.join(childRoot,'子 截图.png'));
      assert.equal(await desktop.evaluate(()=>posted.filter(m=>m.type==='revealLocalPath').length),4);
    } finally {await desktop.close();}
  });
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []); console.log(JSON.stringify({passed: results.length, pageErrors: errors, checks: results}, null, 2));
} finally {await browser?.close(); await app.close(); await fs.rm(temporary, {recursive: true, force: true});}
