import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {pendingForScope,sendAvailability,SessionDefaultsBridge} from '../public/submissions.js';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
function functionSource(name,nextName){const start=app.indexOf(`function ${name}(`),end=app.indexOf(`function ${nextName}(`,start);assert.ok(start>=0&&end>start,`${name} function boundary`);return app.slice(start,end);}

test('official account usage stays account-scoped and context usage replaces rather than sums',async()=>{const account=await readFile(new URL('../public/ui/account-view.js',import.meta.url),'utf8');assert.match(account,/rpc\('account\/usage\/read', \{\}\)/);assert.doesNotMatch(account,/statistics\/query/);assert.match(app,/cacheContext\(snapshot,'live'\)/,'official token usage updates replace the per-thread context snapshot');assert.doesNotMatch(app,/contexts\.get\([^)]*\)\s*\+|totalTokens\s*\+=/,'usage notifications are never summed');});
test('unrelated unknown operations leave chat available',()=>{
 const state={thread:{id:'current'},connected:true,serverInstance:'a'.repeat(32),sending:false,loadingThread:false,busy:false,uploadingImages:false,cwd:'/project'};
 const pendingMutations={storageError:null};let records=[];const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'draft'});return nodes.get(id);};
 const scopedPending=(scope,options)=>pendingForScope(records,scope,options);
 const sessionDefaults=new SessionDefaultsBridge(async()=>({}));
 const availability=new Function('state','pendingMutations','chatPendingRecords','sendAvailability','$','attachmentDraft','fileAttachmentDraft',
  'draftModelChoice','modelCatalogLoading','sessionDefaults',`${functionSource('currentSendAvailability','updateControls')};return currentSendAvailability;`)(
  state,pendingMutations,()=>scopedPending('chat',{threadId:state.thread?.id}),sendAvailability,$,{values:()=>[]},{values:()=>[]},
  {model:'',effort:'high'},false,sessionDefaults);
 for(const method of ['runtime/upgrade','git/apply','plugin/apply','config/apply','account/start','remoteControl/enable','turn/interrupt','thread/name/set','thread/archive','thread/fork']){
  records=[{method,threadId:'current',status:'unknown'}];assert.equal(availability().disabled,false,method);
 }
 records=[{method:'turn/start',threadId:'other',status:'unknown'}];assert.equal(availability().disabled,false,'other conversation');
 for(const method of ['turn/start','review/start']){records=[{method,threadId:'current',status:'unknown'}];assert.equal(availability().disabled,true,method);}
 records=[{method:'thread/start',threadId:null,status:'unknown'}];assert.equal(availability().disabled,false,'existing conversation');state.thread=null;assert.equal(availability().disabled,true,'unassigned new conversation');
 records=[{method:'terminal/open',threadId:null,status:'unknown'}];assert.equal(availability().disabled,false,'terminal unknown does not lock new chat');
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
