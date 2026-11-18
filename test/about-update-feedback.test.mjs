import test from 'node:test';
import assert from 'node:assert/strict';
import {mountAbout} from '../public/ui/about-view.js';
import {createDocument} from './mini-dom.mjs';

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
