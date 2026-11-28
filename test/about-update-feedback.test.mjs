import test from 'node:test';
import assert from 'node:assert/strict';
import {mountAbout} from '../public/ui/about-view.js';
import {createDocument} from './mini-dom.mjs';

test('automatic update results appear on entry and while About is open, without another release check', async()=>{
  const document=createDocument(),host=document.createElement('div');
  const idle={currentVersion:'0.4.9',phase:'idle',supported:true};
  const available={...idle,phase:'available',updateTransport:'velopack',latest:{available:true,version:'0.5.0',notes:'新的更新说明',downloadBytes:12*1024*1024}};
  let finish;
  const calls=[];
  const view=mountAbout(host,{api:path=>{calls.push(path);return new Promise(resolve=>{finish=resolve;});}});
  view.update(available);
  const reading=view.activate();
  assert.match(host.textContent,/新版本 v0\.5\.0 · 桌面更新包 12\.0 MiB/);
  assert.match(host.textContent,/新的更新说明/);
  view.update({...available,preparedVersion:'0.5.0',phase:'ready'});
  finish(idle);
  await reading;
  assert.ok(host.querySelectorAll('button').some(button=>button.textContent==='安装更新'&&!button.disabled));
  view.update({...idle,phase:'upToDate'});
  assert.match(host.textContent,/当前已是最新版本/);
  assert.doesNotMatch(host.textContent,/新的更新说明/);
  assert.deepEqual(calls,['/api/app-update/status']);
  view.deactivate();
});

test('opening About renews expired release information once and only checks metadata',async()=>{
  const document=createDocument(),host=document.createElement('div');
  let status={currentVersion:'0.4.9',phase:'available',supported:true,requiresRecheck:true,latest:{available:true,version:'0.5.0'}};
  const calls=[];
  const view=mountAbout(host,{api:async path=>{
    calls.push(path);
    if(path==='/api/app-update/check')status={...status,requiresRecheck:false};
    return status;
  }});
  await view.activate();await view.activate();
  assert.equal(calls.filter(path=>path==='/api/app-update/check').length,1);
  assert.match(host.textContent,/下载更新/);
  view.deactivate();
});

for (const transport of ['velopack','msi']) {
  test(`${transport} confirms the correct exit behavior and shows progress until handoff`, async()=>{
    const document=createDocument(),host=document.createElement('div');
    const status={currentVersion:'0.4.9',latest:{version:'0.5.0',available:true},preparedVersion:'0.5.0',phase:'ready',supported:true,updateTransport:transport};
    let finish,lateRead,delayRead=false;
    const view=mountAbout(host,{api:async()=>delayRead?new Promise(resolve=>{lateRead=resolve;}):status,mutate:()=>new Promise(resolve=>{finish=resolve;})});
    await view.activate();
    const click=label=>host.querySelectorAll('button').find(button=>button.textContent===label).click();
    const inPlace=transport==='velopack';
    click(inPlace?'安装更新':'打开安装程序');
    assert.match(host.querySelector('.about-confirm').textContent,inPlace?/自动退出/:/完全退出/);
    click(inPlace?'退出并更新':'确认打开');
    assert.ok(host.querySelector('.about-download-progress'));
    assert.match(host.querySelector('.about-update-status').textContent,inPlace?/等待安装窗口/:/正在打开/);
    assert.ok(host.querySelectorAll('button').every(button=>button.disabled));
    delayRead=true;
    const polling=view.refresh();
    delayRead=false;
    const stale={...status};
    status.phase='launched';finish(status);
    await new Promise(resolve=>setImmediate(resolve));
    lateRead(stale);
    await polling;
    assert.equal(host.querySelector('.about-download-progress'),null);
    assert.match(host.querySelector('.about-update-message').textContent,inPlace?/更新窗口/:/完全退出/);
    assert.doesNotMatch(host.querySelector('.about-update-status').textContent,/安装成功|更新已完成/);
    view.deactivate();
  });
}

test('an idle recheck clears the previous install rejection without launching again',async()=>{
 const document=createDocument(),host=document.createElement('div');
 const status={currentVersion:'0.4.20',latest:{version:'0.4.21',available:true},preparedVersion:'0.4.21',phase:'ready',supported:true,updateTransport:'velopack',installBlocker:'还有 1 个对话正在运行'};
 let attempts=0;
 const view=mountAbout(host,{api:async()=>({...status}),mutate:async()=>{
  attempts++;throw Object.assign(new Error(status.installBlocker),{code:'APP_UPDATE_WORK_ACTIVE',outcome:'notExecuted'});
 }});
 try{
  await view.activate();
  for(const label of ['安装更新','退出并更新'])host.querySelectorAll('button').find(button=>button.textContent===label).click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(host.querySelector('.inline-error').textContent,/1 个对话/);
  status.installBlocker=null;await view.refresh();
  assert.equal(host.querySelector('.inline-error'),null);
  assert.equal(attempts,1);
 }finally{view.deactivate();}
});
