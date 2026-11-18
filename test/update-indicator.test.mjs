import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from './mini-dom.mjs';
import {updateIndicatorState,mountUpdateIndicator,mountAndroidUpdateIndicator} from '../public/ui/update-indicator.js';
import {startUpdateChecks} from '../public/ui/auto-update.js';
const available={supported:true,phase:'available',latest:{available:true,version:'0.4.4'}};
test('update affordance is hidden unless a supported actionable release is known',()=>{
 for(const status of [null,{}, {...available,demo:true},{...available,supported:false},{...available,latest:{available:false}},...['launched','launchUnknown'].map(phase=>({...available,phase}))])assert.equal(updateIndicatorState(status).visible,false);
 assert.equal(updateIndicatorState(available).visible,true);
});
test('phase copy distinguishes downloading, ready, failed and preparing',()=>{
 for(const [phase,label] of [['downloading','正在下载更新'],['ready','更新已就绪'],['failed','更新未完成，查看详情'],['launching','正在准备更新']])assert.equal(updateIndicatorState({...available,phase}).label,label);
});
test('indicator only navigates on click and remains keyboard accessible',()=>{
 const document=createDocument();const host=document.createElement('nav');host.append(document.createElement('span'));document.body.append(host);let opens=0;
 const indicator=mountUpdateIndicator(host,{onOpen:()=>opens++});const button=indicator.button;
 assert.equal(button.hidden,true);button.click();assert.equal(opens,0);
 indicator.update(available);assert.equal(button.hidden,false);assert.equal(button.type,'button');assert.match(button.getAttribute('aria-label'),/0.4.4/);assert.equal(button.title,'有可用更新');
 button.click();button.click();assert.equal(opens,2);assert.equal(host.querySelectorAll('button').length,1);
 indicator.update({...available,phase:'downloading'});assert.equal(button.dataset.busy,'true');
 indicator.update({...available,latest:{available:false}});assert.equal(button.hidden,true);
});
test('Android indicator reads the native state on change and opens the existing updater only',()=>{
 const document=createDocument(),host=document.createElement('nav'),window=new EventTarget();
 document.body.append(host);
 assert.equal(mountAndroidUpdateIndicator(host,window),null);
 let status={phase:'checking'},opens=0;
 window.CodexLightNative={getAppUpdateStatus:()=>JSON.stringify(status),openAppUpdate:()=>opens++};
 const {button}=mountAndroidUpdateIndicator(host,window);
 const setStatus=value=>{status=value;window.dispatchEvent(new Event('codexlight-android-update-status'));};
 assert.equal(button.hidden,true);
 setStatus({phase:'available',version:'0.5.0'});assert.equal(button.hidden,false);
 setStatus({phase:'verifying',version:'0.5.0'});assert.equal(button.title,'正在校验安装包');assert.equal(button.dataset.busy,'true');
 button.click();assert.equal(opens,1);
 setStatus({phase:'installed',version:'0.5.0'});assert.equal(button.hidden,true);
 setStatus({phase:'available',version:'https://invalid.example'});assert.equal(button.hidden,true);
});
test('automatic checks publish every result so a previously shown badge can clear',async()=>{
 let callback;const results=[];let count=0;const stop=startUpdateChecks({setTimer:fn=>(callback=fn,1),clearTimer(){},check:async()=>++count===1?available:{...available,latest:{available:false}},notify(){},onStatus:value=>results.push(value)});
 await callback();await callback();assert.equal(results.length,2);assert.equal(results[1].latest.available,false);stop();await callback();assert.equal(results.length,2);
});
test('automatic scheduler backs off, wakes stalled checks on reconnect, and never overlaps',async()=>{
 let callback,delay,checks=0,now=0,finish;const results=[];
 const stop=startUpdateChecks({
  check:async()=>{checks++;if(checks<=2)throw new Error('offline');return new Promise(resolve=>finish=resolve);},
  setTimer:(fn,ms)=>{callback=fn;delay=ms;return 1;},clearTimer(){},now:()=>now,
  onStatus:status=>results.push(status),interval:300_000,retry:60_000,maxRetry:90_000,
 });
 assert.equal(delay,3000);assert.equal(checks,0);
 now=3000;await callback();assert.equal(delay,60_000);
 now+=60_000;await callback();assert.equal(delay,90_000);
 now+=5000;stop.reconnect();assert.equal(delay,10_000);
 now+=10_000;const inFlight=callback();assert.equal(checks,3);
 stop.reconnect();await callback();assert.equal(checks,3);
 finish(available);await inFlight;assert.deepEqual(results,[available]);assert.equal(delay,300_000);
 stop.reconnect();assert.equal(delay,300_000);stop();await callback();assert.equal(checks,3);
});

