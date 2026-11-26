// Run against the real paired website and SSE stream, with the 0.4.18 WebView bridge contract.
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';

const {chromium} = createRequire(import.meta.url)('playwright');
const out = path.resolve('.tmp/mobile-task-notifications');
await mkdir(out, {recursive:true});
const temporary = await mkdtemp(path.join(out, 'session-'));
const client = new DemoClient();
const makeThread = async (name, fields) => Object.assign(
  (await client.call('thread/start', {cwd:temporary})).thread, {name}, fields);
const userSource = {source:'vscode', threadSource:'user'};
const root = await makeThread('主对话验收', userSource);
const other = await makeThread('独立对话验收', userSource);
const child = parent => ({parentThreadId:parent.id, threadSource:'subagent',
  source:{subAgent:{thread_spawn:{parent_thread_id:parent.id, depth:parent === root ? 1 : 2}}}});
const first = await makeThread('子代理工作记录一', child(root));
const second = await makeThread('子代理工作记录二', child(first));
const orphan = await makeThread('无父线程审核任务', {threadSource:'guardian_review', ephemeral:true});
const hidden = [first.id, second.id, orphan.id], contentReads = [];
const engineCall = client.call.bind(client);
client.call = async (method, params) => {
  const result = await engineCall(method, params);
  if (method === 'thread/items/list') contentReads.push(params.threadId);
  if (method === 'thread/list') return {...result, data:result.data.filter(thread => !hidden.includes(thread.id))};
  return result;
};
const address = '192.168.78.19', browserHost = 'task-test.codecang.test';
let stream, connections = 0;
const app = await createServer({client, demo:true, cwd:temporary,
  projectsRoot:path.join(temporary,'projects'), statisticsRoot:path.join(temporary,'statistics'),
  fileAttachmentRoot:path.join(temporary,'attachments'), storageRoot:path.join(temporary,'storage'),
  lanOptions:{networkInterfaces:() => ({Test:[{address,family:'IPv4',internal:false}]}), serverFactory:handle => {
    const server = http.createServer((req,res) => {
      const port = server.address().port;
      if (req.headers.host === browserHost + ':' + port) req.headers.host = address + ':' + port;
      if (req.headers.origin === 'http://' + browserHost + ':' + port) req.headers.origin = 'http://' + address + ':' + port;
      if (req.url.startsWith('/api/events')) {connections++; stream = res;}
      handle(req,res);
    });
    const listen = server.listen.bind(server);
    server.listen = options => listen({...options, host:'127.0.0.1'});
    return server;
  }}});
const emit = (method,params) => client.emit('event',{method,params});
function start(thread) {
  const turn = {id:'turn-' + thread.id, status:'inProgress', items:[]};
  client.turns.set(thread.id,[turn]);
  emit('thread/started',{thread});
  emit('turn/started',{threadId:thread.id,turn});
}
function complete(thread) {
  const [turn] = client.turns.get(thread.id);
  turn.status = 'completed';
  emit('turn/completed',{threadId:thread.id,turn});
}
let browser;
try {
  await app.started;
  const lan = await app.lan.enable({address});
  const url = new URL(lan.url);
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  url.hostname = browserHost;
  url.hash = '';
  browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH,
    args:['--no-proxy-server','--host-resolver-rules=MAP ' + browserHost + ' 127.0.0.1']});
  const page = await browser.newPage({viewport:{width:407,height:886}, deviceScaleFactor:2656/886, isMobile:true, hasTouch:true});
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  await page.addInitScript(token => {
    window.taskCalls = []; window.taskOpened = [];
    window.CodexLightNative = {isNativeApp:() => true, getToken:() => token, setToolbarIntegrated(){},
      getTaskNotificationStatus:() => JSON.stringify({supported:true,enabled:true,supportsTaskPhase:true,
        permissionGranted:true,promotedCandidate:false,reason:'ready',background:'active'}),
      setTaskNotificationsEnabled(){}, openTaskNotificationSettings(){},
      updateTaskNotification:json => window.taskCalls.push(JSON.parse(json)),
      taskNotificationOpened:id => window.taskOpened.push(id)};
  },token);
  const feed = () => page.evaluate(async () => {
    const response = await fetch('/api/mobile/notification-state',{
      headers:{Authorization:'Bearer ' + window.CodexLightNative.getToken()}});
    if (!response.ok) throw new Error('Feed status ' + response.status);
    return response.json();
  });
  const waitForTask = (thread,state) => page.waitForFunction(([id,value]) =>
    window.taskCalls.some(call => call.threadId === id && call.state === value),[thread.id,state]);
  const open = async thread => {
    const previous = await page.evaluate(id => {
      const count = window.taskOpened.filter(value => value === id).length;
      window.CodexLightTaskNotifications.open(id);
      return count;
    },thread.id);
    await page.waitForFunction(([id,count]) => window.taskOpened.filter(value => value === id).length > count,[thread.id,previous]);
  };
  const sameIds = (tasks, expected) => assert.deepEqual(tasks.map(t => t.threadId).sort(),expected.map(t => t.id).sort());
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/events' && response.status() === 200),
    page.goto(url.href),
  ]);
  await page.waitForFunction(() => document.documentElement.dataset.access === 'lan'
    && document.getElementById('connection-text')?.textContent.includes('演示'));

  for (const thread of [root,first,second]) start(thread);
  await waitForTask(root,'running');
  sameIds((await feed()).running,[root]);
  start(other);
  await waitForTask(other,'running');
  sameIds((await feed()).running,[root,other]);
  await open(other);
  assert.equal(await page.locator('#thread-title').textContent(),other.name);
  await open(second);
  assert.equal(await page.locator('#thread-title').textContent(),root.name);
  await open(orphan);
  assert.equal(await page.locator('#thread-title').textContent(),root.name);
  assert.match(await page.locator('#notice').textContent(),/隐藏|归档/);
  const cleared = await page.evaluate(() => window.taskCalls.filter(call => call.state === 'idle').map(call => call.threadId));
  assert.ok(cleared.includes(second.id) && cleared.includes(orphan.id),'both old cards are withdrawn through the 0.4.18 bridge');
  assert.deepEqual(contentReads.filter(id => hidden.includes(id)),[]);

  await open(other);
  assert.equal(await page.locator('#thread-title').textContent(),other.name);
  stream.destroy();
  await waitForTask(root,'disconnected');
  await page.evaluate(id => window.CodexLightTaskNotifications.open(id),first.id);
  assert.ok(!await page.evaluate(id => window.taskOpened.includes(id),first.id),'disconnected click waits for authoritative routing');
  await page.waitForFunction(id => window.taskOpened.includes(id),first.id);
  assert.equal(await page.locator('#thread-title').textContent(),root.name);
  await page.waitForFunction(id => window.taskCalls.filter(call => call.threadId === id).at(-1)?.state === 'running',root.id);
  assert.ok(connections >= 2);
  sameIds((await feed()).running,[root,other]);
  for (const thread of [first,second,other,root]) complete(thread);
  await waitForTask(root,'completed');
  await waitForTask(other,'completed');
  const finished = await feed();
  sameIds(finished.finished,[root,other]);
  assert.deepEqual(finished.running,[]);
  assert.deepEqual(contentReads.filter(id => hidden.includes(id)),[]);
  const posted = await page.evaluate(() => window.taskCalls.filter(call => call.state !== 'idle'));
  assert.deepEqual([...new Set(posted.map(call => call.threadId))].sort(),[root.id,other.id].sort());
  assert.equal(posted.findLast(call => call.threadId === root.id)?.title,root.name);
  const image = await page.screenshot({path:path.join(out,'restored-root.png')});
  assert.deepEqual([image.readUInt32BE(16),image.readUInt32BE(20)],[1220,2656]);
  assert.deepEqual(errors,[]);
  console.log('PASS paired HTTP feed, root-only WebView notifications, two legacy child routes, independent conversations and SSE reconnect (1220 × 2656 simulated)');
} finally {
  await browser?.close();
  await app.close();
  await rm(temporary,{recursive:true,force:true});
}
