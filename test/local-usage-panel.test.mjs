import test from 'node:test';import assert from 'node:assert/strict';
import {mountLocalUsagePanel,localUsageModels,localReferenceEstimates} from '../public/local-usage-panel.js';
class El{constructor(tag,doc){this.tag=tag;this.ownerDocument=doc;this.children=[];this.listeners={};this.value='';this.textContent='';this.classList={add(){}};this.attributes={};}append(...x){this.children.push(...x);}replaceChildren(...x){this.children=x;}setAttribute(k,v){this.attributes[k]=v;}addEventListener(k,f){this.listeners[k]=f;}focus(){this.focused=true;}set innerHTML(x){throw Error('forbidden');}}
const doc={createElement:t=>new El(t,doc)};const all=e=>[e,...e.children.flatMap(all)];const text=e=>all(e).map(n=>n.textContent).join(' ');const button=(r,s)=>all(r).find(n=>n.tag==='button'&&n.textContent===s);const tick=()=>new Promise(r=>setImmediate(r));
const data={filesRead:1,bytesRead:200,partial:true,diagnosticCounts:{'access-denied':1},sessions:[{threadId:'t',sourceId:'a',attribution:'observed-differences-only',snapshot:{totalTokens:5},increments:[{kind:'observed-cumulative-difference',timestamp:'server-time',model:'gpt-test',tokens:{totalTokens:2,inputTokens:2,outputTokens:0}}]}]};
test('no automatic API; explicit absolute scan; safe projection and no message HTML',async()=>{
 const root=new El('div',doc),calls=[];mountLocalUsagePanel(root,{api:async(p,b)=>{calls.push([p,b]);return data;}});assert.equal(calls.length,0);
 const input=all(root).find(n=>n.tag==='input');input.value='relative';await button(root,'扫描所选目录').listeners.click();assert.equal(calls.length,0);assert.equal(input.focused,true);
 input.value='/synthetic';await button(root,'扫描所选目录').listeners.click();assert.deepEqual(calls,[['/api/local-usage/scan',{directory:'/synthetic'}]]);assert.match(text(root),/覆盖不完整/);assert.match(text(root),/不与官方统计相加/);assert.match(text(root),/gpt-test/);
});
test('stop waiting ignores late scan but does not claim server cancelled',async()=>{
 const root=new El('div',doc);let resolve;mountLocalUsagePanel(root,{api:()=>new Promise(r=>resolve=r)});all(root).find(n=>n.tag==='input').value='/synthetic';const pending=button(root,'扫描所选目录').listeners.click();button(root,'停止等待').listeners.click();assert.match(text(root),/未确认已取消/);resolve(data);await pending;assert.ok(!text(root).includes('gpt-test'));
});
test('explicit price refresh only, unique known models, no deferred/WB/unknown estimates',async()=>{
 const enriched={...data,sessions:[...data.sessions,{...data.sessions[0]}, {attribution:'deferred',increments:[{model:'other'}]},{attribution:'observed-differences-only',increments:[{model:'unknown'},{model:'workbuddy'},{model:null}]}]};
 assert.deepEqual(localUsageModels(enriched),['gpt-test']);
 const root=new El('div',doc),calls=[];mountLocalUsagePanel(root,{api:async(p,b)=>{calls.push([p,b]);return p.includes('scan')?enriched:p.includes('refresh')?{fetchedAt:'server-time'}:{input:1,cacheRead:null,output:2};}});
 all(root).find(n=>n.tag==='input').value='/synthetic';await button(root,'扫描所选目录').listeners.click();assert.equal(calls.length,1);
 await button(root,'刷新参考价格（联网）').listeners.click();assert.deepEqual(calls.slice(1),[['/api/pricing/refresh',{}],['/api/pricing/model',{model:'gpt-test'}]]);assert.match(text(root),/不是完整历史/);assert.match(text(root),/未知/);
});
test('reset and destroy ignore stale replies and never retain path',async()=>{
 const root=new El('div',doc);let resolve;const panel=mountLocalUsagePanel(root,{api:()=>new Promise(r=>resolve=r)});const input=all(root).find(n=>n.tag==='input');input.value='/synthetic';const pending=button(root,'扫描所选目录').listeners.click();panel.reset();assert.equal(input.value,'');resolve(data);await pending;assert.ok(!text(root).includes('gpt-test'));panel.destroy();assert.equal(root.children.length,0);
});
test('errors are generic rather than raw path/credential exceptions',async()=>{
 const root=new El('div',doc);mountLocalUsagePanel(root,{api:async()=>{throw Error('SECRET raw path');}});all(root).find(n=>n.tag==='input').value='/synthetic';await button(root,'扫描所选目录').listeners.click();assert.match(text(root),/扫描失败/);assert.ok(!text(root).includes('SECRET'));
});
const price={provider:'openai',model:'gpt-test',currency:'USD',unit:'per-million-tokens',input:10,cacheRead:1,cacheWrite:20,output:30};
const usage={inputTokens:100,cachedInputTokens:40,cacheWriteInputTokens:10,outputTokens:20,reasoningOutputTokens:10,totalTokens:120};
const session={threadId:'thread',sourceId:'one',attribution:'observed-differences-only',snapshot:{totalTokens:999999},increments:[{record:4,model:'gpt-test',kind:'observed-cumulative-difference',tokens:usage}]};
test('reference estimate uses differences only and cache/reasoning are not added twice',()=>{
 const r=localReferenceEstimates({sessions:[session,session]},new Map([['gpt-test',price]]));
 assert.equal(r.groups[0].estimatedEntries,1);assert.ok(Math.abs(r.groups[0].estimatedUsd-0.00134)<1e-12);assert.equal(r.groups[0].unknownEntries,0);
});
test('unknown prices/counters remain unknown, not zero, and mismatched model prices rejected',()=>{
 for(const p of [{...price,input:null},{...price,model:'different'},undefined]){
 const r=localReferenceEstimates({sessions:[session]},new Map([['gpt-test',p]]));assert.equal(r.groups[0].estimatedUsd,null);assert.equal(r.groups[0].unknownEntries,1);
 }
 const missing={...session,increments:[{...session.increments[0],tokens:{...usage,cacheWriteInputTokens:null}}]};assert.equal(localReferenceEstimates({sessions:[missing]},new Map([['gpt-test',price]])).groups[0].estimatedUsd,null);
});
test('deferred and overlapping sources never priced, even if merge omitted overlap flag',()=>{
 const prices=new Map([['gpt-test',price]]);
 assert.equal(localReferenceEstimates({sessions:[{...session,attribution:'deferred'}]},prices).groups.length,0);
 assert.equal(localReferenceEstimates({sessions:[session],overlappingThreadIds:['thread']},prices).groups.length,0);
 assert.equal(localReferenceEstimates({sessions:[session,{...session,sourceId:'two'}]},prices).groups.length,0);
});
