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
