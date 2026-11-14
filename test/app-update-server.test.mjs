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
async function fixture(t,{demo=false,unknown=false,lan=false,veloGuard=false}={}){
 const directory=await mkdtemp(path.join(os.tmpdir(),'app-update-route-'));let launches=0,fetches=0;
 const release={tag_name:'v0.4.0',html_url:'https://github.com/k08255-lxm/codex-light/releases/tag/v0.4.0',body:'Test notes',assets:[{name:'CodexLight-Setup.exe',size:setup.length,browser_download_url:base+'CodexLight-Setup.exe'},{name:'SHA256SUMS.txt',size:Buffer.byteLength(sum),browser_download_url:base+'SHA256SUMS.txt'}]};
 const service=new AppUpdateService({currentVersion:'0.3.0',platform:'win32',arch:'x64',cacheRoot:directory,fetchFn:async url=>{fetches++;return new Response(url===APP_RELEASES_API?JSON.stringify(release):url.endsWith('SHA256SUMS.txt')?sum:setup);},launchFn:async()=>{launches++;if(unknown)throw new Error('native acknowledgement timeout');}});
 const app=await createServer({client:new DemoClient(),demo,desktopUpdateTransport:veloGuard?'velopack':'msi',appUpdateService:service,...(lan?{lanOptions:{networkInterfaces:()=>({Synthetic:[{address:'192.168.75.20',family:'IPv4',internal:false}]}),serverFactory:handler=>{const server=http.createServer(handler),listen=server.listen.bind(server);server.listen=options=>listen({...options,host:'127.0.0.1'});return server;}}}:{})});
 await app.started;t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true,maxRetries:3});});
 return {app,service,get launches(){return launches;},get fetches(){return fetches;}};
}
function post(app,action,value={}){return fetch(app.origin+'/api/app-update/'+action,{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify(value)});}
function id(app,suffix){return `${app.operations.serverInstance}:${Date.now()}:app_update_${suffix}`;}
async function prepare(app){assert.equal((await post(app,'check')).status,200);assert.equal((await post(app,'download',{version:'0.4.0',requestId:id(app,'download')})).status,200);}

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
 assert.equal((await response.json()).code,'APP_UPDATE_WORK_ACTIVE');
});
test('Velopack launch reservation blocks subsequent mutations but permits status',async t=>{
 const f=await fixture(t,{veloGuard:true});await prepare(f.app);
 const response=await post(f.app,'install',{version:'0.4.0',confirmed:true,requestId:id(f.app,'reserve')});
 assert.equal(response.status,200);assert.equal(f.launches,1);
 assert.equal((await post(f.app,'status')).status,200);
 const blocked=await post(f.app,'download',{version:'0.4.0',requestId:id(f.app,'after')});
 assert.equal((await blocked.json()).code,'APP_UPDATE_RESERVED');
});
