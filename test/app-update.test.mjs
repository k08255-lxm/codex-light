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
const VERSIONED_SETUP='CodexLight-Setup-0.4.0-x64.exe';
const FULL_PACKAGE='CodexLightDesktop-0.4.0-full.nupkg';
const LARGE_SETUP=Buffer.concat([1,2,3,4].map(value=>Buffer.alloc(1024*1024,value)).concat(Buffer.from('end')));
const LARGE_RANGES=['bytes=0-1048575','bytes=1048576-2097152','bytes=2097153-3145729','bytes=3145730-4194306'];
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
  if(url===URL_BASE+'CodexLight-Setup.exe'||url===URL_BASE+VERSIONED_SETUP)return new Response(setup);
  throw new Error('Unexpected external URL: '+url);
 };
 const service=new AppUpdateService({currentVersion:'0.3.0',platform:'win32',arch:'x64',cacheRoot:root,fetchFn,launchFn,...options});t.after(()=>service.close());
 return {service,root,calls};
}

function rangeBody(request){
 const [,start,end]=/^bytes=(\d+)-(\d+)$/.exec(request.headers.Range);
 return LARGE_SETUP.subarray(Number(start),Number(end)+1);
}
function rangeResponse(request,{body=rangeBody(request),headers={}}={}){
 return new Response(body,{status:206,headers:{
  'Content-Range':`${request.headers.Range.replace('=', ' ')}/${LARGE_SETUP.length}`,
  'Content-Length':rangeBody(request).length,
  ...headers
 }});
}
async function largeFixture(t,{fetchExtra,updateTransport='msi',...options}={}){
 const name=updateTransport==='msi'?VERSIONED_SETUP:FULL_PACKAGE;
 const hash=createHash('sha256').update(LARGE_SETUP).digest('hex');
 const sums=`${hash}  ${name}\n`;
 const raw=release({assets:[
  {name,size:LARGE_SETUP.length,browser_download_url:URL_BASE+name},
  {name:'SHA256SUMS.txt',size:Buffer.byteLength(sums),browser_download_url:URL_BASE+'SHA256SUMS.txt'}
 ]});
 const result=await fixture(t,{raw,sums,updateTransport,launchFn:async()=>{},...options,
  fetchExtra:async(url,request)=>await fetchExtra?.(url,request)||(url===URL_BASE+name?rangeResponse(request):null)
 });
 await result.service.check();
 return {...result,url:URL_BASE+name};
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
test('release prefers the exact tag-derived versioned installer and preserves the legacy fallback',()=>{
 const raw=release();const versioned={...raw.assets[0],name:VERSIONED_SETUP,browser_download_url:URL_BASE+VERSIONED_SETUP,size:256*1024};raw.assets.push(versioned);
 const parsed=parseAppRelease(raw,'0.3.0');assert.equal(parsed.setup.name,VERSIONED_SETUP);assert.equal(parsed.setup.url,URL_BASE+VERSIONED_SETUP);
 assert.equal(parseAppRelease(release(),'0.3.0').setup.name,'CodexLight-Setup.exe');
 const bare=release({tag_name:'0.4.0',html_url:'https://github.com/k08255-lxm/codex-light/releases/tag/0.4.0',assets:raw.assets.filter(item=>item.name!=='CodexLight-Setup.exe').map(item=>({...item,browser_download_url:item.browser_download_url.replace('/v0.4.0/','/0.4.0/')}))});
 assert.equal(parseAppRelease(bare,'0.3.0').setup.name,VERSIONED_SETUP);
});
test('versioned assets cannot bypass uniqueness, tag, size or URL validation through the legacy fallback',()=>{
 const versioned={...release().assets[0],name:VERSIONED_SETUP,browser_download_url:URL_BASE+VERSIONED_SETUP};
 for(const extras of [[versioned,versioned],[{...versioned,size:301*1024*1024}],[{...versioned,browser_download_url:URL_BASE+'CodexLight-Setup.exe'}],[{...versioned,browser_download_url:URL_BASE+VERSIONED_SETUP+'?download=1'}],[{...versioned,browser_download_url:URL_BASE+'../v0.4.0/'+VERSIONED_SETUP}]]){
  const raw=release();raw.assets.push(...extras);assert.throws(()=>parseAppRelease(raw,'0.3.0'));
 }
 for(const name of ['CodexLight-Setup-0.4.1-x64.exe','CodexLight-Setup-0.4.0-arm64.exe','../'+VERSIONED_SETUP]){
  const raw=release();raw.assets[0]={...versioned,name,browser_download_url:URL_BASE+encodeURIComponent(name)};assert.throws(()=>parseAppRelease(raw,'0.3.0'));
 }
});
test('versioned checksums bind to the selected asset without accepting another name or duplicate',()=>{
 const versioned=`${HASH}  ${VERSIONED_SETUP}\n`;const alias=`${'1'.repeat(64)}  CodexLight-Setup.exe\n`;
 assert.equal(publishedSetupHash(versioned+alias,VERSIONED_SETUP),HASH);
 assert.equal(publishedSetupHash(versioned.replace('  ',' *'),VERSIONED_SETUP),HASH);
 for(const sums of [alias,versioned+versioned,versioned.replace(VERSIONED_SETUP,'../'+VERSIONED_SETUP),versioned.replace('0.4.0','0.4.1')])assert.throws(()=>publishedSetupHash(sums,VERSIONED_SETUP));
 for(const name of ['../'+VERSIONED_SETUP,'CodexLight-Setup-00.4.0-x64.exe','CodexLight-Setup-0.4.0-arm64.exe'])assert.throws(()=>publishedSetupHash(versioned,name));
});
test('versioned-only download verifies its own checksum and keeps the native launcher cache basename',async t=>{
 const sums=`${HASH}  ${VERSIONED_SETUP}\n${'1'.repeat(64)}  CodexLight-Setup.exe\n`;const raw=release();
 raw.assets[0]={...raw.assets[0],name:VERSIONED_SETUP,browser_download_url:URL_BASE+VERSIONED_SETUP};raw.assets[1].size=Buffer.byteLength(sums);
 const launches=[];const {service,calls}=await fixture(t,{raw,sums,launchFn:async file=>launches.push(file)});
 await service.check();assert.equal((await service.download({version:'0.4.0'})).phase,'ready');await service.install({version:'0.4.0',confirmed:true});
 assert.equal(calls.filter(call=>call.url.endsWith('.exe')).length,1);assert.ok(calls.some(call=>call.url===URL_BASE+VERSIONED_SETUP));assert.equal(path.basename(launches[0]),'CodexLight-Setup.exe');assert.deepEqual(await readFile(launches[0]),SETUP);
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
 assert.ok(calls.every(call=>call.request.headers.Range===undefined));
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
test('large Windows packages use four parallel, disjoint ranges through trusted redirects',async t=>{
 for(const updateTransport of ['msi','velopack'])await t.test(updateTransport,async t=>{
  const redirect='https://release-assets.githubusercontent.com/github-production-release-asset/123/large-fixture';
  let releaseBodies;
  const allRequested=new Promise(resolve=>{releaseBodies=resolve;});
  let cdnRequests=0;
  const {service,calls,root,url}=await largeFixture(t,{updateTransport,downloadTimeoutMs:2000,fetchExtra:(url,request)=>{
   if(url.endsWith(VERSIONED_SETUP)||url.endsWith(FULL_PACKAGE))return new Response(null,{status:302,headers:{location:redirect}});
   if(url!==redirect)return;
   if(++cdnRequests===LARGE_RANGES.length)releaseBodies();
   const body=new ReadableStream({start(controller){
    request.signal.addEventListener('abort',()=>controller.error(request.signal.reason),{once:true});
    allRequested.then(()=>{
     if(request.signal.aborted)return;
     controller.enqueue(rangeBody(request));
     controller.close();
    });
   }});
   return rangeResponse(request,{body});
  }});
  const [ready,joined]=await Promise.all([service.download({version:'0.4.0'}),service.download({version:'0.4.0'})]);
  assert.deepEqual(joined,ready);
  assert.equal(ready.phase,'ready');
  assert.equal(ready.receivedBytes,LARGE_SETUP.length);
  assert.equal(ready.totalBytes,LARGE_SETUP.length);
  for(const origin of [url,redirect]){
   const requests=calls.filter(call=>call.url===origin).map(call=>call.request);
   assert.deepEqual(requests.map(request=>request.headers.Range).sort(),LARGE_RANGES.toSorted());
   assert.ok(requests.every(request=>request.headers['Accept-Encoding']==='identity'&&request.redirect==='manual'));
  }
  assert.ok(calls.filter(call=>call.url!==url&&call.url!==redirect).every(call=>call.request.headers.Range===undefined));
  const [directory]=await readdir(root);
  const stagedName=updateTransport==='msi'?'CodexLight-Setup.exe':FULL_PACKAGE;
  assert.deepEqual(await readdir(path.join(root,directory)),[stagedName]);
  assert.deepEqual(await readFile(path.join(root,directory,stagedName)),LARGE_SETUP);
 });
});
test('a server that ignores Range reuses the complete response and still verifies the checksum',async t=>{
 for(const validHash of [true,false]){
  const body=validHash?LARGE_SETUP:Buffer.alloc(LARGE_SETUP.length,9);
  const {service,calls,root,url}=await largeFixture(t,{fetchExtra:url=>url.endsWith(VERSIONED_SETUP)?new Response(body):null});
  if(validHash){
   const ready=await service.download({version:'0.4.0'});
   assert.equal(ready.phase,'ready');
   assert.equal(ready.receivedBytes,LARGE_SETUP.length);
  }else{
   await assert.rejects(service.download({version:'0.4.0'}),{code:'APP_UPDATE_HASH_MISMATCH'});
   for(const directory of await readdir(root))assert.deepEqual(await readdir(path.join(root,directory)),[]);
  }
  assert.deepEqual(calls.filter(call=>call.url===url).map(call=>call.request.headers.Range),[LARGE_RANGES[0]]);
 }
});
test('invalid range responses never stage an installer',async t=>{
 const cases=[
  ['wrong offsets',request=>rangeResponse(request,{headers:{'Content-Range':`bytes 0-1048575/${LARGE_SETUP.length}`}}),'APP_UPDATE_RANGE_INVALID'],
  ['wrong total',request=>rangeResponse(request,{headers:{'Content-Range':`bytes 1048576-2097152/${LARGE_SETUP.length+1}`}}),'APP_UPDATE_RANGE_INVALID'],
  ['inconsistent 200',()=>new Response(LARGE_SETUP),'APP_UPDATE_RANGE_INVALID'],
  ['compressed segment',request=>rangeResponse(request,{headers:{'Content-Encoding':'gzip'}}),'APP_UPDATE_RANGE_INVALID'],
  ['incorrect Content-Length',request=>rangeResponse(request,{headers:{'Content-Length':1}}),'APP_UPDATE_SIZE_MISMATCH'],
  ['short body',request=>rangeResponse(request,{body:rangeBody(request).subarray(1)}),'APP_UPDATE_SIZE_MISMATCH'],
  ['overlong body',request=>rangeResponse(request,{body:Buffer.concat([rangeBody(request),Buffer.from([1])])}),'APP_UPDATE_TOO_LARGE'],
  ['tampered bytes',request=>rangeResponse(request,{body:Buffer.alloc(rangeBody(request).length,9)}),'APP_UPDATE_HASH_MISMATCH'],
  ['untrusted redirect',()=>new Response(null,{status:302,headers:{location:'https://example.com/update.exe'}}),'APP_UPDATE_SOURCE_INVALID']
 ];
 for(const [name,response,code] of cases)await t.test(name,async t=>{
  const {service,root}=await largeFixture(t,{fetchExtra:(url,request)=>url.endsWith(VERSIONED_SETUP)&&request.headers.Range===LARGE_RANGES[1]?response(request):null});
  await assert.rejects(service.download({version:'0.4.0'}),{code});
  assert.equal(service.status().phase,'failed');
  assert.equal(service.status().preparedVersion,null);
  for(const directory of await readdir(root))assert.deepEqual(await readdir(path.join(root,directory)),[]);
 });
});
test('an unsatisfiable range aborts outstanding requests, joins them, and allows retry',async t=>{
 let retry=false;let aborted=0;
 const {service,root}=await largeFixture(t,{fetchExtra:(url,request)=>{
  if(retry||!url.endsWith(VERSIONED_SETUP)||request.headers.Range===LARGE_RANGES[0])return;
  if(request.headers.Range===LARGE_RANGES[1])return new Response(null,{status:416,headers:{'Content-Range':`bytes */${LARGE_SETUP.length}`}});
  return new Promise((_,reject)=>request.signal.addEventListener('abort',()=>setImmediate(()=>{
   aborted++;
   reject(request.signal.reason);
  }),{once:true}));
 }});
 await assert.rejects(service.download({version:'0.4.0'}),{code:'APP_UPDATE_HTTP_FAILED',message:/HTTP 416/});
 assert.equal(aborted,2);
 for(const directory of await readdir(root))assert.deepEqual(await readdir(path.join(root,directory)),[]);
 retry=true;
 assert.equal((await service.download({version:'0.4.0'})).phase,'ready');
});
test('closing or timing out a parallel download aborts its active bodies and cleans up',async t=>{
 for(const mode of ['close','timeout'])await t.test(mode,async t=>{
  let started=0;let aborted=0;
  let notifyStarted;
  const allStarted=new Promise(resolve=>{notifyStarted=resolve;});
  const {service,root}=await largeFixture(t,{downloadTimeoutMs:500,fetchExtra:(url,request)=>{
   if(!url.endsWith(VERSIONED_SETUP))return;
   const body=new ReadableStream({start(controller){
    if(++started===LARGE_RANGES.length)notifyStarted();
    request.signal.addEventListener('abort',()=>{
     aborted++;
     controller.error(request.signal.reason);
    },{once:true});
   }});
   return rangeResponse(request,{body});
  }});
  const failure=assert.rejects(service.download({version:'0.4.0'}),{name:'AbortError'});
  if(mode==='close'){
   await Promise.race([allStarted,failure]);
   assert.equal(started,LARGE_RANGES.length);
   await service.close();
  }
  await failure;
  assert.ok(started>0);
  assert.equal(aborted,started);
  assert.equal(service.status().preparedVersion,null);
  for(const directory of await readdir(root))assert.deepEqual(await readdir(path.join(root,directory)),[]);
 });
});
test('short positional writes are retried in order on a shared file handle',async t=>{
 const {service}=await largeFixture(t);
 const target=Buffer.alloc(LARGE_SETUP.length);
 let writing=false;
 await service._downloadAsset(service.latest.setup,{async write(chunk,offset,length,position){
  assert.equal(writing,false);
  writing=true;
  await new Promise(resolve=>setImmediate(resolve));
  const bytesWritten=Math.min(length,127*1024);
  target.set(chunk.subarray(offset,offset+bytesWritten),position);
  writing=false;
  return {bytesWritten};
 }},new AbortController().signal);
 assert.deepEqual(target,LARGE_SETUP);
 assert.equal(service.receivedBytes,LARGE_SETUP.length);
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
 assert.equal(service.status().requiresRecheck,false);
 now+=60*60000+1;assert.equal(service.status().requiresRecheck,true);await assert.rejects(service.download({version:'0.4.0'}),/过期/);
});


test('0.4.2 detects 0.4.3 with matching versioned installer and release notes',()=>{
 const raw={tag_name:'v0.4.3',draft:false,prerelease:false,html_url:'https://github.com/k08255-lxm/codex-light/releases/tag/v0.4.3',body:'QR pairing and automatic update checks',assets:[{name:'CodexLight-Setup-0.4.3-x64.exe',size:4096,browser_download_url:'https://github.com/k08255-lxm/codex-light/releases/download/v0.4.3/CodexLight-Setup-0.4.3-x64.exe'},{name:'SHA256SUMS.txt',size:256,browser_download_url:'https://github.com/k08255-lxm/codex-light/releases/download/v0.4.3/SHA256SUMS.txt'}]};
 const result=parseAppRelease(raw,'0.4.2');assert.equal(result.available,true);assert.equal(result.version,'0.4.3');assert.equal(parseAppRelease(raw,'0.4.3').available,false);
});
