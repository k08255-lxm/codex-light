import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {notifyConnectionLost,pendingForScope,sendAvailability} from '../public/submissions.js';import {createWorkbench} from '../public/ui/workbench-view.js';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
function functionSource(name,nextName){const start=app.indexOf(`function ${name}(`),end=app.indexOf(`function ${nextName}(`,start);assert.ok(start>=0&&end>start,`${name} function boundary`);return app.slice(start,end);}

function workbenchHarness({visible=true,mounted}={}){
 const nodes=new Map(),handlers=new Map(),calls={mutations:[],views:[],restored:[],lost:0};
 const $=id=>{if(!nodes.has(id))nodes.set(id,{id,textContent:'',disabled:false,title:'',addEventListener(type,fn){handlers.set(id+':'+type,fn);},setAttribute(){},replaceChildren(){},append(){},classList:{toggle(){},add(){},remove(){},contains:name=>name==='hidden'&&id==='terminal-page'&&!visible}});return nodes.get(id);};
 const view=mounted||{open:async()=>{},restore:async id=>{calls.restored.push(id);},connectionLost(){calls.lost++;},dispose(){}};
 const wb=createWorkbench({document:{},state:{connected:true,cwd:'/project'},$,el:()=>({}),api:async()=>({}),notice(){},confirm:()=>false,
  performMutation:async(method,body)=>{calls.mutations.push([method,body]);return {processId:'p-1'};},scopedPending:()=>[],pendingMutations:{storageError:null},pendingReconcileErrors:new Map(),eventSubscribers:new Set(),showTerminal(){},openSettings(){},
  loadTerminal:async()=>({mountTerminal:options=>{calls.views.push(options);return view;}})});
 return {wb,calls,click:id=>handlers.get(id+':click')(),view};
}
test('official account usage stays account-scoped and context usage replaces rather than sums',async()=>{const account=await readFile(new URL('../public/ui/account-view.js',import.meta.url),'utf8');assert.match(account,/rpc\('account\/usage\/read', \{\}\)/);assert.doesNotMatch(account,/statistics\/query/);assert.match(app,/const snapshot=contextSnapshot\(message\.params\);if\(snapshot\)\{state\.contexts\.set\(snapshot\.threadId,snapshot\)/,'token usage updates replace the per-thread context snapshot');assert.doesNotMatch(app,/contexts\.get\([^)]*\)\s*\+|totalTokens\s*\+=/,'usage notifications are never summed');});
test('terminal opens through operation ledger and restores without another open',async()=>{
 const h=workbenchHarness();await h.click('terminal-open');
 assert.equal(h.calls.views.length,1,'one view mounted by an explicit click');
 await h.calls.views[0].api('/api/terminal/open',{cwd:'/project'});
 assert.deepEqual(h.calls.mutations,[['terminal/open',{cwd:'/project'}]],'open goes through the operation ledger');
 assert.equal(h.wb.snapshot().processId,'p-1');
 await h.click('terminal-restore');
 assert.deepEqual(h.calls.restored,['p-1'],'restore reconnects the existing process');assert.equal(h.calls.mutations.length,1,'restore does not open another');
});
test('unrelated unknown operations leave chat and terminal available; each own scope remains guarded',()=>{
 const state={thread:{id:'current'},connected:true,serverInstance:'a'.repeat(32),sending:false,loadingThread:false,busy:false,uploadingImages:false,cwd:'/project'};
 const pendingMutations={storageError:null};let records=[];const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'draft'});return nodes.get(id);};
 const scopedPending=(scope,options)=>pendingForScope(records,scope,options);
 const availability=new Function('state','pendingMutations','chatPendingRecords','sendAvailability','$','attachmentDraft','fileAttachmentDraft',`${functionSource('currentSendAvailability','updateControls')};return currentSendAvailability;`)(state,pendingMutations,()=>scopedPending('chat',{threadId:state.thread?.id}),sendAvailability,$,{values:()=>[]},{values:()=>[]});
 // Real workbench module with the same lookup; terminalControls derives Open from scoped terminal markers only.
 const wb=createWorkbench({document:{},state,$:id=>{const node=$(id);node.addEventListener??=()=>{};node.setAttribute??=()=>{};node.classList??={toggle(){},add(){},remove(){},contains:()=>false};return node;},el:()=>({}),api:async()=>{},notice(){},confirm:()=>false,performMutation:async()=>{},scopedPending,pendingMutations,pendingReconcileErrors:new Map(),eventSubscribers:new Set(),showTerminal(){},openSettings(){}});
 const terminal=wb.terminalControls;
 for(const method of ['runtime/upgrade','git/apply','plugin/apply','config/apply','account/start','remoteControl/enable','turn/interrupt','thread/name/set','thread/archive','thread/fork']){
  records=[{method,threadId:'current',status:'unknown'}];terminal();assert.equal($('terminal-open').disabled,false,method);assert.equal(availability().disabled,false,method);
 }
 records=[{method:'turn/start',threadId:'other',status:'unknown'}];assert.equal(availability().disabled,false,'other conversation');
 for(const method of ['turn/start','review/start']){records=[{method,threadId:'current',status:'unknown'}];assert.equal(availability().disabled,true,method);terminal();assert.equal($('terminal-open').disabled,false,method);}
 records=[{method:'thread/start',threadId:null,status:'unknown'}];assert.equal(availability().disabled,false,'existing conversation');state.thread=null;assert.equal(availability().disabled,true,'unassigned new conversation');
 records=[{method:'terminal/open',threadId:null,status:'unknown'}];terminal();assert.equal($('terminal-open').disabled,true);assert.equal(availability().disabled,false,'terminal unknown does not lock new chat');
});
test('connection loss notifies the mounted terminal and surfaces its failure',()=>{let lost=0;const view={connectionLost(){lost++;}};assert.equal(notifyConnectionLost(view),true);assert.equal(lost,1);assert.equal(notifyConnectionLost(null),false);assert.throws(()=>notifyConnectionLost({connectionLost(){throw new Error('terminal gone');}}),/terminal gone/);assert.match(app,/workbench\.connectionLost\(\)/);assert.match(app,/终端未能处理连接断开/);});
test('workbench forwards connection loss to the mounted terminal only',async()=>{
 const idle=workbenchHarness();assert.equal(idle.wb.connectionLost(),false,'no mounted terminal: nothing to notify');
 const h=workbenchHarness();await h.click('terminal-open');assert.equal(h.wb.connectionLost(),true);assert.equal(h.calls.lost,1);
 const failing=workbenchHarness({mounted:{open:async()=>{},connectionLost(){throw new Error('terminal gone');},dispose(){}}});await failing.click('terminal-open');assert.throws(()=>failing.wb.connectionLost(),/terminal gone/);
});
test('plugin actions keep durable unknown results in the plugin scope without manual acknowledgement',async()=>{
 assert.match(app,/api:pluginApi/);assert.match(app,/\['plugin\/apply','config\/apply'\]\.includes\(method\) && !\['succeeded','not-executed'\]\.includes/);
 let records=[{method:'runtime/upgrade',status:'unknown'}];const calls=[],logicalCalls=new Map();const pendingMutations={storageError:null};
 const source=functionSource('pluginApi','runtimePendingMarker').split('\nconst pluginPanel')[0];
 const pluginApi=new Function('api','pluginLogicalCalls','pendingMutations','scopedPending','performMutation',`async ${source};return pluginApi;`)(()=>{throw Error('unexpected direct API');},logicalCalls,pendingMutations,scope=>pendingForScope(records,scope),(method,params)=>{calls.push([method,params]);return Promise.resolve({outcome:'unknown'});});
 const params={requestId:'logical-one',planId:'p',confirmed:true};assert.equal((await pluginApi('/api/plugins/apply',params)).outcome,'unknown');assert.deepEqual(calls,[['plugin/apply',{planId:'p',confirmed:true}]]);
 records=[{method:'plugin/apply',status:'unknown'}];await pluginApi('/api/plugins/apply',params);assert.equal(calls.length,1,'same logical action must not replay');await assert.rejects(pluginApi('/api/plugins/apply',{...params,requestId:'logical-two'}),/自动同步/);assert.equal(calls.length,1);
 const render=functionSource('renderPluginPending','pluginApi');assert.match(render,/scopedPending\('plugin'\)/);assert.match(render,/role','status/);assert.doesNotMatch(render,/已核对|已确认|createElement\('button'\)|el\('button'/);
});
test('Git writes need an inspection confirmation, then an apply confirmation, and only exact success is reported as success',async()=>{
 for(const [result,message] of [[{outcome:'completed',exitCode:0},/成功返回/],[{outcome:'completed',exitCode:1},/未成功完成或结果未知/],[{outcome:'unknown',exitCode:null},/未成功完成或结果未知/]]){
  const nodes=new Map(),handlers=new Map(),calls=[],confirms=[];
  const $=id=>{if(!nodes.has(id))nodes.set(id,{id,textContent:'',value:id==='git-commit-message'?'fixture commit':'',disabled:false,title:'',addEventListener(type,fn){handlers.set(id+':'+type,fn);},setAttribute(){},replaceChildren(){},append(){},classList:{toggle(){},add(){},remove(){},contains:()=>false}});return nodes.get(id);};
  createWorkbench({document:{},state:{connected:true,cwd:'/project'},$,el:()=>({}),notice(){},confirm:text=>{confirms.push(text);return true;},scopedPending:()=>[],pendingMutations:{storageError:null},pendingReconcileErrors:new Map(),eventSubscribers:new Set(),showTerminal(){},openSettings(){},
   api:async(path,body)=>{calls.push([path,body]);return {planId:'plan-1',root:'/project',action:'commit',expiresAt:Date.now()+60000,message:'fixture commit'};},
   performMutation:async(method,body)=>{calls.push([method,body]);return result;}});
  await handlers.get('git-commit-plan:click')();
  assert.deepEqual(calls,[['/api/git/plan',{cwd:'/project',action:'commit',confirmedInspection:true,message:'fixture commit'}]],'planning only inspects');
  assert.equal($('git-plan-apply').disabled,false);assert.equal(confirms.length,1);
  await handlers.get('git-plan-apply:click')();
  assert.deepEqual(calls[1],['git/apply',{planId:'plan-1',confirmed:true}]);assert.equal(confirms.length,2,'apply has its own confirmation');
  assert.match($('git-action-status').textContent,message,JSON.stringify(result));
  await handlers.get('git-plan-apply:click')();assert.equal(calls.length,2,'a consumed plan cannot be applied again');
 }
});
