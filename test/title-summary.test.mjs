import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TitleSummaryService} from '../src/title-summary.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(check){for(let i=0;i<100;i++){if(check())return;await tick();}assert.fail('Condition did not settle');}
function fixture(options={}){
 const calls=[],names=new Map(),events=[];let service;
 const rpc={connected:true,respond(id,result,error){calls.push({method:'respond',id,error});},async call(method,params){
  calls.push({method,params:structuredClone(params)});
  if(method==='model/list')return {data:[{model:'chosen-model',displayName:'Chosen',hidden:false}],nextCursor:null};
  if(method==='mcpServerStatus/list')return {data:[{name:'safe-name',secret:'PRIVATE_MCP_CONFIG'}],nextCursor:null};
  if(method==='thread/read')return {thread:{id:params.threadId,name:names.get(params.threadId)||null}};
  if(method==='thread/start'){const thread={id:'summary',cwd:params.cwd,ephemeral:options.unsafe?false:true};service.observe({method:'thread/started',params:{thread}});return {thread,sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never',instructionSources:[]};}
  if(method==='turn/start'){service.observe({method:'turn/started',params:{threadId:'summary',turn:{id:'summary-turn'}}});if(!options.hold)setTimeout(()=>finish(),0);return {turn:{id:'summary-turn'}};}
  if(method==='thread/name/set'){names.set(params.threadId,params.name);service.observe({method:'thread/name/updated',params:{threadId:params.threadId,threadName:params.name}});return {};}
  return {};
 }};
 service=new TitleSummaryService(rpc,{onEvent:event=>events.push(event),...options});
 function finish(){service.observe({method:'item/started',params:{threadId:'summary',item:{type:'reasoning',id:'reason'}}});if(options.tool)service.observe({method:'item/started',params:{threadId:'summary',item:{type:'commandExecution',id:'tool'}}});else service.observe({method:'item/completed',params:{threadId:'summary',item:{type:'agentMessage',text:'{"title":"精简的测试标题"}'}}});service.observe({method:'turn/completed',params:{threadId:'summary',turn:{id:'summary-turn',status:'completed'}}});}
 function first(id='original',text='用户原文'){
  service.acknowledge('thread/start',{}, {thread:{id,name:null}});service.beforeRpc('turn/start',{threadId:id,input:[{type:'text',text},{type:'localImage',path:'PRIVATE_FILE'}]});service.observe({method:'turn/started',params:{threadId:id,turn:{id:'first'}}});service.observe({method:'turn/completed',params:{threadId:id,turn:{id:'first',status:'completed'}}});
 }
 return {service,rpc,calls,names,events,first,finish};
}

test('default off never lists models, starts inference, or renames; loaded history is never eligible',async()=>{
 const h=fixture();h.first();await h.service.queue;assert.deepEqual(h.calls,[]);assert.deepEqual(h.service.status(),{enabled:false,model:null,lastError:null});
 await h.service.configure({enabled:true,model:'chosen-model'});h.service.beforeRpc('turn/start',{threadId:'old',input:[{type:'text',text:'old'}]});h.service.observe({method:'turn/completed',params:{threadId:'old',turn:{id:'old-turn',status:'completed'}}});await h.service.queue;assert.equal(h.calls.filter(row=>row.method==='turn/start').length,0);await h.service.close();
});
test('one selected-model title inference uses an empty ephemeral cwd, restricted configuration and text-only input',async()=>{
 const h=fixture();await h.service.configure({enabled:true,model:'chosen-model'});h.first('original','用户原文'.repeat(2000));await h.service.queue;
 assert.equal(h.names.get('original'),'精简的测试标题');assert.equal(h.calls.filter(row=>row.method==='turn/start').length,1);
 const start=h.calls.find(row=>row.method==='thread/start').params,turn=h.calls.find(row=>row.method==='turn/start').params;
 assert.equal(start.ephemeral,true);assert.equal(start.sandbox,'read-only');assert.equal(start.model,'chosen-model');assert.equal(start.approvalPolicy,'never');assert.equal(start.config.features.shell_tool,false);assert.equal(start.config.web_search,'disabled');assert.deepEqual(start.config.mcp_servers,{'safe-name':{enabled:false}});assert.ok(!JSON.stringify(start).includes('PRIVATE_MCP_CONFIG'));assert.equal(start.config.project_doc_max_bytes,0);
 assert.equal(turn.threadId,'summary');assert.equal(turn.model,'chosen-model');assert.deepEqual(turn.sandboxPolicy,{type:'readOnly',networkAccess:false});assert.equal(JSON.parse(turn.input[0].text).user_text.length,4000);assert.ok(!JSON.stringify(turn.input).includes('PRIVATE_FILE'));assert.equal(turn.outputSchema.additionalProperties,false);await assert.rejects(fs.stat(start.cwd),{code:'ENOENT'});
 h.service.beforeRpc('turn/start',{threadId:'original',input:[{type:'text',text:'second'}]});h.service.observe({method:'turn/completed',params:{threadId:'original',turn:{id:'second',status:'completed'}}});await h.service.queue;assert.equal(h.calls.filter(row=>row.method==='turn/start').length,1);await h.service.close();
});
test('manual rename, a new original turn, and disabling cancel and interrupt an in-progress title',async()=>{
 for(const cancel of ['rename','next-turn','disable']){
  const h=fixture({hold:true});await h.service.configure({enabled:true,model:'chosen-model'});h.first();await until(()=>h.calls.some(row=>row.method==='turn/start'));
  if(cancel==='disable')await h.service.configure({enabled:false,model:'chosen-model'});else h.service.beforeRpc(cancel==='rename'?'thread/name/set':'turn/start',{threadId:'original',input:[{type:'text',text:'second'}]});
  await h.service.queue;assert.ok(h.calls.some(row=>row.method==='turn/interrupt'));assert.equal(h.names.size,0);assert.ok(h.calls.some(row=>row.method==='thread/unsubscribe'));await h.service.close();
 }
});
test('explicit tool activity, timeout, and unconfirmed ephemeral isolation fail without rename or retry',async()=>{
 for(const options of [{tool:true},{hold:true,timeoutMs:15},{unsafe:true}]){
  const h=fixture(options);await h.service.configure({enabled:true,model:'chosen-model'});h.first();await h.service.queue;assert.equal(h.names.size,0);assert.ok(h.service.lastError);assert.ok(h.calls.filter(row=>row.method==='turn/start').length<=1);if(!options.unsafe)assert.ok(h.calls.some(row=>row.method==='turn/interrupt'));await h.service.close();
 }
});
test('external title changes are reread before write; unrelated ephemeral events are not swallowed',async()=>{
 const h=fixture({hold:true});await h.service.configure({enabled:true,model:'chosen-model'});h.first();await until(()=>h.calls.some(row=>row.method==='turn/start'));assert.equal(h.service.observe({method:'thread/started',params:{thread:{id:'other-ephemeral',ephemeral:true,cwd:process.cwd()}}}),false);h.names.set('original','外部手动名称');h.finish();await h.service.queue;assert.equal(h.names.get('original'),'外部手动名称');assert.equal(h.calls.filter(row=>row.method==='thread/name/set').length,0);await h.service.close();
});
test('settings persist with selected model, startup stays read-only, and invalid or corrupt settings fail closed',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'title-settings-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const h=fixture({root});await h.service.load();await assert.rejects(h.service.configure({enabled:true,model:'not-listed'}),/列表/);await assert.rejects(h.service.configure({enabled:true,model:null}),/模型/);await h.service.configure({enabled:true,model:'chosen-model'});await h.service.close();
 const restored=fixture({root});await restored.service.load();assert.equal(restored.service.preferences.enabled,true);assert.equal(restored.service.preferences.model,'chosen-model');assert.deepEqual(restored.calls,[]);await restored.service.close();await fs.writeFile(path.join(root,'title-summary.json'),'BROKEN');const broken=fixture({root});await broken.service.load();assert.equal(broken.service.preferences.enabled,false);await assert.rejects(broken.service.configure({enabled:true,model:'chosen-model'}),/损坏/);assert.equal(await fs.readFile(path.join(root,'title-summary.json'),'utf8'),'BROKEN');await broken.service.close();
});

test('deadline settles a hung start and a late response is released without starting inference',async()=>{
 const h=fixture({timeoutMs:10});await h.service.configure({enabled:true,model:'chosen-model'});const base=h.rpc.call;let release;
 h.rpc.call=async(method,params)=>method==='thread/start'?new Promise(resolve=>{release=()=>resolve({thread:{id:'late-reader',ephemeral:true,cwd:params.cwd},approvalPolicy:'never',sandbox:{type:'readOnly'}});}):base(method,params);
 h.first();await h.service.queue;assert.ok(h.service.lastError.includes('超时'));assert.equal(h.calls.filter(row=>row.method==='turn/start').length,0);release();await tick();await tick();assert.ok(h.calls.some(row=>row.method==='thread/unsubscribe'&&row.params.threadId==='late-reader'));await h.service.close();
});

test('turn start unknown result interrupts an observed turn instead of only releasing its subscription',async()=>{
 const h=fixture();await h.service.configure({enabled:true,model:'chosen-model'});const base=h.rpc.call;h.rpc.call=async(method,params)=>{if(method==='turn/start'){h.service.observe({method:'turn/started',params:{threadId:'summary',turn:{id:'unknown-result'}}});throw Object.assign(new Error('RPC timeout'),{code:'RPC_TIMEOUT'});}return base(method,params);};h.first();await h.service.queue;assert.ok(h.calls.some(row=>row.method==='turn/interrupt'&&row.params.turnId==='unknown-result'));assert.equal(h.names.size,0);await h.service.close();
});

test('canceling while name mutation is pending emits no stale generated title',async()=>{
 const h=fixture();await h.service.configure({enabled:true,model:'chosen-model'});const base=h.rpc.call;let release;h.rpc.call=async(method,params)=>{if(method==='thread/name/set')return new Promise(resolve=>{release=resolve;});return base(method,params);};h.first();await until(()=>release);h.service.beforeRpc('thread/name/set',{threadId:'original',name:'手动名字'});release({});await h.service.queue;assert.equal(h.events.filter(row=>row.method==='thread/name/updated').length,0);assert.equal(h.service.observe({method:'thread/name/updated',params:{threadId:'original',threadName:'精简的测试标题'}}),true);await h.service.close();
});
