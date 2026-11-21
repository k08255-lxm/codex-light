import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {createServer} from '../src/server.mjs';
const summary={id:'p@market',name:'p',source:{type:'local',path:'/fixture/p'},installed:false,enabled:false,version:'1',localVersion:null,installPolicy:'AVAILABLE',availability:'AVAILABLE',disabledReason:null,authPolicy:'ON_USE',mustShowInstallationInterstitial:false};
class Mock extends EventEmitter{constructor(){super();this.requests=new Map();this.calls=[];this.connected=false;}async start(){this.connected=true;}async close(){this.connected=false;}async call(method,params){this.calls.push({method,params});if(method==='plugin/list'||method==='plugin/installed')return {marketplaces:[{name:'market',path:'/fixture/market',plugins:[structuredClone(summary)]}]};if(method==='plugin/read')return {plugin:{marketplaceName:'market',marketplacePath:'/fixture/market',summary:structuredClone(summary),skills:[],hooks:[],apps:[],appTemplates:[],mcpServers:[],scheduledTasks:[]}};if(method==='plugin/install')throw Error('simulated connection lost after submission');return {};}}
test('Plugin HTTP binds observed handle, confirms once, and preserves unknown in ledger replay',async t=>{
 const client=new Mock(),a=await createServer({client});await a.started;t.after(()=>a.close());
 const post=(url,data)=>fetch(a.origin+url,{method:'POST',headers:{Authorization:`Bearer ${a.token}`,'Content-Type':'application/json'},body:JSON.stringify(data)});
 const catalog=await(await post('/api/rpc',{method:'plugin/list',params:{marketplaceKinds:['local'],forceRefetch:false}})).json();assert.equal(catalog.actionHandles.length,1);
 const plan=await(await post('/api/plugins/plan',{handle:catalog.actionHandles[0].handle,action:'install'})).json();assert.equal(plan.status,'ready');
 const requestId=`${a.operations.serverInstance}:${Date.now()}:plugin-test-123`;
 const input={requestId,planId:plan.planId,confirmed:true};const result=await(await post('/api/plugins/apply',input)).json();assert.equal(result.outcome,'unknown');
 assert.deepEqual(await(await post('/api/plugins/apply',input)).json(),result);assert.equal(client.calls.filter(x=>x.method==='plugin/install').length,1);assert.equal(a.operations.get(requestId).result.outcome,'unknown');
 const arbitrary=await post('/api/plugins/plan',{handle:'/etc/other',action:'install'});assert.equal(arbitrary.status,400);
});

test('Plugin toggle HTTP uses an observed local plan and exactly one user-config leaf write',async t=>{
 const client=new Mock();client.version='codex_cli_rs/0.157.1 (fixture)';
 let enabled=true,version='observed-v1',catalogUnknown=true;
 const base=client.call.bind(client),plugin=()=>({...summary,installed:true,enabled,localVersion:'1'});
 client.call=async(method,params)=>{
  if(!['plugin/list','plugin/read','config/read','configRequirements/read','config/batchWrite'].includes(method))return base(method,params);
  client.calls.push({method,params});
  if(method==='plugin/list')return {marketplaces:[{name:'market',path:'/fixture/market',plugins:[{...plugin(),...(catalogUnknown?{enabled:null}:{})}]}]};
  if(method==='plugin/read')return {plugin:{marketplaceName:'market',marketplacePath:'/fixture/market',summary:plugin()}};
  if(method==='configRequirements/read')return {requirements:null};
  if(method==='config/read'){
   const config={plugins:{'p@market':{enabled}},credential:'PRIVATE_FIXTURE'};
   return {config,origins:{},layers:[{name:{type:'user',file:'/fixture/.codex/config.toml',profile:null},version,config}]};
  }
  const prior=version;
  assert.deepEqual(params,{edits:[{keyPath:'plugins."p@market".enabled',value:false,mergeStrategy:'replace'}],expectedVersion:prior,reloadUserConfig:false});
  enabled=false;version='verified-v2';catalogUnknown=false;return {status:'ok',version};
 };
 const app=await createServer({client});await app.started;t.after(()=>app.close());
 const post=(url,data)=>fetch(app.origin+url,{method:'POST',headers:{Authorization:`Bearer ${app.token}`,'Content-Type':'application/json'},body:JSON.stringify(data)});
 const catalog=await(await post('/api/rpc',{method:'plugin/list',params:{marketplaceKinds:['local'],forceRefetch:false}})).json();
 const observed=catalog.actionHandles[0];
 assert.deepEqual(observed.actions,['uninstall']);assert.equal(observed.statusCheck,true);
 const malformed=await post('/api/plugins/status',{handle:observed.handle,enabled:true});assert.equal(malformed.status,400);
 const verified=await(await post('/api/plugins/status',{handle:observed.handle})).json();
 assert.equal(verified.status,'verified');assert.equal(verified.key,observed.key);assert.notEqual(verified.handle,observed.handle);
 assert.equal(verified.enabled,true);assert.deepEqual(verified.actions,['disable','uninstall']);
 assert.ok(!JSON.stringify(verified).includes('PRIVATE_FIXTURE'));
 const forbidden=await post('/api/rpc',{method:'config/batchWrite',params:{edits:[]}});assert.equal(forbidden.status,400);
 const plan=await(await post('/api/plugins/plan',{handle:verified.handle,action:'disable'})).json();
 assert.equal(plan.summary.action,'disable');assert.ok(!JSON.stringify(plan).includes('PRIVATE_FIXTURE'));
 const input={requestId:`${app.operations.serverInstance}:${Date.now()}:plugin-toggle-123`,planId:plan.planId,confirmed:true};
 const invalid=await post('/api/plugins/apply',{...input,enabled:false});assert.notEqual((await invalid.json()).outcome,'succeeded');
 const a=await(await post('/api/plugins/apply',{...input,requestId:`${app.operations.serverInstance}:${Date.now()}:plugin-toggle-124`})).json();
 assert.equal(a.outcome,'succeeded');assert.equal(a.enabled,false);
 assert.equal(client.calls.filter(x=>x.method==='config/batchWrite').length,1);
 const after=await(await post('/api/rpc',{method:'plugin/list',params:{marketplaceKinds:['local'],forceRefetch:false}})).json();
 assert.deepEqual(after.actionHandles[0].actions,['enable','uninstall']);
 assert.ok(!JSON.stringify(a).includes('PRIVATE_FIXTURE'));
});
