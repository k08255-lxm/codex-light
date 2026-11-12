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
