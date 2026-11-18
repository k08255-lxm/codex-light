import test from 'node:test';
import assert from 'node:assert/strict';
import {TitleSummaryService,localTitleFromText} from '../src/title-summary.mjs';

const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
async function until(check){for(let i=0;i<200;i++){if(check())return;await tick();}assert.fail('synthetic title job did not settle');}
function fixture({output='{"title":"模型标题"}',fail=false,hold=false,timeoutMs=1000}={}){
 const calls=[],events=[],names=new Map();let service;
 const rpc={respond(){},async call(method,params){
  calls.push({method,params});
  if(method==='model/list')return {data:[{model:'synthetic'}]};
  if(method==='thread/read')return {thread:{id:params.threadId,name:names.get(params.threadId)||null}};
  if(method==='thread/name/set'){names.set(params.threadId,params.name);service.observe({method:'thread/name/updated',params:{threadId:params.threadId,threadName:params.name}});return {};}
  if(method==='config/read')return {config:{}};
  if(method==='thread/start')return {thread:{id:'reader',cwd:params.cwd,ephemeral:true},approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},instructionSources:[]};
  if(method==='turn/start'){service.observe({method:'turn/started',params:{threadId:'reader',turn:{id:'summary'}}});if(!hold)setTimeout(finish,0);return {turn:{id:'summary'}};}
  return {};
 }};
 service=new TitleSummaryService(rpc,{timeoutMs,onEvent:event=>events.push(event)});
 function finish(){
  if(!fail)service.observe({method:'item/completed',params:{threadId:'reader',item:{type:'agentMessage',text:output}}});
  service.observe({method:'turn/completed',params:{threadId:'reader',turn:{id:'summary',status:fail?'failed':'completed',
   ...(fail?{error:{message:'标题 PRIVATE_API_KEY raw response'}}:{})}}});
 }
 async function first(text='**本地标题**。后续内容',complete=true){service.acknowledge('thread/start',{}, {thread:{id:'original',name:null}});await service.beforeRpc('turn/start',{threadId:'original',input:[{type:'text',text}]});service.observe({method:'turn/started',params:{threadId:'original',turn:{id:'first'}}});if(complete)service.observe({method:'turn/completed',params:{threadId:'original',turn:{id:'first',status:'completed'}}});}
 return {service,rpc,calls,events,names,first,finish};
}

test('local title removes markdown, fenced code, URLs and images and takes the first sentence',()=>{
 const cases=[
  ['# **标题** 与 `代码`。第二句','标题 与 代码'],
  ['```js\nconsole.log("secret");\n```\n> [文档](https://example.test/secret) ![图片](https://example.test/image) 怎么使用？','文档 怎么使用'],
  ['~~~python\nsecret = 1\n~~~\n## 本地总结\n另一行','本地总结'],
  ['[资料][ref] 第一段\n[ref]: https://example.test/private','资料 第一段'],
  ['1. hello **world**. More details','hello world'],
  ['> 第一行\n> 第二行','第一行'],
  ['![图片](https://example.test) ```secret``` https://example.test',null],
  ['```js\nsecret data\nmore secret',null],
  ['  \n ** __ ~~ ` ` \n',null],
  ['第一句！第二句','第一句'],
  ['hello! next','hello'],
  ['你好\u0000\u202e世界','你好世界'],
 ];
 for(const [input,expected] of cases)assert.equal(localTitleFromText(input),expected,input);
 assert.equal(localTitleFromText('中'.repeat(50)),'中'.repeat(19)+'…');
 assert.equal(localTitleFromText('a'.repeat(80)),'a'.repeat(47)+'…');
 assert.equal(localTitleFromText('中'.repeat(20)),'中'.repeat(20));
 assert.equal(localTitleFromText('👨‍👩‍👧‍👦'.repeat(40)),'👨‍👩‍👧‍👦'.repeat(19)+'…');
});

test('unconfigured model persists a short title without model calls or first-turn completion',async()=>{
 const h=fixture();await h.first(undefined,false);assert.equal(h.names.get('original'),'本地标题');assert.deepEqual(h.calls.map(row=>row.method),['thread/read','thread/name/set']);assert.equal(h.service.status().usedLocalFallback,true);await h.service.close();
});

test('empty cleaned message makes no fallback mutation',async()=>{
 const h=fixture();await h.first('```js\nsecret\n```\n![only image](https://example.test)');await h.service.queue;assert.equal(h.names.size,0);assert.equal(h.service.status().usedLocalFallback,false);await h.service.close();
});

test('model call errors are redacted and retain the local title',async()=>{
 const h=fixture({fail:true});await h.service.configure({enabled:true,model:'synthetic'});await h.first();await h.service.queue;assert.equal(h.names.get('original'),'本地标题');assert.equal(h.service.status().usedLocalFallback,true);assert.match(h.service.lastError,/失败/);assert.ok(!JSON.stringify(h.events).includes('PRIVATE'));assert.ok(!JSON.stringify(h.service.status()).includes('PRIVATE'));await h.service.close();
});

test('empty and invalid model responses preserve fallback',async()=>{
 for(const output of ['', 'not json PRIVATE', 'null','[]','{"title":""}','{"title":"   "}','{"title":23}','{"title":"a","extra":true}','{"title":"a\\nb"}',JSON.stringify({title:'x'.repeat(81)})]){
  const h=fixture({output});await h.service.configure({enabled:true,model:'synthetic'});await h.first();await h.service.queue;assert.equal(h.names.get('original'),'本地标题',output);assert.equal(h.service.status().usedLocalFallback,true);assert.match(h.service.lastError,/无效/);assert.equal(h.calls.filter(row=>row.method==='thread/name/set').length,1);await h.service.close();
 }
});

test('timeout retains fallback and late model success cannot revive the retired job',async t=>{
 const h=fixture({hold:true,timeoutMs:20});await h.service.configure({enabled:true,model:'synthetic'});
 const started=Promise.withResolvers(),call=h.rpc.call;
 h.rpc.call=async(method,params)=>{const result=await call(method,params);if(method==='turn/start')started.resolve();return result;};
 t.mock.timers.enable({apis:['setTimeout']});await h.first();await started.promise;t.mock.timers.tick(20);
 await h.service.queue;h.finish();
 assert.equal(h.names.get('original'),'本地标题');assert.match(h.service.lastError,/超时/);
 assert.equal(h.calls.filter(row=>row.method==='thread/name/set').length,1);await h.service.close();
});

test('successful model title replaces provisional local title through the same write path',async()=>{
 const h=fixture({hold:true});await h.service.configure({enabled:true,model:'synthetic'});await h.first();await until(()=>h.calls.some(row=>row.method==='turn/start'));assert.equal(h.names.get('original'),'本地标题');h.finish();await h.service.queue;assert.equal(h.names.get('original'),'模型标题');assert.deepEqual(h.calls.filter(row=>row.method==='thread/name/set').map(row=>row.params.name),['本地标题','模型标题']);assert.equal(h.service.status().usedLocalFallback,false);assert.equal(h.service.lastError,null);await h.service.close();
});

test('manual rename while model runs cancels replacement, including same-title rename',async()=>{
 for(const title of ['手动标题','本地标题']){
  const h=fixture({hold:true});await h.service.configure({enabled:true,model:'synthetic'});await h.first();await until(()=>h.calls.some(row=>row.method==='turn/start'));await h.service.beforeRpc('thread/name/set',{threadId:'original',name:title});await h.rpc.call('thread/name/set',{threadId:'original',name:title});h.finish();await h.service.queue;assert.equal(h.names.get('original'),title);assert.ok(!h.calls.some(row=>row.method==='thread/name/set'&&row.params.name==='模型标题'));await h.service.close();
 }
});

test('manual rename before local read settles prevents fallback mutation',async()=>{
 const h=fixture();let release;const base=h.rpc.call;h.rpc.call=(method,params)=>method==='thread/read'?new Promise(resolve=>{release=()=>resolve({thread:{name:null}});}):base(method,params);
 const first=h.first();await until(()=>release);const rename=h.service.beforeRpc('thread/name/set',{threadId:'original',name:'手动标题'});release();await rename;await first;await h.rpc.call('thread/name/set',{threadId:'original',name:'手动标题'});await h.service.queue;assert.equal(h.names.get('original'),'手动标题');assert.equal(h.calls.filter(row=>row.method==='thread/name/set').length,1);await h.service.close();
});

test('service close keeps pending and active first-message fallbacks without new inference',async()=>{
 for(const active of [false,true]){
  const h=fixture({hold:true});await h.service.configure({enabled:true,model:'synthetic'});await h.first(undefined,active);if(active)await until(()=>h.calls.some(row=>row.method==='turn/start'));await h.service.close();h.finish();assert.equal(h.names.get('original'),'本地标题');assert.equal(h.service.status().usedLocalFallback,true);assert.equal(h.calls.filter(row=>row.method==='thread/name/set').length,1);
 }
});
