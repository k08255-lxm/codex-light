import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from './mini-dom.mjs';
import {updateIndicatorState,mountUpdateIndicator} from '../public/ui/update-indicator.js';
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
test('automatic checks publish every result so a previously shown badge can clear',async()=>{
 let callback;const results=[];let count=0;const stop=startUpdateChecks({setTimer:fn=>(callback=fn,1),clearTimer(){},check:async()=>++count===1?available:{...available,latest:{available:false}},notify(){},onStatus:value=>results.push(value)});
 await callback();await callback();assert.equal(results.length,2);assert.equal(results[1].latest.available,false);stop();await callback();assert.equal(results.length,2);
});

