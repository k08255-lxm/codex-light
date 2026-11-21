// Backend owner: synthetic Codex RPC and filesystem only; never registers the user's real MCP.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';
import {BundledDshBridge,DshConnectionService} from '../src/dsh-connection.mjs';import {createServer} from '../src/server.mjs';
test('only a connected bridge handshake can confirm the process-loaded version',async()=>{
 const version='0.8.0-light.2',row={name:'dsh_subagent',runtimeStatus:'connected',serverInfo:{version}};
 const service=new DshConnectionService({bundle:{},rpc:{call:async()=>({data:[row]})}});
 assert.deepEqual(await service.runtime(),{state:'connected',reportedVersion:version,loadedVersion:null});
 row.serverCapabilities={experimental:{codecangBridge:{version},codecangCallbackQueue:{version:1}}};
 assert.equal((await service.runtime()).loadedVersion,version);
 row.serverCapabilities.experimental.codecangBridge.version='different';
 assert.equal((await service.runtime()).loadedVersion,null);
 row.runtimeStatus='failed';
 assert.deepEqual(await service.runtime(),{state:'failed'});
});
function fixture(){const calls=[],prepared=[],cfg={config:{mcp_servers:{}},layers:[{name:{type:'user'},version:'v1'}]},bundle={bundled:()=>({available:true,dependenciesReady:true,version:'synthetic'}),detect:()=>({installed:false,executablePath:null}),probe:value=>{if(!value)throw Object.assign(Error('DSH missing'),{code:'DSH_NOT_FOUND'});return {executablePath:value,version:'0.2.2-rc.1',identity:{size:1,mtimeMs:1}};},owns:value=>value?.owned===true,prepare:p=>prepared.push(p),registration:exe=>({owned:true,command:exe,args:['synthetic-entry'],env:{CODEX_LIGHT_DSH_BRIDGE:'1'}})};let write='ok',reload=true;const rpc={call:async(method,params)=>{calls.push([method,params]);if(method==='config/read')return structuredClone(cfg);if(method==='config/batchWrite'){if(write instanceof Error)throw write;if(write==='ok'){cfg.config.mcp_servers.dsh_subagent=params.edits[0].value;cfg.layers[0].version='v2';}return {status:write};}if(method==='config/mcpServer/reload'){if(!reload)throw Error('PRIVATE RELOAD');return {};}if(method==='mcpServerStatus/list')return {data:[{name:'dsh_subagent',runtimeStatus:'connected',toolsError:'PRIVATE'}]};throw Error('Unexpected RPC');}};const service=new DshConnectionService({rpc,bundle});return {service,bundle,rpc,calls,cfg,prepared,setWrite:x=>write=x,setReload:x=>reload=x};}
test('connection status is read-only and reports missing optional DSH without secrets',async()=>{const f=fixture(),status=await f.service.status();assert.equal(status.dsh.installed,false);assert.equal(status.registration.state,'none');assert.equal(f.prepared.length,0);assert.deepEqual(f.calls.map(row=>row[0]),['config/read']);});
test('existing external MCP config is preserved; no probe, prepare, write or reload occurs',async()=>{const f=fixture();f.cfg.config.mcp_servers.dsh_subagent={command:'external',env:{KEY:'PRIVATE'}};const status=await f.service.status();assert.equal(status.registration.state,'external');assert.equal(status.runtime.state,'connected');assert.ok(!JSON.stringify(status).includes('PRIVATE'));await assert.rejects(f.service.plan({executablePath:'/synthetic/DSH.exe'}),{code:'MCP_ALREADY_CONFIGURED'});assert.equal(f.prepared.length,0);assert.ok(!f.calls.some(row=>row[0]==='config/batchWrite'));});
test('only confirmed explicit connection performs one versioned single-key write and queued reload',async()=>{const f=fixture(),plan=await f.service.plan({executablePath:'/synthetic/DSH.exe'});assert.equal(f.prepared.length,0);await assert.rejects(f.service.connect({planId:plan.planId,confirmed:false}),{code:'CONFIRMATION_REQUIRED'});const result=await f.service.connect({planId:plan.planId,confirmed:true});assert.equal(result.registered,true);assert.equal(result.reload.queued,true);assert.equal(result.runtime.state,null);const writes=f.calls.filter(row=>row[0]==='config/batchWrite');assert.equal(writes.length,1);assert.equal(writes[0][1].expectedVersion,'v1');assert.equal(writes[0][1].reloadUserConfig,false);assert.equal(writes[0][1].edits.length,1);assert.equal(writes[0][1].edits[0].keyPath,'mcp_servers.dsh_subagent');await assert.rejects(f.service.connect({planId:plan.planId,confirmed:true}),{code:'CONNECTION_ALREADY_ATTEMPTED'});});
test('late configuration changes prevent prepare/write and preserve user configuration',async()=>{const f=fixture(),plan=await f.service.plan({executablePath:'/synthetic/DSH.exe'});f.cfg.layers[0].version='changed';await assert.rejects(f.service.connect({planId:plan.planId,confirmed:true}),{code:'REVISION_CONFLICT'});assert.equal(f.prepared.length,0);assert.ok(!f.calls.some(row=>row[0]==='config/batchWrite'));});
test('disabled active user layer never falls through to a writable lower profile',async()=>{const f=fixture();f.cfg.layers=[{name:{type:'user'},version:'active',disabledReason:'managed'},{name:{type:'user'},version:'lower'}];await assert.rejects(f.service.plan({executablePath:'/synthetic/DSH.exe'}),{code:'CODEX_CONFIG_READONLY'});assert.equal(f.prepared.length,0);});
test('unknown write result is not replayed and does not disclose raw RPC errors',async()=>{const f=fixture(),plan=await f.service.plan({executablePath:'/synthetic/DSH.exe'});f.setWrite(Error('PRIVATE AUTH HEADER'));await assert.rejects(f.service.connect({planId:plan.planId,confirmed:true}),e=>e.code==='CONNECTION_OUTCOME_UNKNOWN'&&e.outcome==='unknown'&&!e.message.includes('PRIVATE'));await assert.rejects(f.service.connect({planId:plan.planId,confirmed:true}),{code:'CONNECTION_ALREADY_ATTEMPTED'});assert.equal(f.calls.filter(row=>row[0]==='config/batchWrite').length,1);assert.equal(f.service.pending,false);});
test('overridden write and unsupported reload never pretend runtime connection succeeded',async()=>{const f=fixture();let plan=await f.service.plan({executablePath:'/synthetic/DSH.exe'});f.setWrite('okOverridden');let result=await f.service.connect({planId:plan.planId,confirmed:true});assert.equal(result.registration.state,'unknown');assert.equal(result.reload.queued,false);assert.equal(result.reload.error.code,'MCP_CONFIG_OVERRIDDEN');const g=fixture();plan=await g.service.plan({executablePath:'/synthetic/DSH.exe'});g.setReload(false);result=await g.service.connect({planId:plan.planId,confirmed:true});assert.equal(result.registered,true);assert.equal(result.reload.queued,false);assert.ok(!JSON.stringify(result).includes('PRIVATE'));});
test('unwritable config, expired plan, missing DSH and missing bundled dependencies are isolated',async()=>{let now=0;const f=fixture();f.service.clock=()=>now;await assert.rejects(f.service.plan({}),{code:'DSH_NOT_FOUND'});let plan=await f.service.plan({executablePath:'/synthetic/DSH.exe'});now=300001;await assert.rejects(f.service.connect({planId:plan.planId,confirmed:true}),{code:'PLAN_EXPIRED'});f.cfg.layers=[];await assert.rejects(f.service.plan({executablePath:'/synthetic/DSH.exe'}),{code:'CODEX_CONFIG_READONLY'});f.bundle.bundled=()=>({available:true,dependenciesReady:false});await assert.rejects(f.service.plan({}),{code:'DSH_COMPONENT_UNAVAILABLE'});assert.equal(f.prepared.length,0);});
test('clean synthetic DSH installation creates only its own profile and private bridge state',t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-connect-owned-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const home=path.join(root,'user'),exeDir=path.join(root,'DSH'),exe=path.join(exeDir,'DeepSeek Harness.exe');fs.mkdirSync(path.join(exeDir,'resources'),{recursive:true});fs.writeFileSync(exe,'synthetic executable bytes');fs.writeFileSync(path.join(exeDir,'resources','app.asar'),'synthetic');const probes=[],bundle=new BundledDshBridge({home,stateRoot:path.join(root,'state'),env:{},spawnSyncFn:(command,args,options)=>{probes.push({command,args,options});return {status:0,stdout:JSON.stringify({name:'@deepseek-ai/dsh-desktop-host',version:'0.2.2-rc.1',node:'24.21.0',sqlite:true})};}});assert.equal(fs.existsSync(bundle.stateRoot),false);const probe=bundle.probe(exe);assert.equal(probes[0].options.env.ELECTRON_RUN_AS_NODE,'1');assert.equal(probes[0].options.windowsHide,true);assert.equal(probes[0].options.shell,false);bundle.prepare(probe);const record=JSON.parse(fs.readFileSync(path.join(bundle.configDir,'installation.json')));assert.equal(record.owner,'codex-light');assert.equal(record.backend,'background');assert.equal(record.env.DSH_BRIDGE_PROFILE,'codex-light-bridge');assert.ok(!('DSH_DEFAULT_PROVIDER' in record.env));assert.ok(!fs.existsSync(path.join(home,'.dsh','.credentials.yaml')));assert.equal(JSON.parse(fs.readFileSync(path.join(home,'.dsh','profiles','codex-light-bridge','package.json'))).codexLightBridgeProfile,1);assert.ok(!fs.existsSync(path.join(home,'.codex')));bundle.prepare(probe);});
test('profile collision fails without overwriting its files',t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-profile-collision-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const exe=path.join(root,'DeepSeek Harness.exe');fs.mkdirSync(path.join(root,'resources'));fs.writeFileSync(exe,'x');fs.writeFileSync(path.join(root,'resources','app.asar'),'x');const bundle=new BundledDshBridge({home:root,stateRoot:path.join(root,'state'),env:{},spawnSyncFn:()=>({status:0,stdout:JSON.stringify({name:'@deepseek-ai/dsh-desktop-host',version:'0.2.2-rc.1',node:'24.0.0',sqlite:true})})}),profile=path.join(root,'.dsh','profiles','codex-light-bridge');fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'package.json'),'{}');assert.throws(()=>bundle.prepare(bundle.probe(exe)),{code:'DSH_PROFILE_CONFLICT'});assert.equal(fs.readFileSync(path.join(profile,'package.json'),'utf8'),'{}');});
test('connection HTTP requires local Bearer, remains outside receipts, and demo never writes config',async t=>{const f=fixture(),app=await createServer({demo:true,dshConnectionService:f.service});await app.started;t.after(()=>app.close());const post=(route,data,auth=true)=>fetch(app.origin+route,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+app.token}:{})},body:JSON.stringify(data)});assert.equal((await post('/api/dsh/connection/status',{},false)).status,401);const plan=await(await post('/api/dsh/connection/plan',{executablePath:'/synthetic/DSH.exe'})).json();assert.equal((await post('/api/dsh/connection/connect',{planId:plan.planId,confirmed:true})).status,200);assert.equal(app.operations.entries.size,0);const demo=new DshConnectionService({demo:true,rpc:{call(){throw Error('must not read config');}},bundle:f.bundle});assert.equal((await demo.status()).error.code,'DSH_DEMO_DISABLED');await assert.rejects(demo.plan({}),{code:'DSH_DEMO_DISABLED'});});
test('LAN cannot inspect or invoke connection management',async t=>{let called=0;const factory=handler=>{const server=http.createServer(handler),listen=server.listen.bind(server);server.listen=(options,...rest)=>listen({...options,host:'127.0.0.1'},...rest);return server;};const app=await createServer({demo:true,dshConnectionService:{status(){called++;},plan(){called++;},connect(){called++;}},lanOptions:{networkInterfaces:()=>({fake:[{address:'192.168.77.19',family:'IPv4',internal:false}]}),serverFactory:factory}});await app.started;t.after(()=>app.close());const lan=await app.lan.enable({address:'192.168.77.19'}),token=new URL(lan.url).hash.slice(7);for(const action of ['status','plan','connect','testConnection']){const r=await fetch(`http://127.0.0.1:${lan.port}/api/dsh/connection/${action}`,{method:'POST',headers:{Host:`192.168.77.19:${lan.port}`,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,403);}assert.equal(called,0);});

test('component corruption after plan prevents preparation or config mutation',async()=>{const f=fixture(),plan=await f.service.plan({executablePath:'/synthetic/DSH.exe'});f.bundle.bundled=()=>({available:false,dependenciesReady:false});await assert.rejects(f.service.connect({planId:plan.planId,confirmed:true}),{code:'DSH_COMPONENT_UNAVAILABLE'});assert.equal(f.prepared.length,0);assert.ok(!f.calls.some(row=>row[0]==='config/batchWrite'));});

test('async bridge selection is explicit and bound to the confirmed plan',async()=>{const f=fixture(),events=[];const adapter=mode=>Object.fromEntries(Object.entries(f.bundle).map(([name,fn])=>[name,async(...args)=>{await Promise.resolve();events.push(mode+':'+name);return fn(...args);} ]));const service=new DshConnectionService({rpc:f.rpc,bundles:{'native-wsl':adapter('linux'),windows:adapter('windows')}});assert.deepEqual((await service.status()).modes,['native-wsl','windows']);assert.equal(events.length,0);await assert.rejects(service.plan({executablePath:'/fake'}),{code:'DSH_MODE_REQUIRED'});const status=await service.status({mode:'native-wsl'});assert.equal(status.registration.state,'none');const plan=await service.plan({mode:'native-wsl',executablePath:'/fake'});await assert.rejects(service.connect({planId:plan.planId,confirmed:true,mode:'windows'}),{code:'INVALID_INPUT'});const result=await service.connect({planId:plan.planId,confirmed:true});assert.equal(result.registered,true);assert.ok(events.includes('linux:prepare'));assert.ok(events.includes('linux:registration'));assert.ok(!events.some(e=>e.startsWith('windows:')));assert.equal(typeof f.calls.find(x=>x[0]==='config/batchWrite')[1].edits[0].value.command,'string');});


test('status exposes bounded read-only observations without exposing raw tool errors or payloads', async()=>{
 let reply={data:[]}, calls=[];
 const rpc={call:async(method)=>{calls.push(method);if(reply instanceof Error)throw reply;return reply;}};
 const s=new DshConnectionService({rpc,bundle:{}});
 assert.deepEqual(await s.runtime(),{state:null,observation:'missing'});
 reply=new Error('private endpoint');
 assert.deepEqual(await s.runtime(),{state:null,observation:'unavailable'});
 reply={data:[{name:'dsh_subagent',tools:[{name:'dsh_start',private:'secret'},{name:'dsh_wait'}]}]};
 assert.deepEqual(await s.runtime(),{state:null,observation:'listed',tools:{count:2,subagent:true}});
 reply.data[0]={...reply.data[0],runtimeStatus:'connected',toolsError:'private'};
 assert.deepEqual(await s.runtime(),{state:'connected',tools:{count:2,subagent:true},toolsUnavailable:true});
 assert.ok(calls.every(method=>method==='mcpServerStatus/list'));
});

test('WSL status identifies a registration owned by the other mode and can report a configured disabled bridge',async()=>{
 const f=fixture();f.cfg.config.mcp_servers.dsh_subagent={owned:true,enabled:false};
 const windows={...f.bundle,owns:()=>false};
 const service=new DshConnectionService({rpc:f.rpc,bundle:f.bundle,bundles:{windows,'native-wsl':f.bundle},clock:()=>12345});
 let status=await service.status({mode:'windows'});
 assert.deepEqual(status.registration,{state:'otherMode',serverName:'dsh_subagent',mode:'native-wsl'});
 assert.equal(status.checkedAt,12345);assert.equal(status.canConnect,false);
 const call=f.rpc.call;f.rpc.call=async(method,params)=>method==='mcpServerStatus/list'?{data:[]}:call(method,params);
 status=await service.status({mode:'native-wsl'});
 assert.deepEqual(status.runtime,{state:'disabled'});
});

test('immediate connection test uses fresh real Codex route and verifies reported tools without invoking them',async()=>{
 const f=fixture();f.cfg.config.mcp_servers.dsh_subagent={owned:true};
 const call=f.rpc.call, states=[
  {runtimeStatus:'connected',tools:{dsh_start:{},dsh_wait:{}}},
  {runtimeStatus:'connected',tools:{dsh_start:{}}},
  {runtimeStatus:'connected'},
  {runtimeStatus:'starting',tools:{dsh_start:{},dsh_wait:{}}},
  {runtimeStatus:'authenticationRequired'},
 ];
 f.rpc.call=async(method,params)=>{
  if(method!=='mcpServerStatus/list')return call(method,params);
  f.calls.push([method,params]);return {data:[{name:'dsh_subagent',...states.shift()}]};
 };
 for(const [outcome,reason] of [['passed','mcpAndTools'],['failed','missingTools'],['inconclusive','toolsUnreported'],['inconclusive','starting'],['failed','authenticationRequired']]){
  const result=await f.service.testConnection();
  assert.deepEqual([result.outcome,result.reason],[outcome,reason]);
  assert.equal(f.calls.at(-1)[0],'mcpServerStatus/list',reason);
 }
 assert.deepEqual(f.calls.map(([method])=>method),Array(5).fill(['config/read','mcpServerStatus/list']).flat());
 assert.equal(f.prepared.length,0);
 f.cfg.config.mcp_servers.dsh_subagent.enabled=false;
 assert.equal((await f.service.testConnection()).reason,'disabled');
 assert.equal(f.calls.at(-1)[0],'config/read');
 await assert.rejects(async()=>f.service.testConnection({tool:'dsh_start'}),{code:'INVALID_INPUT'});
});

test('immediate test does not inspect a runtime owned by another known bridge mode',async()=>{
 const f=fixture();f.cfg.config.mcp_servers.dsh_subagent={owned:true};
 const service=new DshConnectionService({rpc:f.rpc,bundle:f.bundle,bundles:{windows:{owns:()=>false},'native-wsl':f.bundle}});
 assert.equal((await service.testConnection({mode:'windows'})).reason,'otherMode');
 assert.deepEqual(f.calls.map(row=>row[0]),['config/read']);
});
