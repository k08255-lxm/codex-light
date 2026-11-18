import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BundledDshBridge,DshConnectionService} from '../src/dsh-connection.mjs';
import {WslNativeDshBridge} from '../src/dsh-wsl-native.mjs';
import {WslWindowsDshBridge} from '../src/dsh-wsl-windows.mjs';
import {applyModelDefaults} from '../components/dsh-bridge/src/model-defaults.mjs';
import {createServer} from '../src/server.mjs';

const request = (id,name,args={}) => ({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codecang-model-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bundle=new BundledDshBridge({stateRoot:root});
  return {root,bundle,service:new DshConnectionService({bundle})};
}

test('desktop HTTP settings persist under the app-owned bridge and require authentication',async t=>{
  const {service}=fixture(t);
  const app=await createServer({demo:true,dshConnectionService:service});
  await app.started;t.after(()=>app.close());
  const post=(action,input,authenticated=true)=>fetch(app.origin+'/api/dsh/connection/'+action,{method:'POST',
    headers:{'Content-Type':'application/json',...(authenticated?{Authorization:'Bearer '+app.token}:{})},body:JSON.stringify(input)});
  assert.equal((await post('saveModel',{selection:{model:'local-test'}},false)).status,401);
  assert.deepEqual(await(await post('modelReminder',{})).json(),{needed:true});
  assert.deepEqual((await(await post('saveModel',{selection:{model:'local-test'}})).json()).selection,{model:'local-test'});
  assert.deepEqual((await(await post('modelStatus',{})).json()).selection,{model:'local-test'});
  assert.deepEqual(await(await post('modelReminder',{})).json(),{needed:false});
  assert.equal((await post('saveModel',{selection:{model:'bad model'}})).status,400);
});

test('first-launch reminder can be deferred permanently, settings survive reopening and reset',async t=>{
  const {bundle,service,root}=fixture(t);
  assert.deepEqual(await service.modelReminder(),{needed:true});
  assert.deepEqual(fs.readdirSync(root),[]);
  assert.deepEqual(await service.modelReminder({dismiss:true}),{needed:false});
  const reopened=new DshConnectionService({bundle});
  assert.deepEqual(await reopened.modelReminder(),{needed:false});
  assert.equal((await reopened.modelStatus()).selection,null);
  await reopened.saveModel({selection:{model:'alpha/fast:0.4',provider:'team'}});
  assert.deepEqual((await service.modelStatus()).selection,{model:'alpha/fast:0.4',provider:'team'});
  await assert.rejects(service.saveModel({selection:{model:'x',apiKey:'do-not-persist'}}),{code:'INVALID_INPUT'});
  await service.saveModel({selection:null});
  assert.deepEqual(await reopened.modelReminder(),{needed:false});
  assert.equal((await reopened.modelStatus()).selection,null);
});

test('the installed MCP entry forwards fresh defaults to a running daemon and honors per-call overrides', {timeout:10000}, async t=>{
  const {bundle,service}=fixture(t);
  fs.mkdirSync(bundle.stateDir);
  const daemon=net.createServer();daemon.listen(0,'127.0.0.1');await once(daemon,'listening');
  t.after(()=>daemon.close());
  fs.writeFileSync(path.join(bundle.stateDir,'endpoint.json'),JSON.stringify({port:daemon.address().port}));
  const connected=once(daemon,'connection');
  const entry=fileURLToPath(new URL('../components/dsh-bridge/src/light-entry.mjs',import.meta.url));
  // Node 20 supports CodeCang's HTTP service, while the installed DSH host supplies SQLite.
  const proxy=new URL('../components/dsh-bridge/src/stdio-proxy.mjs',import.meta.url).href;
  const args=process.getBuiltinModule?.('node:sqlite')?[entry,'mcp','--desktop']:
    ['--input-type=module','-e',`import {stdioProxy} from ${JSON.stringify(proxy)};await stdioProxy({desktop:true});`];
  const child=spawn(process.execPath,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],
    env:{...process.env,CODEX_LIGHT_DSH_BRIDGE:'1',DSH_CODEX_QUEUE:'',DSH_SUBAGENT_STATE:bundle.stateDir,DSH_SUBAGENT_CONFIG:bundle.configDir}});
  t.after(()=>child.kill());
  const [socket]=await connected;t.after(()=>socket.destroy());
  const lines=createInterface({input:socket})[Symbol.asyncIterator]();
  async function send(name,args){child.stdin.write(JSON.stringify(request(1,name,args))+'\n');return JSON.parse((await lines.next()).value).params.arguments;}
  const task={task:'fixture only',cwd:bundle.stateRoot};
  assert.deepEqual(await send('dsh_start',task),task);
  await service.saveModel({selection:{model:'v1',provider:'team-a'}});
  assert.deepEqual(await send('dsh_start',task),{...task,model:'v1',provider:'team-a'});
  assert.deepEqual(await send('dsh_start',{...task,model:'one-off'}),{...task,provider:'team-a',model:'one-off'});
  const other={...task,provider:'team-b'};assert.deepEqual(await send('dsh_start',other),other);
  await service.saveModel({selection:{model:'v2'}});
  assert.deepEqual(await send('dsh_start',task),{...task,model:'v2'});
  assert.deepEqual(await send('dsh_followup',{agent_id:'old',task:'next'}),{agent_id:'old',task:'next'});
  await service.saveModel({selection:null});
  assert.deepEqual(await send('dsh_start',task),task);
});

test('WSL interop shares Windows settings; Linux settings travel as positional JSON to its selected user',async t=>{
  const {bundle,service}=fixture(t);
  const interop=new WslWindowsDshBridge({bundle});
  await interop.saveModel({model:'interop'});
  assert.equal((await service.modelStatus()).selection.model,'interop');
  assert.equal(applyModelDefaults(request(1,'dsh_start',{}),bundle.configDir).params.arguments.model,'interop');
  const calls=[],candidate={distribution:'Ubuntu',user:'fixture',home:'/home/fixture'};
  const linux=new WslNativeDshBridge({candidate,bundle:{bundled:()=>({available:true,dependenciesReady:true})},runtime:{
    toLinux:async()=>'/mnt/c/bridge',
    invoke:async args=>{calls.push(args);return JSON.stringify({ok:true,settings:{acknowledged:true,selection:{model:'linux'}}});}
  }});
  const separate=new DshConnectionService({bundle,bundles:{windows:interop,'native-wsl':linux}});
  const {selection}=await separate.saveModel({mode:'native-wsl',selection:{model:'linux'}});
  assert.equal(selection.model,'linux');
  assert.deepEqual(calls[0].slice(0,6),['--distribution','Ubuntu','--user','fixture','--cd','/home/fixture']);
  assert.deepEqual(calls[0].slice(-3),['model-save','',JSON.stringify({selection:{model:'linux'}})]);
  assert.equal((await separate.modelStatus({mode:'native-wsl'})).selection.model,'linux');
  assert.equal(calls[1].at(-3),'model-status');
  assert.equal((await separate.modelStatus({mode:'windows'})).selection.model,'interop');
});
