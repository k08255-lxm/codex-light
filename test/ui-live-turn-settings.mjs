// Explicit Playwright suite. All RPCs use a loopback DemoClient with completion held until the test releases it.
import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';

const {chromium}=createRequire(import.meta.url)('playwright');
const update='turn/settings/update';
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});});
after(()=>browser?.close());

function deferred(){
 let resolve;
 const promise=new Promise(done=>{resolve=done;});
 return {promise,resolve};
}
async function fixture(t,{beforeUpdate,nativeSettings=true}={}){
 const root=await mkdtemp(path.join(tmpdir(),'codex-live-turn-ui-'));
 const client=new DemoClient(),call=client.call.bind(client),calls=[],effects=[];
 const {thread:other}=await call('thread/start',{cwd:root,model:'demo'});
 other.name='另一段对话';
 client.call=async(method,params)=>{
  if(method==='thread/settings/update'&&!nativeSettings)throw Object.assign(new Error('Method not found'),{code:-32601});
  if(method.startsWith('turn/'))calls.push({method,params:structuredClone(params)});
  if(method===update&&beforeUpdate)await beforeUpdate(params);
  const result=await call(method,params);
  if(method===update)effects.push({params,result});
  if(method==='turn/start'){
   for(const timer of client.timers.get(result.turn.id)||[])clearTimeout(timer);
   client.timers.delete(result.turn.id);
  }
  return result;
 };
 const app=await createServer({client,demo:true,cwd:root,projectsRoot:path.join(root,'projects'),fileAttachmentRoot:path.join(root,'attachments')});
 const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 page.setDefaultTimeout(6000);
 t.after(async()=>{
  await page.close();await app.close();await rm(root,{recursive:true,force:true});assert.deepEqual(errors,[]);
 });
 await app.started;
 await page.goto(app.url);
 await page.waitForFunction(()=>document.querySelector('#model option[value="demo-six"]')).catch(error=>{
  if(errors.length)throw new Error('Demo startup failed: '+errors.join(', '),{cause:error});
  throw error;
 });
 if(await page.locator('#first-theme').evaluate(dialog=>dialog.open))await page.locator('#first-theme button[type=submit]').click();
 return {client,page,calls,effects,other,url:app.url};
}
async function chooseModel(page,label){
 if(await page.locator('#model-trigger').getAttribute('aria-expanded')!=='true')await page.locator('#model-trigger').click();
 await page.locator('#model-list-open').click();
 await page.locator('#model-options').getByRole('button',{name:label,exact:true}).click();
}
async function clickEffort(page,index){
 const range=page.locator('#reasoning-range'),max=Number(await range.getAttribute('max'));
 const box=await range.boundingBox();assert.ok(box&&max>0);
 // Click inside the end stops so the pointer remains on the track.
 await range.click({position:{x:Math.round(12+(box.width-24)*index/max),y:Math.floor(box.height/2)}});
}
function onResponse(page,method,paramsMatch=()=>true){
 return page.waitForResponse(response=>{
  if(!response.url().endsWith('/api/rpc'))return false;
  const body=response.request().postDataJSON();
  return body?.method===method&&paramsMatch(body.params);
 });
}
async function send(page,message){
 await page.locator('#prompt').fill(message);
 const [response]=await Promise.all([onResponse(page,'turn/start'),page.locator('#send').click()]);
 assert.equal(response.status(),200,await response.text());
 await page.locator('.turn-working[data-running="true"]').waitFor();
 return response.request().postDataJSON().params;
}
async function startSix(f){
 await chooseModel(f.page,'演示六档模型（不调用 AI）');
 await clickEffort(f.page,5);
 await f.page.keyboard.press('Escape');
 const params=await send(f.page,'当前正在工作的对话');
 assert.equal(params.model,'demo-six');assert.equal(params.effort,'ultra');
 const [turn]=f.client.turns.get(params.threadId);
 assert.equal(turn.status,'inProgress');
 return {threadId:params.threadId,turnId:turn.id};
}
async function finish(f,owner){
 const turn=f.client.turns.get(owner.threadId).find(turn=>turn.id===owner.turnId);
 turn.status='completed';
 f.client.emit('event',{method:'turn/completed',params:{...owner,turn}});
 await f.page.locator('.turn-working[data-running="true"]').waitFor({state:'hidden'});
}

test('model and slider clicks update the owned running turn in order and carry the final settings to the next send',async t=>{
 const gate=deferred(),entered=deferred();let first=true;
 const f=await fixture(t,{beforeUpdate:async()=>{if(first){first=false;entered.resolve();await gate.promise;}}});
 const {page}=f,owner=await startSix(f);
 const firstUpdate=onResponse(page,update,params=>params.model==='demo-five'&&params.effort==='medium');
 const secondUpdate=onResponse(page,update,params=>params.effort==='max');
 // Observe both responses even if a click throws while the first request is held.
 const responses=Promise.all([firstUpdate,secondUpdate]);responses.catch(()=>{});
 try{
  await chooseModel(page,'演示五档模型（不调用 AI）');
  await Promise.race([entered.promise,firstUpdate.then(()=>assert.fail('the model RPC bypassed the demo engine'))]);
  await clickEffort(page,4);
  assert.equal(await page.locator('#effort').inputValue(),'max');
  // Let the trailing range debounce expire while the first engine update is still in flight.
  await page.waitForTimeout(350);
 }finally{gate.resolve();}
 for(const response of await responses)assert.equal(response.status(),200,await response.text());
 const [model,effort]=f.effects;
 assert.equal(f.effects.length,2);
 assert.equal(model.params.model,'demo-five');assert.equal(model.params.effort,'medium');
 assert.equal(effort.params.effort,'max');
 for(const effect of f.effects){
  assert.equal(effect.params.threadId,owner.threadId);assert.equal(effect.params.turnId,owner.turnId);
  assert.equal(effect.result.status,'applied');
 }
 assert.deepEqual(f.client.turns.get(owner.threadId)[0].settings,{model:'demo-five',effort:'max',serviceTier:null});
 await page.locator('#notice').filter({hasText:/本轮.*后续步骤/}).waitFor();
 assert.deepEqual(f.calls.map(row=>row.method),['turn/start',update,update]);
 await page.keyboard.press('Escape');
 await finish(f,owner);
 const next=await send(page,'下一轮使用刚选中的模型和强度');
 assert.equal(next.threadId,owner.threadId);assert.equal(next.model,'demo-five');assert.equal(f.client.modelTurns.at(-1).inheritedEffort,'max');
});

test('the native thread preference survives steering and reopening without changing the recorded starting effort',async t=>{
 const f=await fixture(t),{page}=f,owner=await startSix(f);
 await page.locator('#model-trigger').click();
 const [changed]=await Promise.all([onResponse(page,update),clickEffort(page,3)]);
 assert.equal(changed.status(),200,await changed.text());
 assert.equal(f.effects.at(-1).result.status,'applied');
 await page.keyboard.press('Escape');
 await page.locator('#prompt').fill('补充当前任务');
 const [steered]=await Promise.all([onResponse(page,'turn/steer'),page.locator('#send').click()]);
 assert.equal(steered.status(),200,await steered.text());
 const thread=f.client.threads.get(owner.threadId);
 assert.equal(f.client.modelTurns[0].effort,'ultra');
 assert.equal(thread.reasoningEffort,'xhigh');
 await finish(f,owner);
 await page.getByRole('button',{name:f.other.name,exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#model').value==='demo');
 await page.getByRole('button',{name:thread.name,exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#model').value==='demo-six');
 assert.equal(await page.locator('#reasoning-label').textContent(),'极高');
 const next=await send(page,'下一轮继续使用极高');
 assert.equal(next.threadId,owner.threadId);
 assert.equal(f.client.modelTurns.at(-1).inheritedEffort,'xhigh');
});

test('a late update receipt stays with the original turn after the user opens another conversation',async t=>{
 const entered=deferred(),gate=deferred();
 const f=await fixture(t,{beforeUpdate:async()=>{entered.resolve();await gate.promise;}});
 const {page}=f,owner=await startSix(f);
 const receipt=onResponse(page,update);receipt.catch(()=>{});
 try{
  await chooseModel(page,'演示五档模型（不调用 AI）');
  await Promise.race([entered.promise,receipt.then(()=>assert.fail('the settings RPC bypassed the demo engine'))]);
  await page.getByRole('button',{name:f.other.name,exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#model').value==='demo');
 }finally{gate.resolve();}
 assert.equal((await receipt).status(),200);
 assert.equal(f.effects.length,1);assert.equal(f.effects[0].params.threadId,owner.threadId);
 assert.equal(f.effects[0].params.turnId,owner.turnId);
 assert.equal(await page.locator('#notice').filter({hasText:/已更新本轮设置/}).isVisible(),false);
 const next=await send(page,'独立对话使用自己的模型');
 assert.equal(next.threadId,f.other.id);assert.equal(next.model,'demo');assert.notEqual(next.effort,'medium');
 assert.deepEqual(f.calls.map(row=>row.method),['turn/start',update,'turn/start']);
});

test('Fast switch changes use the active turn and the explicit speed survives the next send',async t=>{
 const f=await fixture(t),{page}=f,owner=await startSix(f);
 await page.locator('#model-trigger').click();
 const fast=page.locator('#fast-toggle');
 for(const tier of ['fast','default','fast']){
  const [response]=await Promise.all([onResponse(page,update,params=>params.serviceTier===tier),fast.click()]);
  assert.equal(response.status(),200,await response.text());
  const params=response.request().postDataJSON().params;
  assert.equal(params.threadId,owner.threadId);assert.equal(params.turnId,owner.turnId);
  assert.equal(await fast.isChecked(),tier==='fast');
  assert.equal(f.effects.at(-1).params.serviceTier,tier==='fast'?'priority':'default');
 }
 assert.deepEqual(f.calls.map(row=>row.method),['turn/start',update,update,update]);
 await page.keyboard.press('Escape');
 await finish(f,owner);
 const next=await send(page,'下一轮继续快速模式');
 assert.equal(next.threadId,owner.threadId);assert.equal(next.serviceTier,'fast');
});

test('an older engine reports deferred settings and the next turn uses the requested model and effort',async t=>{
 const f=await fixture(t,{nativeSettings:false,beforeUpdate:()=>{throw Object.assign(new Error('Method not found'),{code:-32601});}});
 const {page}=f,owner=await startSix(f);
 const [response]=await Promise.all([onResponse(page,update),chooseModel(page,'演示五档模型（不调用 AI）')]);
 assert.equal(response.request().postDataJSON().params.turnId,owner.turnId);
 await page.locator('#notice').filter({hasText:/不支持.*下一轮/}).waitFor();
 assert.equal(await page.locator('#model').inputValue(),'demo-five');assert.equal(await page.locator('#effort').inputValue(),'medium');
 assert.equal(f.effects.length,0);assert.deepEqual(f.calls.map(row=>row.method),['turn/start',update]);
 await page.keyboard.press('Escape');
 await finish(f,owner);
 const name=f.client.threads.get(owner.threadId).name;
 await page.reload();
 await page.locator('.project-group-thread').filter({hasText:name}).click();
 await page.waitForFunction(()=>document.querySelector('#effort').value==='medium');
 const next=await send(page,'旧引擎保留下一轮的设置');
 assert.equal(next.threadId,owner.threadId);assert.equal(next.model,'demo-five');assert.equal(f.client.modelTurns.at(-1).inheritedEffort,'medium');
});

test('a completion racing a settings change keeps the selection for the next turn',async t=>{
 const entered=deferred(),gate=deferred();
 const f=await fixture(t,{beforeUpdate:async()=>{entered.resolve();await gate.promise;}});
 const {page}=f,owner=await startSix(f);
 const receipt=onResponse(page,update);receipt.catch(()=>{});
 try{
  await chooseModel(page,'演示五档模型（不调用 AI）');
  await Promise.race([entered.promise,receipt.then(()=>assert.fail('the settings RPC bypassed the demo engine'))]);
  await finish(f,owner);
 }finally{gate.resolve();}
 assert.equal((await receipt).status(),200);
 assert.equal(f.effects[0].result.status,'targetUnavailable');
 await page.locator('#notice').filter({hasText:/本轮已结束.*下一轮/}).waitFor();
 const next=await send(page,'完成后的下一轮采用已选档位');
 assert.equal(next.threadId,owner.threadId);assert.equal(next.model,'demo-five');assert.equal(f.client.modelTurns.at(-1).inheritedEffort,'medium');
 assert.deepEqual(f.calls.map(row=>row.method),['turn/start',update,'turn/start']);
});

test('two browser contexts share native choices in both directions and an immediate steer follows the settings update',async t=>{
 const f=await fixture(t),owner=await startSix(f),thread=f.client.threads.get(owner.threadId);
 const peer=await browser.newPage({viewport:{width:1440,height:900}});
 peer.setDefaultTimeout(6000);
 t.after(()=>peer.close());
 await peer.goto(f.url);
 await peer.locator('#first-theme button[type=submit]').click();
 await peer.locator('.project-group-thread').filter({hasText:thread.name}).click();
 await peer.locator('#model-trigger-effort').filter({hasText:'Ultra'}).waitFor();
 await f.page.locator('#model-trigger').click();
 await clickEffort(f.page,4);
 await f.page.keyboard.press('Escape');
 await f.page.locator('#prompt').fill('立即补充当前任务');
 const [steered]=await Promise.all([onResponse(f.page,'turn/steer'),f.page.locator('#send').click()]);
 assert.equal(steered.status(),200);
 assert.deepEqual(f.calls.map(row=>row.method),['turn/start',update,'turn/steer']);
 await peer.locator('#model-trigger-effort').filter({hasText:'Max'}).waitFor();
 await finish(f,owner);
 await peer.reload();
 await peer.locator('.project-group-thread').filter({hasText:thread.name}).click();
 await peer.locator('#model-trigger-effort').filter({hasText:'Max'}).waitFor();
 const next=await send(peer,'另一端的下一轮');
 assert.equal(next.threadId,owner.threadId);
 assert.equal(f.client.modelTurns.at(-1).inheritedEffort,'max');
 await peer.locator('#model-trigger').click();
 await clickEffort(peer,3);
 await f.page.locator('#model-trigger-effort').filter({hasText:'极高'}).waitFor();
 assert.equal(f.client.modelTurns[0].effort,'ultra');
});

test('a rejected persistent change restores the confirmed effort and reports the failure',async t=>{
 const f=await fixture(t);await startSix(f);
 await f.page.route('**/api/session/reasoning',route=>route.request().postDataJSON().scope
  ?route.fulfill({status:409,json:{error:'synthetic write failure'}}):route.continue());
 await f.page.locator('#model-trigger').click();
 await clickEffort(f.page,4);
 await f.page.locator('#notice').filter({hasText:'未能保存对话模型设置'}).waitFor();
 await f.page.locator('#reasoning-label').filter({hasText:'Ultra'}).waitFor();
 assert.equal(f.effects.length,0);
});
