import test from 'node:test';import assert from 'node:assert/strict';import {PluginActionService} from '../src/plugin-actions.mjs';
const summary=()=>({id:'plug@local',remotePluginId:null,name:'plug',source:{type:'git',url:'https://user:SECRET@example.com/repo?token=SECRET#SECRET',sha:'abc'},installed:true,enabled:true,version:'1',localVersion:'1',installPolicy:'AVAILABLE',availability:'AVAILABLE',disabledReason:null,authPolicy:'ON_INSTALL',mustShowInstallationInterstitial:false});
const detail=s=>({marketplaceName:'local',marketplacePath:'/synthetic/market',summary:s,skills:[{name:'skill'}],hooks:[{eventName:'SessionStart'}],mcpServers:['server'],apps:[{name:'app'}],appTemplates:[],scheduledTasks:[]});
function setup(){let current=detail(summary()),time=0;const calls=[];const rpc={async call(method,params){calls.push([method,params]);if(method==='plugin/read')return {plugin:structuredClone(current)};if(method==='plugin/install')return {authPolicy:'ON_INSTALL',appsNeedingAuth:[{name:'app'}]};if(method==='plugin/installed')return {marketplaces:[],marketplaceLoadErrors:[]};return {};}};const service=new PluginActionService({rpc,clock:()=>time});const observe=()=>service.observeCatalog({cwds:['/synthetic/work']},{marketplaces:[{name:current.marketplaceName,path:current.marketplacePath,plugins:[current.summary]}]})[0];return {service,calls,rpc,observe,set(v){current=v;},get(){return current;},time(v){time=v;}};}
test('observed opaque plan describes exact risks; apply fixed RPC once and refresh',async()=>{
 const x=setup(),observed=x.observe(),plan=await x.service.plan(observed.handle,'install');assert.equal(plan.status,'ready');assert.ok(!JSON.stringify(plan).includes('SECRET'));assert.equal(plan.summary.source.type,'git');assert.match(plan.summary.consequences.join(' '),/silent OAuth/);assert.equal(plan.summary.hooks[0],'SessionStart');
 const result=await x.service.apply({planId:plan.planId,confirmed:true});assert.equal(result.outcome,'succeeded');assert.equal(x.calls.filter(([m])=>m==='plugin/install').length,1);const params=x.calls.find(([m])=>m==='plugin/install')[1];assert.equal(params.marketplacePath,'/synthetic/market');assert.equal(params.pluginName,'plug');assert.ok(params.installAttemptId);assert.equal(x.calls.at(-1)[0],'plugin/installed');
 await assert.rejects(()=>x.service.apply({planId:plan.planId,confirmed:true}),/consumed/);
});
test('unobserved selectors, missing selectors and unconfirmed or expired plans refused',async()=>{
 const x=setup();assert.deepEqual(x.service.observeCatalog({}, {marketplaces:[{plugins:[summary()]}]}),[]);await assert.rejects(()=>x.service.plan('/arbitrary','install'),/Unknown/);
 const p=await x.service.plan(x.observe().handle,'uninstall');await assert.rejects(()=>x.service.apply({planId:p.planId,confirmed:false}),/confirmation/);x.time(120000);await assert.rejects(()=>x.service.apply({planId:p.planId,confirmed:true}),/expired/);assert.equal(x.calls.filter(([m])=>m==='plugin/uninstall').length,0);
});
test('observed change requires new plan and apply-time change prevents execution',async()=>{
 const x=setup(),h=x.observe().handle;const changed=detail({...summary(),version:'2'});x.set(changed);const p=await x.service.plan(h,'install');assert.equal(p.status,'changed');const p2=await x.service.plan(p.handle,'install');x.set(detail({...summary(),version:'3'}));const r=await x.service.apply({planId:p2.planId,confirmed:true});assert.equal(r.outcome,'not-executed');assert.equal(r.status,'changed');assert.ok(!x.calls.some(([m])=>m==='plugin/install'));
});
test('mandatory interstitial and policy restrictions cannot be replaced by generic confirmation',async()=>{
 for(const change of [{mustShowInstallationInterstitial:true},{installPolicy:'NOT_AVAILABLE'},{availability:'DISABLED_BY_ADMIN'},{availability:null}]){const x=setup();x.set(detail({...summary(),...change}));await assert.rejects(()=>x.service.plan(x.observe().handle,'install'));assert.ok(!x.calls.some(([m])=>m==='plugin/install'));}
});
test('remote read/install uses observed remote id, uninstall observed remote id',async()=>{
 const x=setup();x.set({...detail({...summary(),remotePluginId:'remote-id',source:{type:'remote'}}),marketplacePath:null,marketplaceName:'remote'});const p=await x.service.plan(x.observe().handle,'install');assert.deepEqual(x.calls[0][1],{remoteMarketplaceName:'remote',pluginName:'remote-id'});await x.service.apply({planId:p.planId,confirmed:true});assert.equal(x.calls.find(([m])=>m==='plugin/install')[1].pluginName,'remote-id');
 const q=await x.service.plan(x.observe().handle,'uninstall');await x.service.apply({planId:q.planId,confirmed:true});assert.deepEqual(x.calls.find(([m])=>m==='plugin/uninstall')[1],{pluginId:'remote-id'});
});
test('mutation error is unknown, refresh failure does not mean unexecuted, no retries',async()=>{
 const x=setup(),base=x.rpc.call;x.rpc.call=async(m,p)=>{if(m==='plugin/install'||m==='plugin/installed'){x.calls.push([m,p]);throw Error('PRIVATE');}return base(m,p);};const p=await x.service.plan(x.observe().handle,'install');const r=await x.service.apply({planId:p.planId,confirmed:true});assert.equal(r.outcome,'unknown');assert.equal(r.refresh.status,'failed');assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.equal(x.calls.filter(([m])=>m==='plugin/install').length,1);
});
test('unknown source gets explicit warning, context clear during preflight prevents mutation',async()=>{
 const x=setup();x.set(detail({...summary(),source:{type:'new-kind',secret:'hidden'}}));const p=await x.service.plan(x.observe().handle,'install');assert.match(p.summary.source.warning,/未知来源/);assert.ok(!JSON.stringify(p).includes('hidden'));
 const base=x.rpc.call;x.rpc.call=async(m,args)=>{const r=await base(m,args);if(m==='plugin/read')x.service.clear();return r;};const r=await x.service.apply({planId:p.planId,confirmed:true});assert.equal(r.outcome,'not-executed');assert.equal(r.refresh.status,'skipped');assert.ok(!x.calls.some(([m])=>m==='plugin/install'));
});

test('observation keys separate same plugin ID across marketplaces; capability arrays match protocol',async()=>{
 const x=setup(),s=summary();const rows=x.service.observeCatalog({}, {marketplaces:[{name:'one',path:'/one',plugins:[s]},{name:'two',path:'/two',plugins:[s]}]});assert.equal(rows[0].key,JSON.stringify(['/one',s.id]));assert.equal(rows[1].key,JSON.stringify(['/two',s.id]));assert.notEqual(rows[0].handle,rows[1].handle);
 const d=x.get();d.mcpServers={server:{}};x.set(d);await assert.rejects(()=>x.service.plan(x.observe().handle,'install'),/complete plugin capability/);
});

test('Install-only restrictions do not block removing an observed installed plugin',async()=>{
 const x=setup();x.set(detail({...summary(),installPolicy:'NOT_AVAILABLE',availability:'DISABLED_BY_ADMIN',disabledReason:'disabled_by_admin'}));
 const p=await x.service.plan(x.observe().handle,'uninstall');const result=await x.service.apply({planId:p.planId,confirmed:true});
 assert.equal(result.outcome,'succeeded');assert.equal(x.calls.filter(([m])=>m==='plugin/uninstall').length,1);
});

function setupToggle(options={}){
 const local=summary(),plugin={...local,...options.summary};
 let current=detail(plugin),revision='base-v1',written=false,policy=null,cfgError=false;
 const calls=[];
 const config=()=>({plugins:{[plugin.id]:{enabled:current.summary.enabled,mcp_servers:{preserve:{enabled:true}}}},unrelatedCredential:'PRIVATE_CONFIG_FIXTURE'});
 let configHook=()=>null;
 const rpc={version:options.version??'codex_cli_rs/0.157.1 (fixture)',async call(method,params){
  calls.push([method,params]);
  if(method==='plugin/read')return {plugin:structuredClone(current)};
  if(method==='configRequirements/read')return {requirements:policy};
  if(method==='config/read'){
   if(cfgError)throw new Error('PRIVATE read failed');
   return configHook(params)??{config:config(),origins:{},layers:[{name:{type:'user',file:'/synthetic/.codex/config.toml',profile:null},version:revision,config:config()}]};
  }
  if(method==='config/batchWrite'){
   written=true;
   if(options.throwWrite)throw new Error('PRIVATE disconnected');
   const old=revision;
   revision='verified-v2';
   if(!options.keepOld)current.summary.enabled=params.edits[0].value;
   if(options.breakReadback)cfgError=true;
   return {status:options.writeStatus??'ok',version:options.staleReceipt?old:revision};
  }
  throw new Error('Unexpected fixture RPC '+method);
 }};
 const service=new PluginActionService({rpc});
 const observe=opts=>service.observeCatalog({cwds:['/synthetic/work']},{marketplaces:[{name:current.marketplaceName,path:current.marketplacePath,plugins:[current.summary]}]},opts)[0];
 return{rpc,service,observe,calls,setRevision:v=>{revision=v;},setDetails:v=>{current=v;},setPolicy:v=>{policy=v;},getDetails:()=>current,overrideConfig:f=>{configHook=f;},wrote:()=>written};
}
test('enable/disable sends one sealed boolean leaf with expected user version and verifies readback',async()=>{
 for(const enabled of [true,false]){
  const f=setupToggle({summary:{id:'plug.tools@local',name:'plug.tools',enabled}}),action=enabled?'disable':'enable';
  const ob=f.observe();assert.deepEqual(ob.actions,[action,'uninstall']);assert.equal(f.calls.length,0);
  const plan=await f.service.plan(ob.handle,action);
  assert.equal(plan.summary.action,action);assert.ok(!JSON.stringify(plan).includes('PRIVATE_CONFIG_FIXTURE'));assert.match(plan.summary.consequences.join(' '),/不会安装、卸载或撤销授权/);
  const result=await f.service.apply({planId:plan.planId,confirmed:true});
  assert.equal(result.outcome,'succeeded');assert.equal(result.enabled,!enabled);
  assert.deepEqual(f.calls.filter(([m])=>m==='config/batchWrite'),[['config/batchWrite',{edits:[{keyPath:'plugins."plug.tools@local".enabled',value:!enabled,mergeStrategy:'replace'}],expectedVersion:'base-v1',reloadUserConfig:false}]]);
  assert.ok(!f.calls.some(([m])=>['plugin/install','plugin/uninstall','plugin/installed'].includes(m)));
  await assert.rejects(()=>f.service.apply({planId:plan.planId,confirmed:true}),/consumed/);
 }
});
test('refuses activation from remote, fake IDs, unknown statuses or old engines',async()=>{
 for(const opts of [
  {version:'codex_cli_rs/0.156.0'}, {version:'codex_cli_rs/0.157.1-alpha.1'}, {summary:{enabled:null}},
  {summary:{installed:false}}, {summary:{availability:'DISABLED_BY_ADMIN'}},
  {summary:{source:{type:'remote'},remotePluginId:'r'}}, {summary:{name:'plug\"escaped',id:'plug\"escaped@local'}},
  {summary:{id:'plug@injected'}}, {summary:{shareContext:{id:'shared'}}}
 ]){
  const f=setupToggle(opts),ob=f.observe();
  assert.ok(!ob.actions.some(a=>a==='enable'||a==='disable'));
  await assert.rejects(()=>f.service.plan(ob.handle,'disable'),/仅限本机兼容/);assert.equal(f.calls.length,0);
 }
 const f=setupToggle();assert.deepEqual(f.observe({allowToggle:false}).actions,['uninstall']);
 const ob=f.observe();await assert.rejects(()=>f.service.plan(ob.handle,'disable',{allowToggle:false}),/仅限/);
 const p=await f.service.plan(ob.handle,'disable');await assert.rejects(()=>f.service.apply({planId:p.planId,confirmed:true},{allowToggle:false}),/仅限本机/);assert.equal(f.wrote(),false);
});
test('preflight stops profile, project override, policy drift and config version drift',async()=>{
 const f=setupToggle();const p=await f.service.plan(f.observe().handle,'disable');f.setRevision('changed');
 assert.equal((await f.service.apply({planId:p.planId,confirmed:true})).outcome,'not-executed');
 assert.equal(f.wrote(),false);
 const g=setupToggle();const q=await g.service.plan(g.observe().handle,'disable');g.setPolicy({featureRequirements:{plugins:false}});
 assert.equal((await g.service.apply({planId:q.planId,confirmed:true})).outcome,'not-executed');
 assert.equal(g.wrote(),false);
 for(const layer of [
  {name:{type:'user',file:'/synthetic/.codex/p.config.toml',profile:'p'},version:'0',config:{}},
  {name:{type:'project',dotCodexFolder:'/synthetic/.codex'},version:'9',config:{plugins:{'plug@local':{enabled:true}}}}
 ]){
  const h=setupToggle();h.overrideConfig(()=>({config:{plugins:{'plug@local':{enabled:true}}},origins:{},layers:[layer,{name:{type:'user',file:'/synthetic/config.toml',profile:null},version:'5',config:{}}]}));
  await assert.rejects(()=>h.service.plan(h.observe().handle,'disable'),/配置层/);assert.equal(h.wrote(),false);
 }
});
test('write loss or unverifiable activation returns unknown without retry or credentials',async()=>{
 for(const opts of [{throwWrite:true},{writeStatus:'okOverridden'},{keepOld:true},{breakReadback:true},{staleReceipt:true}]){
  const f=setupToggle(opts),plan=await f.service.plan(f.observe().handle,'disable');
  const result=await f.service.apply({planId:plan.planId,confirmed:true});
  assert.equal(result.outcome,'unknown');assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(f.calls.filter(([m])=>m==='config/batchWrite').length,1);
  await assert.rejects(()=>f.service.apply({planId:plan.planId,confirmed:true}),/consumed/);
 }
});

test('explicit status upgrades matching installed catalog row without a write when details resolve enabled',async()=>{
 const f=setupToggle({summary:{enabled:null}}),ob=f.observe();
 assert.equal(ob.statusCheck,true);assert.deepEqual(ob.actions,['uninstall']);assert.equal(f.calls.length,0);
 f.setDetails({...f.getDetails(),summary:{...f.getDetails().summary,enabled:true}});
 const resolved=await f.service.checkStatus(ob.handle);
 assert.equal(resolved.status,'verified');assert.equal(resolved.key,ob.key);assert.notEqual(resolved.handle,ob.handle);
 assert.equal(resolved.installed,true);assert.equal(resolved.enabled,true);assert.deepEqual(resolved.actions,['disable','uninstall']);
 assert.deepEqual(f.calls.map(([method])=>method),['plugin/read']);assert.equal(f.wrote(),false);
 await assert.rejects(()=>f.service.plan(ob.handle,'disable'),/仅限本机兼容/);
 const p=await f.service.plan(resolved.handle,'disable');assert.equal(p.summary.action,'disable');
});
test('explicit status cannot mint actions for a stale or different plugin/source, or nonlocal request',async()=>{
 for(const change of [
  {summary:{id:'another@local'}}, {summary:{source:{type:'local',path:'/new-source'}}},
  {summary:{name:'unrelated'}}, {summary:{installed:false}},
  {summary:{enabled:null}}, {marketplaceName:'other'}, {marketplacePath:'/elsewhere'}
 ]){
  const f=setupToggle({summary:{enabled:null}}),ob=f.observe(),current=f.getDetails();
  f.setDetails({...current,...change,summary:{...current.summary,enabled:false,...change.summary}});
  assert.deepEqual(await f.service.checkStatus(ob.handle),{status:'unknown'});
  assert.equal(f.wrote(),false);
 }
 const f=setupToggle({summary:{enabled:null}}),ob=f.observe();
 assert.deepEqual(await f.service.checkStatus(ob.handle,{allowToggle:false}),{status:'unknown'});
 assert.deepEqual(await f.service.checkStatus('/different/handle'),{status:'unknown'});assert.equal(f.calls.length,0);
 const g=setupToggle({summary:{enabled:null}}),pending=g.observe(),call=g.rpc.call;
 g.rpc.call=async(method,params)=>{const result=await call(method,params);g.service.clear();return result;};
 g.setDetails({...g.getDetails(),summary:{...g.getDetails().summary,enabled:false}});
 assert.deepEqual(await g.service.checkStatus(pending.handle),{status:'unknown'});
});
