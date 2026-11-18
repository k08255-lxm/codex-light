import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TitleSummaryService} from '../src/title-summary.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function until(check){for(let i=0;i<100;i++){if(check())return;await tick();}assert.fail('Condition did not settle');}
function fixture(options={}){
 const calls=[],names=new Map(),events=[];let service;
 const rpc={connected:true,respond(id,result,error){calls.push({method:'respond',id,error});},async call(method,params){
  calls.push({method,params:structuredClone(params)});
  if(method==='model/list')return {data:[{model:'chosen-model',displayName:'Chosen',hidden:false}],nextCursor:null};
  if(method==='config/read')return {config:{mcp_servers:{'safe-name':{secret:'PRIVATE_MCP_CONFIG'}}}};
  if(method==='thread/read')return {thread:{id:params.threadId,name:names.get(params.threadId)||null}};
  if(method==='thread/items/list')return {data:options.savedItems||[],nextCursor:null};
  if(method==='thread/start'){const thread={id:'summary',cwd:params.cwd,ephemeral:options.unsafe?false:true};service.observe({method:'thread/started',params:{thread}});return {thread,sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never',instructionSources:[],...options.startResponse};}
  if(method==='turn/start'){service.observe({method:'turn/started',params:{threadId:'summary',turn:{id:'summary-turn'}}});if(!options.hold)setTimeout(()=>finish(),0);return {turn:{id:'summary-turn'}};}
  if(method==='thread/name/set'){names.set(params.threadId,params.name);service.observe({method:'thread/name/updated',params:{threadId:params.threadId,threadName:params.name}});return {};}
  return {};
 }};
 service=new TitleSummaryService(rpc,{onEvent:event=>events.push(event),...options});
 function finish(){
  service.observe({method:'item/started',params:{threadId:'summary',item:{type:'reasoning',id:'reason'}}});
  if(options.tool)service.observe({method:'item/started',params:{threadId:'summary',item:{type:'commandExecution',id:'tool'}}});
  else if(!options.turnError)service.observe({method:'item/completed',params:{threadId:'summary',item:{type:'agentMessage',text:options.text??'{"title":"精简的测试标题"}'}}});
  service.observe({method:'turn/completed',params:{threadId:'summary',turn:{id:'summary-turn',status:options.turnError?'failed':'completed',error:options.turnError}}});
 }
 function first(id='original',text='用户原文'){
  service.acknowledge('thread/start',{}, {thread:{id,name:null}});service.beforeRpc('turn/start',{threadId:id,input:[{type:'text',text},{type:'localImage',path:'PRIVATE_FILE'}]});service.observe({method:'turn/started',params:{threadId:id,turn:{id:'first'}}});service.observe({method:'turn/completed',params:{threadId:id,turn:{id:'first',status:'completed'}}});
 }
 return {service,rpc,calls,names,events,first,finish};
}

test('default off uses a local title without model inference; loaded history is never eligible',async()=>{
 const h=fixture();h.first();await h.service.queue;assert.deepEqual(h.calls.map(row=>row.method),['thread/read','thread/name/set']);assert.equal(h.names.get('original'),'用户原文');assert.deepEqual(h.service.status(),{enabled:false,model:null,lastError:'未启用标题模型，使用本地标题。',usedLocalFallback:true});
 await h.service.configure({enabled:true,model:'chosen-model'});h.service.beforeRpc('turn/start',{threadId:'old',input:[{type:'text',text:'old'}]});h.service.observe({method:'turn/completed',params:{threadId:'old',turn:{id:'old-turn',status:'completed'}}});await h.service.queue;assert.equal(h.calls.filter(row=>row.method==='turn/start').length,0);await h.service.close();
});
test('one selected-model title inference uses an empty ephemeral cwd, restricted configuration and text-only input',async()=>{
 const h=fixture();await h.service.configure({enabled:true,model:'chosen-model'});h.first('original','用户原文'.repeat(2000));await h.service.queue;
 assert.equal(h.names.get('original'),'精简的测试标题');assert.equal(h.calls.filter(row=>row.method==='turn/start').length,1);
 const start=h.calls.find(row=>row.method==='thread/start').params,turn=h.calls.find(row=>row.method==='turn/start').params;
 assert.equal(start.ephemeral,true);assert.equal(start.sandbox,'read-only');assert.equal(start.model,'chosen-model');assert.equal(start.approvalPolicy,'never');assert.equal(start.config.features.shell_tool,false);assert.equal(start.config.features.hooks,false);assert.equal(start.config.features.goals,false);assert.equal(start.config.tools.experimental_request_user_input.enabled,false);assert.equal(start.experimentalRawEvents,true);assert.equal(start.config.web_search,'disabled');assert.deepEqual(start.config.mcp_servers,{'safe-name':{enabled:false}});assert.ok(!JSON.stringify(start).includes('PRIVATE_MCP_CONFIG'));assert.equal(start.config.project_doc_max_bytes,0);
 assert.equal(turn.threadId,'summary');assert.equal(turn.model,'chosen-model');assert.deepEqual(turn.sandboxPolicy,{type:'readOnly',networkAccess:false});assert.equal(JSON.parse(turn.input[0].text).user_text.length,4000);assert.ok(!JSON.stringify(turn.input).includes('PRIVATE_FILE'));assert.equal(turn.outputSchema.additionalProperties,false);await assert.rejects(fs.stat(start.cwd),{code:'ENOENT'});
 h.service.beforeRpc('turn/start',{threadId:'original',input:[{type:'text',text:'second'}]});h.service.observe({method:'turn/completed',params:{threadId:'original',turn:{id:'second',status:'completed'}}});await h.service.queue;assert.equal(h.calls.filter(row=>row.method==='turn/start').length,1);await h.service.close();
});
test('explicit title summary reuses the selected model and excludes saved attachments and assistant content',async()=>{
 const h=fixture({savedItems:[
  {item:{type:'userMessage',content:[{type:'text',text:'检查发布流程\n用户选择的本地附件（仅路径引用，内容尚未读取；请按当前权限读取，不执行或自动解包）：PRIVATE_FILE'},{type:'localImage',path:'PRIVATE_IMAGE'}]}},
  {item:{type:'agentMessage',text:'PRIVATE_ASSISTANT'}},
  {item:{type:'userMessage',content:[{type:'text',text:'修正文档'}]}},
 ]});
 h.names.set('original','原来的名称');
 await h.service.configure({enabled:true,model:'chosen-model'});
 const result=await h.service.summarizeSavedThread({id:'original',name:'原来的名称'});
 assert.deepEqual(result,{threadId:'original',name:'精简的测试标题'});
 assert.equal(h.names.get('original'),'精简的测试标题');
 const turns=h.calls.filter(row=>row.method==='turn/start');assert.equal(turns.length,1);
 assert.deepEqual(JSON.parse(turns[0].params.input[0].text),{user_text:'检查发布流程\n修正文档'});
 assert.equal(turns[0].params.model,'chosen-model');
 await h.service.close();
});
test('manual rename and disabling cancel and interrupt an in-progress title',async()=>{
 for(const cancel of ['rename','disable']){
  const h=fixture({hold:true});await h.service.configure({enabled:true,model:'chosen-model'});h.first();await until(()=>h.calls.some(row=>row.method==='turn/start'));
  if(cancel==='disable')await h.service.configure({enabled:false,model:'chosen-model'});else h.service.beforeRpc('thread/name/set',{threadId:'original',name:'手动名称'});
  await h.service.queue;assert.ok(h.calls.some(row=>row.method==='turn/interrupt'));assert.equal(h.names.get('original'),'用户原文');assert.ok(h.calls.some(row=>row.method==='thread/unsubscribe'));await h.service.close();
 }
});

test('leaving during the first response or title generation does not cancel its title',async()=>{
 for(const phase of ['first-turn','summarizing']){
  const h=fixture({hold:phase==='summarizing'});await h.service.configure({enabled:true,model:'chosen-model'});
  if(phase==='first-turn'){
   h.service.acknowledge('thread/start',{}, {thread:{id:'original',name:null}});
   h.service.beforeRpc('turn/start',{threadId:'original',input:[{type:'text',text:'首条消息'}]});
   h.service.observe({method:'turn/started',params:{threadId:'original',turn:{id:'first'}}});
   h.service.beforeRpc('thread/unsubscribe',{threadId:'original'});
   h.service.observe({method:'turn/completed',params:{threadId:'original',turn:{id:'first',status:'completed'}}});
  }else{
   h.first();await until(()=>h.calls.some(row=>row.method==='turn/start'));
   h.service.beforeRpc('thread/unsubscribe',{threadId:'original'});h.finish();
  }
  await h.service.queue;
  assert.equal(h.names.get('original'),'精简的测试标题',phase);
  assert.equal(h.calls.filter(row=>row.method==='turn/start').length,1,'navigation never duplicates title inference');
  await h.service.close();
 }
});

test('continuing the original conversation while summarizing preserves the first text and one title inference',async()=>{
 const h=fixture({hold:true});await h.service.configure({enabled:true,model:'chosen-model'});h.first('original','第一条原文');
 await until(()=>h.calls.some(row=>row.method==='turn/start'));
 h.service.beforeRpc('turn/start',{threadId:'original',input:[{type:'text',text:'第二条问题'}]});
 h.service.observe({method:'turn/started',params:{threadId:'original',turn:{id:'second'}}});
 h.service.observe({method:'turn/completed',params:{threadId:'original',turn:{id:'second',status:'completed'}}});
 h.finish();await h.service.queue;
 assert.equal(h.names.get('original'),'精简的测试标题');
 const turns=h.calls.filter(row=>row.method==='turn/start');assert.equal(turns.length,1);
 assert.deepEqual(JSON.parse(turns[0].params.input[0].text),{user_text:'第一条原文'});
 assert.ok(!h.calls.some(row=>row.method==='turn/interrupt'));
 await h.service.close();
});

test('an original second turn cannot cancel a queued first-turn title or resurrect canceled work',async()=>{
 const h=fixture();await h.service.configure({enabled:true,model:'chosen-model'});
 let release;const gate=new Promise(resolve=>{release=resolve;});h.service.queue=gate;
 h.first('queued','排队的第一条原文');
 h.service.beforeRpc('turn/start',{threadId:'queued',input:[{type:'text',text:'第二条'}]});
 h.service.observe({method:'turn/started',params:{threadId:'queued',turn:{id:'second'}}});
 h.service.observe({method:'turn/completed',params:{threadId:'queued',turn:{id:'second',status:'completed'}}});
 const queue=h.service.queue;release();await queue;
 assert.equal(h.names.get('queued'),'精简的测试标题');assert.equal(h.calls.filter(row=>row.method==='turn/start').length,1);
 h.service.observe({method:'turn/completed',params:{threadId:'queued',turn:{id:'first',status:'completed'}}});
 await h.service.queue;assert.equal(h.calls.filter(row=>row.method==='turn/start').length,1);
 await h.service.close();
 const canceled=fixture();await canceled.service.configure({enabled:true,model:'chosen-model'});
 canceled.service.acknowledge('thread/start',{}, {thread:{id:'canceled',name:null}});
 canceled.service.beforeRpc('turn/start',{threadId:'canceled',input:[{type:'text',text:'用户原文'}]});
 canceled.service.observe({method:'turn/started',params:{threadId:'canceled',turn:{id:'first'}}});
 canceled.service.beforeRpc('thread/archive',{threadId:'canceled'});
 canceled.service.observe({method:'turn/completed',params:{threadId:'canceled',turn:{id:'first',status:'completed'}}});
 await canceled.service.queue;assert.equal(canceled.calls.filter(row=>row.method==='turn/start').length,0);
 await canceled.service.close();
});

test('named new threads and later explicit title changes are preserved without summary inference',async()=>{
 const h=fixture();await h.service.configure({enabled:true,model:'chosen-model'});
 h.service.acknowledge('thread/start',{}, {thread:{id:'named',name:'自定标题',preview:'首条原文'}});
 h.service.beforeRpc('turn/start',{threadId:'named',input:[{type:'text',text:'首条原文'}]});
 h.service.observe({method:'turn/started',params:{threadId:'named',turn:{id:'first'}}});
 h.service.observe({method:'turn/completed',params:{threadId:'named',turn:{id:'first',status:'completed'}}});
 await h.service.queue;assert.equal(h.calls.filter(row=>row.method==='turn/start').length,0);
 h.service.acknowledge('thread/start',{}, {thread:{id:'changed',name:null}});
 h.service.beforeRpc('turn/start',{threadId:'changed',input:[{type:'text',text:'首条原文'}]});
 h.service.observe({method:'turn/started',params:{threadId:'changed',turn:{id:'first'}}});
 h.service.observe({method:'thread/name/updated',params:{threadId:'changed',threadName:'其他客户端命名'}});
 h.service.observe({method:'turn/completed',params:{threadId:'changed',turn:{id:'first',status:'completed'}}});
 await h.service.queue;assert.equal(h.calls.filter(row=>row.method==='turn/start').length,0);
 await h.service.close();
});
test('explicit tool activity and unconfirmed ephemeral isolation retain local fallback without retry',async()=>{
 for(const options of [{tool:true},{unsafe:true}]){
  const h=fixture(options);await h.service.configure({enabled:true,model:'chosen-model'});h.first();await h.service.queue;assert.equal(h.names.get('original'),'用户原文');assert.ok(h.service.lastError);assert.ok(h.calls.filter(row=>row.method==='turn/start').length<=1);if(!options.unsafe)assert.ok(h.calls.some(row=>row.method==='turn/interrupt'));await h.service.close();
 }
});

test('deadline interrupts the started title turn and retains the local fallback without retry',{timeout:10000},async t=>{
 const h=fixture({hold:true,timeoutMs:15});t.after(()=>h.service.close());
 await h.service.configure({enabled:true,model:'chosen-model'});
 const base=h.rpc.call,started=deferred();
 h.rpc.call=async(method,params)=>{const result=await base(method,params);if(method==='turn/start')started.resolve();return result;};
 // Preparation includes real filesystem IO. Advance the deadline only after the mocked turn exists.
 t.mock.timers.enable({apis:['setTimeout']});h.first();await started.promise;
 t.mock.timers.tick(15);await h.service.queue;
 assert.equal(h.names.get('original'),'用户原文');assert.match(h.service.lastError,/超时/);
 assert.equal(h.calls.filter(row=>row.method==='turn/start').length,1);
 assert.deepEqual(h.calls.filter(row=>row.method==='turn/interrupt').map(row=>row.params),[{threadId:'summary',turnId:'summary-turn'}]);
 assert.ok(h.calls.some(row=>row.method==='thread/unsubscribe'&&row.params.threadId==='summary'));
});

test('deadline before title startup retains the fallback without starting or interrupting a nonexistent turn',{timeout:10000},async t=>{
 const h=fixture({hold:true,timeoutMs:15});t.after(()=>h.service.close());
 await h.service.configure({enabled:true,model:'chosen-model'});
 const base=h.rpc.call,preparing=deferred(),release=deferred();
 h.rpc.call=async(method,params)=>{if(method==='config/read'){preparing.resolve();await release.promise;}return base(method,params);};
 t.mock.timers.enable({apis:['setTimeout']});h.first();await preparing.promise;
 t.mock.timers.tick(15);await h.service.queue;
 assert.equal(h.names.get('original'),'用户原文');assert.match(h.service.lastError,/超时/);
 assert.equal(h.calls.filter(row=>row.method==='thread/start'||row.method==='turn/start'||row.method==='turn/interrupt').length,0);
 release.resolve();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.calls.filter(row=>row.method==='thread/start'||row.method==='turn/start'||row.method==='turn/interrupt').length,0,'late preparation never revives the expired job');
});
test('external title changes are reread before write; unrelated ephemeral events are not swallowed',async()=>{
 const h=fixture({hold:true});await h.service.configure({enabled:true,model:'chosen-model'});h.first();await until(()=>h.calls.some(row=>row.method==='turn/start'));assert.equal(h.service.observe({method:'thread/started',params:{thread:{id:'other-ephemeral',ephemeral:true,cwd:process.cwd()}}}),false);h.names.set('original','外部手动名称');h.finish();await h.service.queue;assert.equal(h.names.get('original'),'外部手动名称');assert.equal(h.calls.filter(row=>row.method==='thread/name/set').length,1);await h.service.close();
});
test('settings persist with selected model, startup stays read-only, and invalid or corrupt settings fail closed',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'title-settings-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const h=fixture({root});await h.service.load();await assert.rejects(h.service.configure({enabled:true,model:'not-listed'}),/列表/);await assert.rejects(h.service.configure({enabled:true,model:null}),/模型/);await h.service.configure({enabled:true,model:'chosen-model'});await h.service.close();
 const restored=fixture({root});await restored.service.load();assert.equal(restored.service.preferences.enabled,true);assert.equal(restored.service.preferences.model,'chosen-model');assert.deepEqual(restored.calls,[]);await restored.service.close();await fs.writeFile(path.join(root,'title-summary.json'),'BROKEN');const broken=fixture({root});await broken.service.load();assert.equal(broken.service.preferences.enabled,false);await assert.rejects(broken.service.configure({enabled:true,model:'chosen-model'}),/损坏/);assert.equal(await fs.readFile(path.join(root,'title-summary.json'),'utf8'),'BROKEN');await broken.service.close();
});

test('deadline settles a hung start and a late response is released without starting inference',{timeout:10000},async t=>{
 const h=fixture({timeoutMs:10});t.after(()=>h.service.close());await h.service.configure({enabled:true,model:'chosen-model'});
 const base=h.rpc.call,starting=deferred(),released=deferred();let release;
 h.rpc.call=async(method,params)=>{
  if(method==='thread/start')return new Promise(resolve=>{release=()=>resolve({thread:{id:'late-reader',ephemeral:true,cwd:params.cwd},approvalPolicy:'never',sandbox:{type:'readOnly'}});starting.resolve();});
  const result=await base(method,params);if(method==='thread/unsubscribe'&&params.threadId==='late-reader')released.resolve();return result;
 };
 t.mock.timers.enable({apis:['setTimeout']});h.first();await starting.promise;t.mock.timers.tick(10);await h.service.queue;
 assert.ok(h.service.lastError.includes('超时'));assert.equal(h.calls.filter(row=>row.method==='turn/start').length,0);
 release();await released.promise;assert.ok(h.calls.some(row=>row.method==='thread/unsubscribe'&&row.params.threadId==='late-reader'));
 assert.equal(h.calls.filter(row=>row.method==='turn/start').length,0,'late thread start cannot start title inference');
});

test('turn start unknown result interrupts an observed turn instead of only releasing its subscription',async()=>{
 const h=fixture();await h.service.configure({enabled:true,model:'chosen-model'});const base=h.rpc.call;h.rpc.call=async(method,params)=>{if(method==='turn/start'){h.service.observe({method:'turn/started',params:{threadId:'summary',turn:{id:'unknown-result'}}});throw Object.assign(new Error('RPC timeout'),{code:'RPC_TIMEOUT'});}return base(method,params);};h.first();await h.service.queue;assert.ok(h.calls.some(row=>row.method==='turn/interrupt'&&row.params.turnId==='unknown-result'));assert.equal(h.names.get('original'),'用户原文');await h.service.close();
});

test('canceling while name mutation is pending emits no stale generated title',async()=>{
 const h=fixture();await h.service.configure({enabled:true,model:'chosen-model'});const base=h.rpc.call;let release;h.rpc.call=async(method,params)=>{if(method==='thread/name/set')return new Promise(resolve=>{release=resolve;});return base(method,params);};h.first();await until(()=>release);h.service.beforeRpc('thread/name/set',{threadId:'original',name:'手动名字'});release({});await h.service.queue;assert.equal(h.events.filter(row=>row.method==='thread/name/updated').length,0);assert.equal(h.service.observe({method:'thread/name/updated',params:{threadId:'original',threadName:'用户原文'}}),true);await h.service.close();
});

test('isolation accepts only the initialized engine’s own global files in native and WSL paths',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'title-instruction-scope-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'AGENTS.md'),'synthetic global');
 await fs.writeFile(path.join(root,'AGENTS.override.md'),'synthetic global override');
 const linuxHome='/home/selected/.codex';
 const scenarios=[
  {engineHome:root,sources:[path.join(root,'AGENTS.md')],allowed:true},
  {engineHome:linuxHome,sources:[linuxHome+'/AGENTS.override.md'],allowed:true},
  {engineHome:linuxHome,sources:['/home/another/.codex/AGENTS.md'],allowed:false},
  {engineHome:linuxHome,sources:[linuxHome+'/project/AGENTS.md'],allowed:false},
  {engineHome:linuxHome,sources:[linuxHome+'/AGENTS_OVERRIDE.md'],allowed:false},
  {engineHome:linuxHome,sources:[linuxHome+'/agents.md'],allowed:false},
  {engineHome:linuxHome,sources:undefined,allowed:false},
 ];
 for(const {engineHome,sources,allowed} of scenarios){
  const h=fixture({scratchRoot:root,codexHome:'/unused-fallback',
   toHost:file=>engineHome===root?file:path.join(root,path.posix.basename(file)),
   startResponse:{instructionSources:sources}});
  h.rpc.codexHome=engineHome;
  await h.service.configure({enabled:true,model:'chosen-model'});h.first();await h.service.queue;
  assert.equal(h.calls.filter(row=>row.method==='turn/start').length,allowed?1:0);
  assert.equal(h.names.get('original'),allowed?'精简的测试标题':'用户原文');
  if(!allowed)assert.match(h.service.lastError,/只读隔离|额外指令/);
  assert.equal(h.calls.filter(row=>row.method==='thread/unsubscribe').length,1);
  await h.service.close();
 }
});

test('one preview may run at a time; account change cancels it before it can rename anything',async()=>{
 const h=fixture({hold:true});
 const preview=h.service.testModel({model:'chosen-model'});
 await assert.rejects(h.service.testModel({model:'chosen-model'}),{status:409});
 await until(()=>h.calls.some(row=>row.method==='turn/start'));
 assert.equal(h.service.observe({method:'account/updated',params:{}}),false);
 await assert.rejects(preview,/取消/);
 assert.equal(h.calls.filter(row=>row.method==='turn/interrupt').length,1);
 assert.equal(h.calls.filter(row=>row.method==='thread/unsubscribe').length,1);
 assert.equal(h.calls.filter(row=>row.method==='thread/name/set').length,0);
 assert.equal(h.service.lastError,null);
 await h.service.close();
});

test('a preview deadline includes model catalog lookup; a late page cannot start another request',async t=>{
 const h=fixture({timeoutMs:15});
 const waiting=deferred(),catalog=deferred();h.rpc.call=async(method)=>{assert.equal(method,'model/list');waiting.resolve();return catalog.promise;};
 t.mock.timers.enable({apis:['setTimeout']});
 const preview=h.service.testModel({model:'chosen-model'});await waiting.promise;
 t.mock.timers.tick(15);await assert.rejects(preview,/超时/);
 catalog.resolve({data:[{model:'chosen-model'}],nextCursor:'more'});
 await h.service.close();
 assert.equal(h.service.jobs.size,0);
});

test('a deadline during local scratch preparation reports timeout and skips inference',async t=>{
 const scratchRoot=await fs.mkdtemp(path.join(os.tmpdir(),'title-slow-scratch-'));
 t.after(()=>fs.rm(scratchRoot,{recursive:true,force:true}));
 const h=fixture({scratchRoot,timeoutMs:15});
 const waiting=deferred(),allow=deferred(),lstat=fs.lstat;
 t.mock.method(fs,'lstat',async (...args)=>{
  if(args[0]===scratchRoot){waiting.resolve();await allow.promise;}
  return lstat(...args);
 });
 t.mock.timers.enable({apis:['setTimeout']});
 const preview=h.service.testModel({model:'chosen-model'});
 await waiting.promise;t.mock.timers.tick(15);allow.resolve();
 await assert.rejects(preview,/超时/);
 assert.ok(!h.calls.some(row=>['config/read','thread/start','turn/start'].includes(row.method)));
 assert.deepEqual(await fs.readdir(scratchRoot),[]);
 await h.service.close();
});

test('upstream failures are concise, classified, and never surface raw strings; preview preserves status',async()=>{
 const cases=[
  ['Unauthorized 401 SECRET_TOKEN',/认证失败/],
  ['429 insufficient_quota SECRET_TOKEN',/额度或速率/],
  ['model_not_found SECRET_TOKEN',/所选模型.*不可用/],
  ['content_policy_violation SECRET_TOKEN',/拒绝处理/],
  ['Stream disconnected SECRET_TOKEN',/连接中断/],
  ['Unrecognized failure SECRET_TOKEN',/模型生成标题失败/],
 ];
 for(const [message,pattern] of cases){
  const h=fixture({turnError:{message}});
  await assert.rejects(h.service.testModel({model:'chosen-model'}),error=>pattern.test(error.message)&&!error.message.includes('SECRET_TOKEN'));
  assert.equal(h.service.lastError,null);
  assert.equal(h.calls.filter(row=>row.method==='turn/start').length,1);
  assert.equal(h.calls.filter(row=>row.method==='thread/unsubscribe').length,1);
  await h.service.close();
 }
});
