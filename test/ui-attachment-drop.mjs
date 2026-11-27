// Chrome's native drag pipeline supplies real files and browser-selected MIME types.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../src/server.mjs';

const {chromium} = createRequire(import.meta.url)('playwright');
const root = await mkdtemp(path.join(os.tmpdir(), 'codecang-drop-'));
const jsonl = path.join(root, 'posts-48h (2).jsonl'), png = path.join(root, 'image.png'), zip = path.join(root, 'archive.zip');
await Promise.all([
  writeFile(jsonl, '{"fixture":"仅本地的正文"}\n{"line":2}\n'),
  writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64')),
  writeFile(zip, 'fixture'),
]);
const app = await createServer({demo:true, cwd:root, fileAttachmentRoot:path.join(root,'attachments'), projectsRoot:path.join(root,'projects')});
let browser;
try {
  await app.started;
  browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH});
  const page = await browser.newPage(), session = await page.context().newCDPSession(page);
  page.setDefaultTimeout(8000);
  const errors = [], uploads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {if (/\/api\/(file-)?uploads$/.test(request.url())) uploads.push(request.url());});
  await page.goto(app.url);
  await page.waitForFunction(() => !document.querySelector('#add-file').disabled && document.querySelector('#connection-text').textContent.includes('演示'));
  if (await page.locator('#first-theme').evaluate(el=>el.open)) await page.locator('#first-theme button[type=submit]').click();
  async function drag(files, accepts) {
    const params = {x:350,y:280,data:{items:[],files,dragOperationsMask:1}};
    for(const type of ['dragEnter','dragOver']) await session.send('Input.dispatchDragEvent',{...params,type});
    assert.equal(await page.locator('.attachment-drop-hint').isVisible(), accepts);
    await session.send('Input.dispatchDragEvent',{...params,type:'drop'});
  }
  const chips = page.locator('#attachment-tray .attachment-chip');
  await page.locator('#rail-settings').click();
  await drag([jsonl], false);
  assert.equal(uploads.length, 0);
  assert.equal(new URL(page.url()).origin, app.origin);
  await page.locator('#navigate-back').click();

  let releaseUpload;
  const held = new Promise(resolve => {releaseUpload = resolve;});
  await page.route('**/api/file-uploads', async route => {await held;await route.continue();}, {times:1});
  await drag([jsonl,png], true);
  await page.locator('.attachment-uploading').waitFor();
  await drag([zip], false);
  releaseUpload();
  await chips.nth(1).waitFor();
  assert.equal(uploads.length, 2);
  assert.equal(await chips.filter({hasText:'posts-48h (2).jsonl'}).count(), 1);
  assert.match(await chips.filter({hasText:'posts-48h (2).jsonl'}).innerText(), /文本文件引用/);
  assert.equal(await chips.filter({hasText:'发送前需确认风险'}).count(), 0);
  assert.equal(await page.getByRole('button',{name:'预览 image.png'}).count(), 1);
  for(const width of [407,1280]){
    await page.setViewportSize({width,height:886});
    const tray=await page.locator('#attachment-tray').boundingBox(), conversation=await page.locator('#conversation').boundingBox();
    const prompt=await page.locator('#prompt').boundingBox();
    assert.ok(tray.y >= conversation.y+conversation.height-1 && tray.y+tray.height <= prompt.y+1,'attachment space sits between conversation and input at width '+width);
  }
  await drag([jsonl,jsonl,jsonl,jsonl], true);
  await page.locator('#notice').filter({hasText:'合计最多 5 个'}).waitFor();
  assert.equal(uploads.length, 2);
  await drag([zip], true);
  await chips.filter({hasText:'发送前需确认风险'}).waitFor();
  await page.locator('#send').click();
  const confirm = page.locator('dialog[open]').filter({hasText:'确认随本次消息发送以下文件引用'});
  await confirm.waitFor();
  assert.match(await confirm.innerText(),/archive\.zip：压缩文件/);
  assert.doesNotMatch(await confirm.innerText(),/posts-48h|Archive or unverified/);
  await confirm.getByRole('button',{name:'取消'}).click();
  assert.equal(await chips.count(),3);
  await page.getByRole('button',{name:'取消附带 archive.zip'}).click();
  const turn = page.waitForRequest(request => request.url().endsWith('/api/rpc') && request.postDataJSON()?.method === 'turn/start',{timeout:8000});
  await page.locator('#send').click();
  const sent = (await turn).postDataJSON();
  assert.deepEqual(sent.confirmedFileAttachmentIds ?? [],[]);
  assert.equal(sent.attachmentIds.length,1);assert.equal(sent.fileAttachmentIds.length,1);
  await chips.first().waitFor({state:'detached'});
  assert.deepEqual(errors, []);
  console.log('PASS Chrome file drag: mixed batch, image name, JSONL, count limit, settings and busy rejection, archive consent/cancel, ordinary send to DemoClient.');
} finally {
  await browser?.close(); await app.close(); await rm(root,{recursive:true,force:true});
}
