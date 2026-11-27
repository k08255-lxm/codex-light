// Run against the real paired website and SSE stream, with the 0.4.18 WebView bridge contract.
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
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
const sampleCredits = [1,2].map(index=>({id:'credit-'+index,title:'Full reset',description:"Thanks for using Codex! You've been granted one free rate limit reset.",resetType:'codexRateLimits',status:'available',grantedAt:1794523080,expiresAt:1923400680+index*86400}));
const redemptions=[], submissions=[];
client.call = async (method, params) => {
  if (method==='turn/start'||method==='turn/steer') submissions.push(method);
  if(method==='account/usage/read')return {summary:{lifetimeTokens:1600}};
  if(method==='account/rateLimits/read')return {rateLimits:{primary:{usedPercent:33,windowDurationMins:10080}},rateLimitResetCredits:{availableCount:sampleCredits.filter(c=>c.status==='available').length,credits:sampleCredits}};
  if(method==='account/rateLimitResetCredit/consume'){
    redemptions.push(params);sampleCredits.find(c=>c.id===params.creditId).status='redeemed';return {outcome:'reset'};
  }
  const result = await engineCall(method, params);
  if (method === 'thread/items/list') contentReads.push(params.threadId);
  if (method === 'thread/list') return {...result, data:result.data.filter(thread => !hidden.includes(thread.id))};
  return result;
};
const address = '192.168.78.19', browserHost = 'task-test.codecang.test';
let stream, connections = 0;
const app = await createServer({client, cwd:temporary,
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
    window.CodexLightNative = {isNativeApp:() => true, getToken:() => token, getAppVersion:()=>sessionStorage.getItem('test-installed-version')||'0.4.18',getPreferredTheme:()=> 'dark',setToolbarIntegrated(){},openServerManager(){},checkForUpdates(){window.updateChecks=(window.updateChecks||0)+1;},
      getTaskNotificationStatus:() => JSON.stringify({supported:true,enabled:true,supportsTaskPhase:true,supportsTaskDetails:sessionStorage.getItem('test-details')==='1',
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
    && document.getElementById('connection-dot')?.className==='ok');

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
  await page.locator('#mobile-quota-slot button').click();
  const cards=page.locator('.acct-reset-credits'), use=cards.getByRole('button',{name:'使用',exact:true});
  await use.nth(1).waitFor();await cards.scrollIntoViewIfNeeded();
  assert.equal(await cards.locator('details').count(),0);
  assert.doesNotMatch(await cards.innerText(),/Thanks for using|查看卡片/);
  const control=await use.first().boundingBox();assert.ok(control.width>=44&&control.height>=44&&control.x+control.width<=407);
  const creditPng=await page.screenshot({path:path.join(out,'phone-reset-cards.png')});
  await cards.screenshot({path:path.join(out,'reset-cards.png')});
  assert.deepEqual([creditPng.readUInt32BE(16),creditPng.readUInt32BE(20)],[1220,2656]);
  await use.first().click();await cards.getByRole('button',{name:'取消',exact:true}).click();assert.equal(redemptions.length,0);
  await use.nth(1).click();await cards.getByRole('button',{name:'确认使用这张卡'}).click();
  await cards.getByRole('button',{name:'已使用'}).waitFor();
  assert.equal(redemptions.length,1);assert.equal(redemptions[0].creditId,'credit-2');
  await page.locator('#rail-settings').click();
  assert.equal(await page.locator('#settings-general #mobile-release-notes').count(),0);
  await page.locator('#rail-sidebar').click();
  await page.getByRole('button',{name:'关于',exact:true}).click();
  const workbenchVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
  const notes=page.locator('#mobile-release-notes');
  const noteHeadline=async version=>(await readFile(new URL('../releases/'+version+'.md',import.meta.url),'utf8')).split(/\r?\n/)[0];
  await notes.getByText(await noteHeadline('0.4.18'),{exact:true}).waitFor();
  assert.equal(await page.locator('#mobile-client-version').innerText(),'v0.4.18');
  assert.equal(await page.locator('#mobile-host-version').innerText(),'v'+workbenchVersion);
  assert.equal(await page.locator('#about-root').isVisible(),false);
  await page.locator('#sidebar-overlay').waitFor({state:'hidden'});
  const aboutPng=await page.screenshot({path:path.join(out,'phone-about.png'),animations:'disabled'});
  assert.deepEqual([aboutPng.readUInt32BE(16),aboutPng.readUInt32BE(20)],[1220,2656]);
  await page.locator('#mobile-app-update').click();
  assert.equal(await page.evaluate(()=>window.updateChecks),1);
  await notes.getByRole('button',{name:'电脑端',exact:true}).click();
  await notes.getByText(await noteHeadline(workbenchVersion),{exact:true}).waitFor();
  await notes.getByRole('button',{name:'手机端',exact:true}).click();
  await notes.getByText(await noteHeadline('0.4.18'),{exact:true}).waitFor();
  await page.evaluate(version=>{sessionStorage.setItem('test-details','1');sessionStorage.setItem('test-installed-version',version);},workbenchVersion);
  await Promise.all([page.waitForResponse(r=>r.url().includes('mobileTasks=1&details=1')&&r.status()===200),page.reload()]);
  const threadId=root.id,turnId='recovered-turn', itemId='new-command';
  const phase=state=>page.waitForFunction(([turn,state])=>window.taskCalls.some(t=>t.turnId===turn&&t.state===state),[turnId,state]);
  emit('item/commandExecution/outputDelta',{threadId,turnId,itemId,delta:'PRIVATE TOOL OUTPUT'});
  await phase('running');
  emit('turn/plan/updated',{threadId,turnId,plan:[{step:'读取需求',status:'completed'},{step:'验证手机界面',status:'inProgress'}]});
  await page.waitForFunction(id=>window.taskCalls.some(t=>t.turnId===id && t.details?.action==='commandExecution' && t.details.step==='验证手机界面' && t.details.done===1 && t.details.total===2),turnId);
  const question={id:'await-choice',type:'agentMessage',delivery:'async',questions:[{title:'使用哪个版本？'}]};
  emit('item/completed',{threadId,turnId,item:question});
  emit('turn/completed',{threadId,turn:{id:turnId,status:'completed'}});
  await phase('waiting');
  const waiting=await page.evaluate(id=>window.taskCalls.filter(t=>t.turnId===id).at(-1),turnId);
  assert.equal(waiting.details.preview,'使用哪个版本？');assert.equal(waiting.details.noticeThread,threadId);
  assert.doesNotMatch(JSON.stringify(waiting),/PRIVATE TOOL OUTPUT/);
  emit('item/completed',{threadId,turnId:'answer-turn',item:{id:'answer',type:'userMessage',content:[{type:'text',text:'对提问的回答\n\n1. 使用哪个版本？\n回答：新版'}]}});
  await phase('completed');
  const choices=['要生成预览吗？','选择要保留的文件'];
  const questions=choices.map((title,index)=>({id:'card-'+index,type:'agentMessage',delivery:'async',questions:[{title,options:['采用','稍后']}]}));
  const askTurn={id:'turn-with-two-cards',status:'inProgress',items:[{id:'user-asks',type:'userMessage',content:[{type:'text',text:'请确认两项选择'}]},...questions]};
  client.turns.set(threadId,[askTurn]);
  client.items.set(threadId,askTurn.items.map(item=>({turnId:askTurn.id,item})));
  emit('turn/started',{threadId,turn:{id:askTurn.id,status:'inProgress'}});
  for(const item of askTurn.items)emit('item/completed',{threadId,turnId:askTurn.id,item});
  await open(other);await open(root);
  const card=(target,index)=>target.locator('.async-input-card').filter({has:target.getByText(choices[index],{exact:true})});
  const desktop=await browser.newPage({viewport:{width:1440,height:960}});
  desktop.setDefaultTimeout(8000);
  await desktop.goto(app.url);
  await desktop.locator('#connection-dot.ok').waitFor({state:'attached'});
  if(await desktop.locator('#first-theme').evaluate(dialog=>dialog.open))await desktop.locator('#first-theme button[type=submit]').click();
  const rootRow=desktop.locator('.project-group-thread').filter({hasText:root.name});
  await rootRow.waitFor({state:'attached'});
  if(!await rootRow.isVisible())await rootRow.locator('xpath=ancestor::*[@data-open][1]').getByRole('button',{name:/展开/}).click();
  await rootRow.click();
  for(const target of [desktop,page]){
    const actions=card(target,0).locator('.actions');
    await actions.getByRole('button',{name:'忽略',exact:true}).waitFor();
    assert.equal(await actions.getByRole('button',{name:'发送回答'}).isVisible(),true);
  }
  await card(page,0).screenshot({path:path.join(out,'question-card.png')});
  await card(page,0).getByRole('button',{name:'忽略',exact:true}).click();
  for(const target of [page,desktop])await card(target,0).getByRole('heading',{name:'已忽略'}).waitFor();
  assert.deepEqual(submissions,[]);
  const afterIgnore=await feed();
  assert.deepEqual(afterIgnore.pending.map(n=>n.id),['async-'+threadId+'|card-1']);
  assert.equal(afterIgnore.running.find(t=>t.turnId===askTurn.id)?.state,'waiting');
  await Promise.all([page.waitForResponse(r=>r.url().includes('mobileTasks=1&details=1')&&r.status()===200),page.reload()]);
  await open(root);
  await card(page,0).getByRole('heading',{name:'已忽略'}).waitFor();
  assert.equal(await card(page,0).getByRole('button',{name:'忽略'}).count(),0);
  await card(page,1).getByRole('radio',{name:'采用'}).check();
  assert.equal(await card(page,1).getByRole('button',{name:'发送回答'}).isEnabled(),true);
  await card(desktop,1).getByRole('button',{name:'忽略',exact:true}).click();
  await card(page,1).getByRole('heading',{name:'已忽略'}).waitFor();
  assert.deepEqual(submissions,[]);
  const resumed=await feed();
  assert.equal(resumed.pending.length,0);
  assert.equal(resumed.running.find(t=>t.turnId===askTurn.id)?.state,'running');
  emit('item/completed',{threadId,turnId:askTurn.id,item:questions[0]});
  assert.equal((await feed()).pending.length,0);
  await desktop.close();
  async function openAbout(target){
    await target.locator('#rail-settings').click();
    if(await target.locator('#rail-sidebar').getAttribute('aria-expanded')!=='true')await target.locator('#rail-sidebar').click();
    await target.getByRole('button',{name:'关于',exact:true}).click();
    await target.locator('#mobile-release-notes').getByText(await noteHeadline(workbenchVersion),{exact:true}).waitFor();
  }
  await openAbout(page);
  assert.equal(await page.locator('#mobile-notes-switch').isVisible(),false);
  assert.equal(await page.locator('#mobile-client-version').innerText(),'v'+workbenchVersion);

  const web=await browser.newPage({viewport:{width:407,height:886},deviceScaleFactor:2656/886,isMobile:true,hasTouch:true});
  const webUrl=new URL(lan.url);webUrl.hostname=browserHost;
  await web.goto(webUrl.href);await web.locator('#connection-dot.ok').waitFor({state:'attached'});
  if(await web.locator('#first-theme').evaluate(dialog=>dialog.open))await web.locator('#first-theme button[type=submit]').click();
  await openAbout(web);
  assert.equal(await web.locator('#mobile-about-client').isVisible(),false);
  assert.equal(await web.locator('#mobile-notes-switch').isVisible(),false);
  assert.equal(await web.locator('#about-root').isVisible(),false);
  await web.close();
  assert.deepEqual(errors,[]);
  console.log('PASS paired HTTP, task recovery, two independent question cards, bidirectional desktop/phone ignore and reload, continued task progress, reset card and changelog (1220 × 2656 simulated)');
} finally {
  await browser?.close();
  await app.close();
  await rm(temporary,{recursive:true,force:true});
}
