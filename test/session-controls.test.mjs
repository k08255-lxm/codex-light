import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionControls} from '../public/session-controls.js';
import {createDocument} from './mini-dom.mjs';

const configured={model:'configured-model',approvalPolicy:'never',approvalsReviewer:'user',sandbox:'danger-full-access',sandboxPolicy:{type:'dangerFullAccess'},serviceTier:'fast'};
const autoPermission={approvalPolicy:'on-request',approvalsReviewer:'auto_review',sandbox:'workspace-write',sandboxPolicy:{type:'workspaceWrite'}};
function fixture({id=null,config=structuredClone(configured),model,onFastChange,permissionStore}={}){
 const document=createDocument(),host=document.createElement('div');document.body.append(host);
 const chip=document.createElement('button');chip.id='permissions-info';const oldIcon=document.createElement('span');oldIcon.className='ui-icon';
 const label=document.createElement('span');label.className='label';chip.append(oldIcon,label);host.append(chip);
 const query=chip.querySelector.bind(chip);chip.querySelector=selector=>selector.startsWith(':scope')?oldIcon:query(selector);
 const fast=document.createElement('input');fast.id='fast-toggle';fast.type='checkbox';host.append(fast);document.defaultView.innerHeight=900;
 const notices=[];const controller=createSessionControls({document,defaults:()=>config,threadId:()=>id,model,onFastChange,permissionStore,notice:(...args)=>notices.push(args)});
 const choose=mode=>document.getElementById('permission-menu').querySelector(`[data-value="${mode}"]`).click();
 return {controller,notices,label,fast,choose,get config(){return config;},setConfig(value){config=value;},setId(value){id=value;controller.restore();}};
}

test('a new draft defaults to auto review and sends its real approval fields without overriding model or Fast',()=>{
 const h=fixture(),before=structuredClone(h.config);
 assert.equal(h.label.textContent,'帮我批准');
 const snapshot=h.controller.snapshot();assert.deepEqual(snapshot,{permission:autoPermission,serviceTier:null});
 assert.deepEqual(h.controller.params(snapshot,'thread'),{approvalPolicy:'on-request',approvalsReviewer:'auto_review',sandbox:'workspace-write'});
 assert.deepEqual(h.controller.params(snapshot,'turn'),{approvalPolicy:'on-request',approvalsReviewer:'auto_review',sandboxPolicy:{type:'workspaceWrite'}});
 assert.equal(h.fast.checked,true,'Fast still follows its configured value');
 assert.deepEqual(h.config,before,'configuration is read-only');
});

test('Fast follows the thread override and advertised model tiers, including legacy catalogs',()=>{
 let model={serviceTiers:[{id:'priority'}]};
 const changes=[],h=fixture({model:()=>model,onFastChange:tier=>changes.push(tier)});
 assert.equal(h.fast.checked,true);
 h.fast.click();assert.equal(h.fast.checked,false);assert.equal(h.controller.snapshot().serviceTier,'default');assert.equal(h.controller.modelChangeTier(),'default');
 h.fast.click();assert.equal(h.controller.snapshot().serviceTier,'fast');
 h.controller.adopt('first');h.setId('first');
 model={serviceTiers:[],additionalSpeedTiers:[]};h.controller.render();
 assert.equal(h.fast.checked,false);assert.equal(h.fast.disabled,true);assert.equal(h.controller.snapshot().serviceTier,null);assert.equal(h.controller.modelChangeTier(),null);
 h.fast.click();assert.deepEqual(changes,['default','fast']);
 model={additionalSpeedTiers:['fast']};h.controller.render();
 assert.equal(h.fast.disabled,false);assert.equal(h.fast.checked,true);assert.equal(h.controller.snapshot().serviceTier,'fast');
 h.setId('old');h.controller.restore(null,'default');assert.equal(h.fast.checked,false);
 h.setId('first');assert.equal(h.fast.checked,true);
 h.setId(null);h.setConfig({serviceTier:null});model={defaultServiceTier:'priority'};h.controller.render();
 assert.equal(h.fast.checked,true);assert.equal(h.controller.snapshot().serviceTier,null);assert.equal(h.controller.modelChangeTier(),'fast');
});

test('an existing thread inherits configuration instead of gaining the new-draft permission override',()=>{
 const h=fixture({id:'existing'});
 assert.equal(h.label.textContent,'完全访问权限');
 assert.deepEqual(h.controller.snapshot(),{permission:null,serviceTier:null});
 assert.deepEqual(h.controller.params(h.controller.snapshot(),'thread'),{});
 assert.deepEqual(h.controller.params(h.controller.snapshot(),'turn'),{});
 h.setId(null);assert.deepEqual(h.controller.snapshot().permission,autoPermission);
 h.setId('existing');assert.equal(h.controller.snapshot().permission,null);
});

test('explicit choices survive draft adoption while the next new draft returns to auto review',()=>{
 for(const mode of ['request','full','custom']){
  const h=fixture();h.choose(mode);const selected=h.controller.snapshot();
  assert.equal(h.label.textContent,mode==='request'?'请求批准':mode==='full'?'完全访问权限':'自定义');
  assert.equal(selected.permission.approvalsReviewer,'user');
  // Composer adopts the created id before replacing its current draft thread.
  h.controller.adopt('created');h.setId('created');
  assert.deepEqual(h.controller.snapshot(),selected,mode);
  h.setId(null);assert.equal(h.label.textContent,'帮我批准');assert.deepEqual(h.controller.snapshot().permission,autoPermission);
  h.setId('created');assert.deepEqual(h.controller.snapshot(),selected,'revisiting preserves the explicit choice');
 }
});

test('restoring custom from the default auto mode needs complete configuration and preserves errors',()=>{
 const h=fixture({config:null});h.choose('custom');
 assert.equal(h.label.textContent,'帮我批准');assert.deepEqual(h.controller.snapshot().permission,autoPermission);
 assert.equal(h.notices.length,1);assert.match(h.notices[0][0],/配置权限尚未完整读取/);assert.equal(h.notices[0][1],true);
 h.setConfig({approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'workspace-write',sandboxPolicy:{type:'workspaceWrite',networkAccess:true},serviceTier:'default'});
 h.choose('custom');const snapshot=h.controller.snapshot();
 assert.equal(snapshot.permission.approvalsReviewer,'user');
 assert.deepEqual(h.controller.params(snapshot,'turn'),{approvalPolicy:'on-request',approvalsReviewer:'user',sandboxPolicy:{type:'workspaceWrite',networkAccess:true}});
 assert.equal(snapshot.serviceTier,null);
 h.setConfig({...h.config,sandboxPolicy:null});
 assert.throws(()=>h.controller.params(h.controller.snapshot(),'turn'),/沙箱策略.*草稿已保留/);
});

test('reopening a thread in a fresh client restores its own choice before issuing any overrides',async()=>{
 const saved=new Map(),store=async({threadId,mode})=>{if(mode)saved.set(threadId,mode);return {scope:'current-account',mode:saved.get(threadId)||null};};
 const first=fixture({id:'one',permissionStore:store});
 await first.controller.load('one'); first.choose('full');first.choose('request');
 await first.controller.load('one');
 const second=fixture({id:'one',permissionStore:store});
 assert.throws(()=>second.controller.snapshot(),/正在读取/);
 await second.controller.load('one');
 assert.equal(second.label.textContent,'请求批准');
 assert.deepEqual(second.controller.params(second.controller.snapshot(),'turn'),{approvalPolicy:'on-request',approvalsReviewer:'user',sandboxPolicy:{type:'workspaceWrite'}});
 second.setId('two');await second.controller.load('two');assert.deepEqual(second.controller.params(second.controller.snapshot(),'turn'),{});
 second.setId(null);assert.equal(second.label.textContent,'帮我批准');
});

test('a save receipt cannot unlock a pending cross-device read that saw a newer mode',async()=>{
 let saveFinish,readFinish,waitForRead;
 const saving=new Promise(resolve=>saveFinish=resolve);
 const reading=new Promise(resolve=>readFinish=resolve);
 const readStarted=new Promise(resolve=>waitForRead=resolve);
 let loadCount=0;
 const h=fixture({id:'one',permissionStore:async({mode})=>{
  if(mode)return saving;
  if(++loadCount===1)return {scope:'previous',mode:'request'};
  waitForRead();return reading;
 }});
 await h.controller.load('one');
 h.choose('auto');
 const sync=h.controller.changed({threadId:'one',scope:'current'});
 assert.throws(()=>h.controller.snapshot(),/正在保存/);
 saveFinish({scope:'previous',mode:'auto'});
 await readStarted;
 assert.throws(()=>h.controller.snapshot(),/正在同步/);
 readFinish({scope:'current',mode:'request'});await sync;
 assert.equal(h.label.textContent,'请求批准');
 assert.equal(h.controller.snapshot().permission.approvalsReviewer,'user');
});

test('disconnect invalidates pending reads and requires a fresh confirmed permission',async()=>{
 let finish;
 const held=new Promise(resolve=>finish=resolve);
 let calls=0;
 const h=fixture({id:'one',permissionStore:async()=>++calls===1?held:{scope:'current',mode:'request'}});
 const old=h.controller.load('one');h.controller.invalidate();
 finish({scope:'stale',mode:'auto'});await old;
 assert.throws(()=>h.controller.snapshot(),/正在同步/);
 await h.controller.load('one');
 assert.equal(h.controller.snapshot().permission.approvalsReviewer,'user');
});
