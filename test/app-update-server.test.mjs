import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AppUpdateService,APP_RELEASES_API} from '../src/app-update.mjs';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
import {makeMutation,restoreMarkers,serializeMarkers,lookupDecision,pendingForScope} from '../public/submissions.js';

const setup=Buffer.from('update route fixture, not executable');
const sum=createHash('sha256').update(setup).digest('hex')+'  CodexLight-Setup.exe\n';
const base='https://github.com/k08255-lxm/codex-light/releases/download/v0.4.0/';
async function fixture(t,{demo=false,unknown=false,lan=false,desktop=false,checkGate,veloGuard=false}={}){
 const directory=await mkdtemp(path.join(os.tmpdir(),'app-update-route-'));let launches=0,fetches=0;
 const release={tag_name:'v0.4.0',html_url:'https://github.com/k08255-lxm/codex-light/releases/tag/v0.4.0',body:'Test notes',assets:[{name:'CodexLight-Setup.exe',size:setup.length,browser_download_url:base+'CodexLight-Setup.exe'},{name:'SHA256SUMS.txt',size:Buffer.byteLength(sum),browser_download_url:base+'SHA256SUMS.txt'}]};
 const service=new AppUpdateService({currentVersion:'0.3.0',platform:'win32',arch:'x64',cacheRoot:directory,fetchFn:async url=>{fetches++;if(url===APP_RELEASES_API&&checkGate)await checkGate();return new Response(url===APP_RELEASES_API?JSON.stringify(release):url.endsWith('SHA256SUMS.txt')?sum:setup);},launchFn:async()=>{launches++;if(unknown)throw new Error('native acknowledgement timeout');}});
 const app=await createServer({client:new DemoClient(),demo,desktop,desktopStateRoot:directory,desktopUpdateTransport:veloGuard?'velopack':'msi',appUpdateService:service,...(lan?{lanOptions:{networkInterfaces:()=>({Synthetic:[{address:'192.168.75.20',family:'IPv4',internal:false}]}),serverFactory:handler=>{const server=http.createServer(handler),listen=server.listen.bind(server);server.listen=options=>listen({...options,host:'127.0.0.1'});return server;}}}:{})});
 await app.started;t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true,maxRetries:3});});
 return {app,service,get launches(){return launches;},get fetches(){return fetches;}};
}
function post(app,action,value={}){return fetch(app.origin+'/api/app-update/'+action,{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify(value)});}
function id(app,suffix){return `${app.operations.serverInstance}:${Date.now()}:app_update_${suffix}`;}
async function prepare(app){assert.equal((await post(app,'check')).status,200);assert.equal((await post(app,'download',{version:'0.4.0',requestId:id(app,'download')})).status,200);}

test('desktop startup reuses one nonblocking update check across manual and local event consumers',async t=>{
 let releaseCheck,markStarted;
 const gate=new Promise(resolve=>releaseCheck=resolve), started=new Promise(resolve=>markStarted=resolve);
 const f=await fixture(t,{desktop:true,checkGate:()=>{markStarted();return gate;}});
 const auth={Authorization:'Bearer '+f.app.token};
 const controller=new AbortController();t.after(()=>{releaseCheck();controller.abort();});
 const listen=async()=>{
  const response=await fetch(f.app.origin+'/api/events',{headers:auth,signal:controller.signal});
  assert.equal(response.status,200);
  return response.body.getReader();
 };
 const readStatus=async reader=>{
  const decoder=new TextDecoder();let text='';
  while(!text.includes('"method":"bridge/appUpdate"')){
   const {value,done}=await reader.read();
   assert.equal(done,false);text+=decoder.decode(value,{stream:true});
  }
  const update=text.split('\n').map(line=>line.startsWith('data: ')?JSON.parse(line.slice(6)):null).find(message=>message?.method==='bridge/appUpdate');
  return update.params;
 };
 const [first,second]=await Promise.all([listen(),listen()]);
 assert.equal(f.fetches,0,'page startup and listeners do not start separate upstream requests');
 await started;
 const status=await (await fetch(f.app.origin+'/api/status',{headers:auth})).json();
 assert.equal(status.appUpdate.phase,'checking');assert.equal(f.fetches,1);
 const manual=post(f.app,'check');
 assert.equal((await post(f.app,'network-restored')).status,200);
 releaseCheck();
 const [left,right,manualResponse]=await Promise.all([readStatus(first),readStatus(second),manual]);
 assert.equal(manualResponse.status,200);assert.deepEqual(await manualResponse.json(),left);
 assert.deepEqual(left,right);assert.equal(left.latest.version,'0.4.0');assert.equal(left.phase,'available');
 assert.equal(f.fetches,2,'the release metadata and its checksum were fetched only once');
 assert.equal(f.launches,0);assert.equal(f.app.operations.entries.size,0);
 controller.abort();
});

test('application update routes authenticate, reject injected fields and do not touch the Codex engine',async t=>{
 const f=await fixture(t);const {app}=f;
 assert.equal((await fetch(app.origin+'/api/app-update/status',{method:'POST',body:'{}'})).status,401);
 assert.equal((await post(app,'status')).status,200);assert.equal(f.fetches,0);
 assert.equal((await post(app,'check',{url:'https://evil.example'})).status,400);assert.equal(f.fetches,0);
 assert.equal((await post(app,'check')).status,200);
 assert.equal((await post(app,'download',{version:'0.4.0',requestId:null})).status,400);
 assert.equal((await post(app,'download',{version:'0.4.0',requestId:id(app,'injected'),path:'C:\\arbitrary.exe'})).status,400);
 const bypass=await fetch(app.origin+'/api/rpc',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify({method:'app-update/install',params:{version:'0.4.0',confirmed:true},requestId:id(app,'bypass')})});assert.equal(bypass.status,400);assert.equal(f.launches,0);assert.equal(app.rpc.connected,true);
});
test('demo exposes version/check but refuses staging or launching before operation creation',async t=>{
 const {app}=await fixture(t,{demo:true});assert.equal((await post(app,'status')).status,200);assert.equal((await post(app,'check')).status,200);
 for(const action of ['download','install']){const response=await post(app,action,{version:'0.4.0',confirmed:true,requestId:id(app,action)});assert.equal(response.status,400);assert.equal((await response.json()).code,'APP_UPDATE_DEMO');}
 assert.equal(app.operations.entries.size,0);
});
test('installer HTTP requests execute once, even concurrent or replayed under a second id',async t=>{
 const f=await fixture(t);const {app}=f;await prepare(app);const requestId=id(app,'install');const body={version:'0.4.0',confirmed:true,requestId};
 const [first,second]=await Promise.all([post(app,'install',body),post(app,'install',body)]);assert.equal(first.status,200);assert.deepEqual(await first.json(),await second.json());assert.equal(f.launches,1);
 assert.equal((await post(app,'install',{...body,requestId:id(app,'install_again')})).status,200);assert.equal(f.launches,1);
 const record=app.operations.get(requestId);assert.equal(record.state,'succeeded');assert.equal(lookupDecision({method:'app-update/install',appVersion:'0.4.0',serverInstance:app.operations.serverInstance},record),'succeeded');
});
test('unknown native outcomes remain unknown over HTTP and never restart the installer',async t=>{
 const f=await fixture(t,{unknown:true});const {app}=f;await prepare(app);const body={version:'0.4.0',confirmed:true,requestId:id(app,'unknown')};
 for(const requestId of [body.requestId,body.requestId,id(app,'new_unknown')]){const response=await post(app,'install',{...body,requestId});assert.equal(response.status,400);assert.equal((await response.json()).outcome,'unknown');}
 assert.equal(f.launches,1);assert.equal(app.operations.get(body.requestId).state,'unknown');assert.equal((await (await post(app,'status')).json()).phase,'launchUnknown');
});
test('LAN capability cannot check, download, install or inspect application updates',async t=>{
 const f=await fixture(t,{lan:true});const {app}=f;
 const enabled=await fetch(app.origin+'/api/lan/enable',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify({address:'192.168.75.20'})});const lan=await enabled.json();assert.equal(enabled.status,200);
 const capability=new URLSearchParams(new URL(lan.url).hash.slice(1)).get('token');
 for(const action of ['status','check','download','install']){
  const status=await new Promise((resolve,reject)=>{const data=JSON.stringify({version:'0.4.0',confirmed:true,requestId:id(app,'lan_'+action)});const request=http.request({hostname:'127.0.0.1',port:lan.port,path:'/api/app-update/'+action,method:'POST',headers:{Host:new URL(lan.origin).host,Origin:lan.origin,Authorization:'Bearer '+capability,'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end(data);});assert.equal(status,403);
 }
 assert.equal(f.fetches,0);assert.equal(f.launches,0);assert.equal(app.operations.entries.size,0);
});
test('application updater markers persist only identity and unknown reconciliation never implies success',()=>{
 const serverInstance='a'.repeat(32);const {marker}=makeMutation(serverInstance,'app-update/install',{version:'0.4.0',confirmed:true},{uuid:'00000000-0000-4000-8000-000000000000'});
 const restored=restoreMarkers(serializeMarkers([marker]));assert.equal(restored[0].status,'unknown');assert.equal(pendingForScope(restored,'app-update').length,1);assert.equal(restored[0].appVersion,'0.4.0');assert.equal(Object.hasOwn(restored[0],'params'),false);
 assert.equal(lookupDecision(marker,{serverInstance,state:'succeeded',method:'app-update/install',result:{phase:'launchUnknown'}}),'unknown');
 assert.equal(lookupDecision(marker,{serverInstance,state:'succeeded',method:'app-update/install',result:{phase:'launched',preparedVersion:'0.4.0'}}),'succeeded');
});


test('Velopack install gate blocks unresolved work without launching',async t=>{
 const f=await fixture(t,{veloGuard:true});await prepare(f.app);
 f.app.operations.entries.set('unresolved',{state:'unknown'});
 const response=await post(f.app,'install',{version:'0.4.0',confirmed:true,requestId:id(f.app,'blocked')});
 assert.notEqual(response.status,200);assert.equal(f.launches,0);
 const blocked=await response.json();assert.equal(blocked.code,'APP_UPDATE_WORK_ACTIVE');
 assert.match(blocked.error,/操作的执行结果尚未确认/);
 assert.equal((await (await post(f.app,'status')).json()).installBlocker,blocked.error);
 f.app.operations.entries.delete('unresolved');
 assert.equal((await (await post(f.app,'status')).json()).installBlocker,null);
 assert.equal(f.launches,0);
});
test('Velopack launch reservation blocks subsequent mutations but permits status',async t=>{
 const f=await fixture(t,{veloGuard:true});await prepare(f.app);
 const response=await post(f.app,'install',{version:'0.4.0',confirmed:true,requestId:id(f.app,'reserve')});
 assert.equal(response.status,200);assert.equal(f.launches,1);
 assert.equal((await post(f.app,'status')).status,200);
 const blocked=await post(f.app,'download',{version:'0.4.0',requestId:id(f.app,'after')});
 assert.equal((await blocked.json()).code,'APP_UPDATE_RESERVED');
});

test('install reconciles a missed completion from the engine before handing off exactly once',async t=>{
 const f=await fixture(t,{veloGuard:true});const {app}=f;await prepare(app);
 const {thread}=await app.sessions.call('thread/start',{cwd:process.cwd()});
 app.rpc.emit('event',{method:'turn/started',params:{threadId:thread.id,turn:{id:'old'}}});
 app.rpc.threads.get(thread.id).status={type:'idle'};
 app.rpc.turns.set(thread.id,[{id:'old',status:'interrupted'}]);
 const stop=id(app,'lost_stop');
 await assert.rejects(app.operations.execute(stop,'turn/interrupt',{threadId:thread.id,turnId:'old'},async()=>{throw new Error('Lost reply');}));
 const before=await(await post(app,'status')).json();assert.match(before.installBlocker,/对话正在运行/);
 const calls=[],original=app.rpc.call.bind(app.rpc);
 app.rpc.call=(method,params)=>{calls.push(method);return original(method,params);};
 const response=await post(app,'install',{version:'0.4.0',confirmed:true,requestId:id(app,'install_reconciled')});
 assert.equal(response.status,200);assert.equal(f.launches,1);
 assert.equal(app.operations.get(stop).state,'unknown');
 assert.deepEqual(app.sessions.snapshot().threads,[]);assert.equal(app.runtime.activeTurns.size,0);
 assert.ok(calls.includes('thread/read')&&calls.includes('thread/turns/list'));
 assert.ok(!calls.some(method=>['turn/interrupt','turn/start','turn/steer','thread/resume'].includes(method)));
});

test('a new turn during the idle check survives an older reply and blocks handoff',async t=>{
 const f=await fixture(t,{veloGuard:true});const {app}=f;await prepare(app);
 const {thread}=await app.sessions.call('thread/start',{cwd:process.cwd()});
 const start=turnId=>app.rpc.emit('event',{method:'turn/started',params:{threadId:thread.id,turn:{id:turnId}}});
 start('old');
 const reading=Promise.withResolvers(),release=Promise.withResolvers();
 const installId=id(app,'overlapping');
 const original=app.rpc.call.bind(app.rpc);
 app.rpc.call=async(method,params)=>{
  if(method!=='thread/read'||app.operations.entries.get(installId)?.state!=='pending')return original(method,params);
  reading.resolve();await release.promise;return {thread:{id:thread.id,status:{type:'idle'}}};
 };
 const installing=post(app,'install',{version:'0.4.0',confirmed:true,requestId:installId});
 await reading.promise;start('new');release.resolve();
 assert.equal((await installing).status,409);assert.equal(f.launches,0);
 assert.equal(app.sessions.snapshot().threads[0].activeTurnId,'new');assert.ok(app.runtime.activeTurns.has('new'));
});

test('an active or unverifiable engine and an unconfirmed native launch still block installation',async t=>{
 const f=await fixture(t,{veloGuard:true});const {app}=f;await prepare(app);
 const {thread}=await app.sessions.call('thread/start',{cwd:process.cwd()});
 app.rpc.emit('event',{method:'turn/started',params:{threadId:thread.id,turn:{id:'busy'}}});
 const install=suffix=>post(app,'install',{version:'0.4.0',confirmed:true,requestId:id(app,suffix)});
 for(const type of ['active','systemError',undefined]){
  app.rpc.threads.get(thread.id).status={type};
  assert.equal((await install('attempt_'+String(type))).status,409);assert.equal(f.launches,0);
 }
 app.rpc.threads.get(thread.id).status={type:'idle'};
 app.operations.entries.set('native-launch',{method:'app-update/install',state:'unknown'});
 assert.equal((await install('unknown_launch')).status,409);assert.equal(f.launches,0);
});

test('a failed asset transfer does not permanently block install after a verified retry',async t=>{
 const f=await fixture(t,{veloGuard:true});const {app,service}=f;
 await post(app,'check');const fetchAsset=service.fetchFn;
 service.fetchFn=async()=>{throw new TypeError('Network connection closed');};
 const interrupted=id(app,'transfer_failed');
 const failed=await post(app,'download',{version:'0.4.0',requestId:interrupted});
 assert.equal((await failed.json()).outcome,'failed');assert.equal(app.operations.get(interrupted).state,'failed');
 service.fetchFn=fetchAsset;
 assert.equal((await post(app,'download',{version:'0.4.0',requestId:id(app,'retry_transfer')})).status,200);
 assert.equal((await post(app,'install',{version:'0.4.0',confirmed:true,requestId:id(app,'after_retry')})).status,200);
 assert.equal(f.launches,1);
});

test('status recheck after a block releases an unloaded thread without starting the installer',async t=>{
 const f=await fixture(t,{veloGuard:true});const {app}=f;await prepare(app);
 const {thread}=await app.sessions.call('thread/start',{cwd:process.cwd()});
 app.rpc.emit('event',{method:'turn/started',params:{threadId:thread.id,turn:{id:'stopped'}}});
 app.rpc.threads.get(thread.id).status={type:'active'};
 assert.equal((await post(app,'install',{version:'0.4.0',confirmed:true,requestId:id(app,'active_then_idle')})).status,409);
 app.rpc.threads.get(thread.id).status={type:'notLoaded'};
 const reason=(await(await post(app,'status',{recheckWork:true})).json()).installBlocker;
 assert.equal(reason,null);assert.equal(f.launches,0);assert.deepEqual(app.sessions.snapshot().threads,[]);
});
