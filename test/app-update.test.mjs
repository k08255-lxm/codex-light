import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AppUpdateService,APP_RELEASES_API,parseAppRelease,publishedSetupHash} from '../src/app-update.mjs';
import {OperationStore} from '../src/operations.mjs';

const SETUP=Buffer.from('test installer fixture, never executable');
const HASH=createHash('sha256').update(SETUP).digest('hex');
const SUMS=`${HASH}  CodexLight-Setup.exe\n`;
const URL_BASE='https://github.com/k08255-lxm/codex-light/releases/download/v0.4.0/';
function release(overrides={}){
 return {tag_name:'v0.4.0',draft:false,prerelease:false,html_url:'https://github.com/k08255-lxm/codex-light/releases/tag/v0.4.0',body:'更新说明',published_at:'2026-11-13T00:00:00Z',assets:[{name:'CodexLight-Setup.exe',size:SETUP.length,browser_download_url:URL_BASE+'CodexLight-Setup.exe'},{name:'SHA256SUMS.txt',size:Buffer.byteLength(SUMS),browser_download_url:URL_BASE+'SHA256SUMS.txt'}],...overrides};
}
async function fixture(t,{raw=release(),setup=SETUP,sums=SUMS,fetchExtra,launchFn=async()=>{},...options}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'codex-light-update-test-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
 const calls=[];
 const fetchFn=async(url,request)=>{
  calls.push({url,request});const extra=await fetchExtra?.(url,request);if(extra)return extra;
  if(url===APP_RELEASES_API)return new Response(JSON.stringify(raw),{headers:{'content-type':'application/json'}});
  if(url===URL_BASE+'SHA256SUMS.txt')return new Response(sums);
  if(url===URL_BASE+'CodexLight-Setup.exe')return new Response(setup);
  throw new Error('Unexpected external URL: '+url);
 };
 const service=new AppUpdateService({currentVersion:'0.3.0',platform:'win32',arch:'x64',cacheRoot:root,fetchFn,launchFn,...options});t.after(()=>service.close());
 return {service,root,calls};
}

test('release accepts only the fixed project assets and stable versions',()=>{
 const parsed=parseAppRelease(release(),'0.3.0');assert.equal(parsed.version,'0.4.0');assert.equal(parsed.available,true);
 assert.equal(parseAppRelease(release(),'0.4.0').available,false);
 assert.equal(parseAppRelease(release(),'0.5.0').available,false);
 for(const raw of [release({draft:true}),release({prerelease:true}),release({tag_name:'v0.4.0-rc.1'}),release({tag_name:'../0.4.0'}),release({html_url:'https://evil.example/release'}),release({assets:[]})])assert.throws(()=>parseAppRelease(raw,'0.3.0'));
 const malicious=release();malicious.assets[0].browser_download_url='https://github.com/another/project/releases/download/v0.4.0/CodexLight-Setup.exe';assert.throws(()=>parseAppRelease(malicious,'0.3.0'));
 const huge=release();huge.assets[0].size=301*1024*1024;assert.throws(()=>parseAppRelease(huge,'0.3.0'));
});
test('published checksums require one exact installer filename',()=>{
 assert.equal(publishedSetupHash(SUMS),HASH);assert.equal(publishedSetupHash(SUMS.replace('  ',' *')),HASH);
 assert.throws(()=>publishedSetupHash(SUMS+SUMS));assert.throws(()=>publishedSetupHash(SUMS.replace('CodexLight-Setup.exe','../CodexLight-Setup.exe')));assert.throws(()=>publishedSetupHash('not a checksum'));
});
test('status is local-only; explicit check downloads metadata and checksum, never installer',async t=>{
 const {service,calls}=await fixture(t);assert.equal(service.status().phase,'idle');assert.equal(calls.length,0);
 const status=await service.check();assert.equal(status.phase,'available');assert.equal(status.latest.version,'0.4.0');assert.equal(calls.length,2);assert.equal(calls[0].request.redirect,'manual');assert.ok(calls.every(call=>!call.url.endsWith('.exe')));
});
test('no update and unsupported platforms never stage an installer',async t=>{
 const same=await fixture(t,{currentVersion:'0.4.0'});assert.equal((await same.service.check()).phase,'upToDate');await assert.rejects(same.service.download({version:'0.4.0'}),/先检查/);
 const unsupported=await fixture(t,{platform:'linux'});await unsupported.service.check();assert.equal(unsupported.service.status().supported,false);await assert.rejects(unsupported.service.download({version:'0.4.0'}),/Windows x64/);
});
test('download validates exact size/hash and only explicit confirmed install launches once',async t=>{
 const launches=[];const {service,calls}=await fixture(t,{launchFn:async(...args)=>launches.push(args)});await service.check();
 const ready=await service.download({version:'0.4.0'});assert.equal(ready.phase,'ready');assert.equal(ready.receivedBytes,SETUP.length);assert.equal(launches.length,0);assert.equal(ready.preparedVersion,'0.4.0');assert.equal(Object.hasOwn(ready,'file'),false);
 await assert.rejects(service.install({version:'0.4.0',confirmed:false}),/确认/);
 assert.equal((await service.install({version:'0.4.0',confirmed:true})).phase,'launched');assert.equal(launches.length,1);assert.deepEqual(launches[0][1],{sha256:HASH});assert.equal(path.basename(launches[0][0]),'CodexLight-Setup.exe');assert.deepEqual(await readFile(launches[0][0]),SETUP);
 await service.install({version:'0.4.0',confirmed:true});await service.check();await service.install({version:'0.4.0',confirmed:true});assert.equal(launches.length,1);assert.equal(calls.filter(call=>call.url.endsWith('.exe')).length,1);
});
test('wrong hash or truncated stream deletes partial files and cannot launch',async t=>{
 for(const setup of [Buffer.alloc(SETUP.length,99),SETUP.subarray(0,8)]){
  let launches=0;const {service,root}=await fixture(t,{setup,launchFn:async()=>launches++});await service.check();await assert.rejects(service.download({version:'0.4.0'}),/SHA256|不完整/);assert.equal(service.status().phase,'failed');assert.equal(service.status().preparedVersion,null);
  await assert.rejects(service.install({version:'0.4.0',confirmed:true}),/先下载/);assert.equal(launches,0);
  const directories=await readdir(root);for(const directory of directories)assert.deepEqual(await readdir(path.join(root,directory)),[]);
 }
});
test('download rejects off-site redirects and oversized responses',async t=>{
 const offsite=await fixture(t,{fetchExtra:url=>url.endsWith('.exe')?new Response(null,{status:302,headers:{location:'https://evil.example/Setup.exe'}}):null});await offsite.service.check();await assert.rejects(offsite.service.download({version:'0.4.0'}),/来源/);
 const tooLarge=await fixture(t,{setup:Buffer.alloc(SETUP.length+1)});await tooLarge.service.check();await assert.rejects(tooLarge.service.download({version:'0.4.0'}),/允许大小/);
});
test('GitHub asset CDN redirect remains verified against published hash',async t=>{
 const cdn='https://release-assets.githubusercontent.com/github-production-release-asset/123/fixture';
 const {service}=await fixture(t,{fetchExtra:url=>url===URL_BASE+'CodexLight-Setup.exe'?new Response(null,{status:302,headers:{location:cdn}}):url===cdn?new Response(SETUP):null});await service.check();assert.equal((await service.download({version:'0.4.0'})).phase,'ready');
});
test('tampered prepared file cannot be executed',async t=>{
 let installer;let launches=0;const {service,root}=await fixture(t,{launchFn:async file=>{installer=file;launches++;}});await service.check();await service.download({version:'0.4.0'});
 const [directory]=await readdir(root);await writeFile(path.join(root,directory,'CodexLight-Setup.exe'),Buffer.alloc(SETUP.length,11));await assert.rejects(service.install({version:'0.4.0',confirmed:true}),/发生变化/);assert.equal(service.status().preparedVersion,null);assert.equal(launches,0);assert.equal(installer,undefined);
});
test('unknown launch outcomes lock out retries, including new operation ids',async t=>{
 let launches=0;const {service}=await fixture(t,{launchFn:async()=>{launches++;throw new Error('native acknowledgement timed out');}});await service.check();await service.download({version:'0.4.0'});
 const operations=new OperationStore();const makeId=n=>`${operations.serverInstance}:${Date.now()}:update_test_${n}`;
 const params={version:'0.4.0',confirmed:true};const first=makeId(1);await assert.rejects(operations.execute(first,'app-update/install',params,()=>service.install(params)),/timed out/);assert.equal(operations.get(first).state,'unknown');assert.equal(service.status().phase,'launchUnknown');
 await assert.rejects(operations.execute(first,'app-update/install',params,()=>service.install(params)),/timed out/);
 await assert.rejects(operations.execute(makeId(2),'app-update/install',params,()=>service.install(params)),/未知/);await assert.rejects(service.check(),/未知/);assert.equal(launches,1);
});
test('known pre-launch failure can be retried without falsely claiming installer opened',async t=>{
 let launches=0;const {service}=await fixture(t,{launchFn:async()=>{launches++;if(launches===1)throw Object.assign(new Error('process unavailable'),{outcome:'notExecuted'});}});await service.check();await service.download({version:'0.4.0'});
 await assert.rejects(service.install({version:'0.4.0',confirmed:true}),/unavailable/);assert.equal(service.status().phase,'failed');assert.equal((await service.install({version:'0.4.0',confirmed:true})).phase,'launched');assert.equal(launches,2);
});
test('stale or injected update parameters are rejected before filesystem or launch',async t=>{
 let now=1700000000000;const {service}=await fixture(t,{now:()=>now});await service.check();await assert.rejects(service.download({version:'../0.4.0'}),/选择/);await assert.rejects(service.download({version:'0.4.0',url:'https://evil.example/'}),/参数/);
 now+=60*60000+1;await assert.rejects(service.download({version:'0.4.0'}),/过期/);
});
