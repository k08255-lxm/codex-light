// Chrome/Playwright against a local DemoClient. The browser never calls a model.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
import {projectPathKey} from '../public/projects.js';

const {chromium}=createRequire(import.meta.url)('playwright');
const root=await mkdtemp(path.resolve('.tmp','projectless-browser-'));
const aPath=path.join(root,'Alpha'),bPath=path.join(root,'Beta');
await mkdir(aPath,{recursive:true});await mkdir(bPath,{recursive:true});
const client=new DemoClient(),direct=client.call.bind(client),engine=[];
const a=(await direct('thread/start',{cwd:aPath})).thread,b=(await direct('thread/start',{cwd:bPath})).thread;
a.name='Alpha history';a.createdAt-=10;b.name='Beta history';
client.call=async(method,params)=>{
 const result=await direct(method,params);
 if(method==='turn/start'){
  for(const timer of client.timers.get(result.turn.id)||[])clearTimeout(timer);
  client.timers.delete(result.turn.id);
 }
 if(['thread/start','turn/start','turn/steer'].includes(method))engine.push({method,params,result});
 return result;
};
function finish(threadId){
 const turn=client.turns.get(threadId)?.at(-1);
 assert.equal(turn.status,'inProgress');turn.status='completed';
 client.threads.get(threadId).updatedAt=Date.now()/1000;
 client.emit('event',{method:'turn/completed',params:{threadId,turn}});
}
const app=await createServer({demo:true,client,cwd:bPath,projectsRoot:path.join(root,'state')});
await app.started;
await app.projectStore.add(aPath,false);await app.projectStore.add(bPath,false);
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(app.url);
 const group=(current,key)=>current.locator(`.project-group[data-project-key="${key}"]`);
 const aKey=projectPathKey(aPath),bKey=projectPathKey(bPath);
 const expectFirst=(current,key)=>current.waitForFunction(key=>document.querySelector('.project-group')?.dataset.projectKey===key,key,{timeout:5000}).catch(async error=>{
  const order=await current.locator('.project-group').evaluateAll(nodes=>nodes.map(node=>[node.dataset.projectKey,node.innerText]));
  throw new Error(`Expected ${key}, got ${JSON.stringify(order)}; activity=${JSON.stringify(await app.projectStore.submitted())}; recent=${JSON.stringify(engine.map(row=>[row.method,row.params.threadId,row.params.cwd,row.params.input?.[0]?.text]))}; errors=${errors.join(', ')}: ${error.message}`);
 });
 const waitLabel=(current,name)=>current.locator('#cwd-label').filter({hasText:name}).waitFor();
 const choose=async(current,name)=>{await current.locator('#cwd-button').click();await current.locator('#project-dialog').getByRole('button',{name,exact:true}).click();await current.locator('#project-dialog').waitFor({state:'hidden'});await waitLabel(current,name);};
 const send=async(current,text)=>{
  await current.locator('#prompt').fill(text);
  assert.equal(await current.locator('#prompt').inputValue(),text);
  const [response]=await Promise.all([current.waitForResponse(r=>r.url().endsWith('/api/rpc')&&r.request().postDataJSON()?.method==='turn/start'&&r.request().postDataJSON().params.input[0].text===text,{timeout:8000}),current.locator('#send').click()]).catch(async error=>{throw new Error(`${text}: ${error.message}\n${await current.locator('#notice,#activity,#send-state').allTextContents()}\n${errors.join('\n')}`);});
  assert.ok(response.ok(),await response.text());
  await current.waitForFunction(()=>!document.getElementById('new-thread').disabled);
 };

 await expectFirst(page,bKey);
 await group(page,aKey).getByRole('button',{name:'Alpha history',exact:true}).click();
 await page.locator('#thread-title').filter({hasText:'Alpha history'}).waitFor();
 await expectFirst(page,bKey);
 await choose(page,'Alpha');
 await expectFirst(page,bKey);
 await send(page,'wrote in Alpha');
 await expectFirst(page,aKey);
 await group(page,bKey).getByRole('button',{name:'Beta history',exact:true}).click();
 await send(page,'wrote in Beta');
 await expectFirst(page,bKey);
 await group(page,aKey).locator('.project-group-thread').first().click();
 await page.locator('#prompt').fill('queued in Alpha');
 await page.locator('#queue-send').click();
 await page.locator('#queue').getByText('queued in Alpha',{exact:true}).waitFor();
 await expectFirst(page,bKey);
 assert.ok(!engine.some(row=>row.params.input?.[0].text==='queued in Alpha'));
 finish(a.id);
 await expectFirst(page,aKey);
 assert.ok(engine.some(row=>row.params.input?.[0].text==='queued in Alpha'));
 finish(b.id);
 await expectFirst(page,aKey);
 console.log('PASS: project and conversation opening remain stable, submissions and dispatched queue entries update recency');

 await page.locator('#new-thread').click();
 await waitLabel(page,'无项目');
 await send(page,'global new without a project');
 const first=engine.filter(row=>row.method==='thread/start').at(-1).result.thread;
 assert.equal(path.dirname(first.cwd),path.join(root,'state','projectless-threads'));
 await group(page,'@projectless').locator('.project-group-thread').filter({hasText:'global new without a project'}).waitFor();
 await group(page,bKey).getByRole('button',{name:'新建聊天',exact:true}).click();
 await waitLabel(page,'Beta');
 await send(page,'project new stays in Beta');
 assert.equal(engine.filter(row=>row.method==='thread/start').at(-1).params.cwd,await realpath(bPath));
 await page.keyboard.press('Control+n');
 await waitLabel(page,'无项目');
 await send(page,'shortcut new without a project');
 const second=engine.filter(row=>row.method==='thread/start').at(-1).result.thread;
 assert.notEqual(first.cwd,second.cwd);
 assert.equal(path.dirname(second.cwd),path.join(root,'state','projectless-threads'));
 await choose(page,'Alpha');await choose(page,'无项目');
 assert.equal((await app.projectStore.list()).selectedId,null);
 await page.reload();
 await waitLabel(page,'无项目');
 await group(page,'@projectless').locator('.project-group-thread').filter({hasText:'shortcut new without a project'}).click();
 await waitLabel(page,'无项目');
 await page.locator('#thread-title').filter({hasText:'shortcut new without a project'}).waitFor();
 console.log('PASS: global and keyboard draft scopes, project-specific creation, no-project selection, distinct paths and reload');

 const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 mobile.on('pageerror',error=>errors.push(error.message));
 await mobile.addInitScript(()=>{window.CodexLightNative={isNativeApp:()=>true,getAppVersion:()=> '0.4.9'};});
 await mobile.goto(app.url);
 await waitLabel(mobile,'Beta');
 await choose(mobile,'无项目');
 await send(mobile,'Android shell no-project draft');
 const mobileThread=engine.filter(row=>row.method==='thread/start').at(-1).result.thread;
 assert.equal(path.dirname(mobileThread.cwd),path.join(root,'state','projectless-threads'));
 assert.deepEqual(errors,[]);
 console.log('PASS: narrow Android bridge layout uses the same projectless draft flow');
}finally{await browser?.close();await app.close();await rm(root,{recursive:true,force:true});}
