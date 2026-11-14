import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AppUpdateService,APP_RELEASES_API,parseAppRelease,publishedSetupHash} from '../src/app-update.mjs';
const version='0.4.4';
const name=`CodexLightDesktop-${version}-full.nupkg`;
const base=`https://github.com/k08255-lxm/codex-light/releases/download/v${version}/`;
const data=Buffer.from('inert full package test fixture, never executed');
const hash=createHash('sha256').update(data).digest('hex');
const sums=`${hash}  ${name}\n`;
function release(){return {tag_name:`v${version}`,draft:false,prerelease:false,html_url:`https://github.com/k08255-lxm/codex-light/releases/tag/v${version}`,assets:[{name,size:data.length,browser_download_url:base+name},{name:'SHA256SUMS.txt',size:Buffer.byteLength(sums),browser_download_url:base+'SHA256SUMS.txt'}]};}
async function fixture(t,options={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'codex-light-velo-update-test-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
 const calls=[];const {raw=release(),checksum=sums,body=data,extra,launchFn=async()=>{},...rest}=options;
 const fetchFn=async url=>{calls.push(url);const response=await extra?.(url);if(response)return response;if(url===APP_RELEASES_API)return new Response(JSON.stringify(raw));if(url===base+'SHA256SUMS.txt')return new Response(checksum);if(url===base+name)return new Response(body);throw new Error('Unexpected network URL '+url);};
 const service=new AppUpdateService({currentVersion:'0.4.3',platform:'win32',arch:'x64',cacheRoot:root,updateTransport:'velopack',fetchFn,launchFn,...rest});t.after(()=>service.close());return {service,root,calls};
}
test('Velopack selects only the exact full asset, never MSI or deltas',()=>{
 const raw=release();raw.assets.push({name:'CodexLight-Setup-0.4.4-x64.exe',size:10,browser_download_url:base+'CodexLight-Setup-0.4.4-x64.exe'});
 assert.equal(parseAppRelease(raw,'0.4.3','velopack').setup.name,name);
 assert.equal(parseAppRelease(raw,'0.4.3','velopack').updateTransport,'velopack');
 for(const badName of ['CodexLightDesktop-0.4.4-delta.nupkg','CodexLightDesktop-0.4.5-full.nupkg','Other-0.4.4-full.nupkg','CodexLightDesktop-0.4.4-full.NUPKG']){
  const changed=release();changed.assets[0]={...changed.assets[0],name:badName,browser_download_url:base+badName};assert.throws(()=>parseAppRelease(changed,'0.4.3','velopack'),{code:'APP_UPDATE_ASSET_MISSING'});
 }
 const duplicates=release();duplicates.assets.push(duplicates.assets[0]);assert.throws(()=>parseAppRelease(duplicates,'0.4.3','velopack'));
});
test('Velopack inherits URL/version/size/draft validation without fallback',()=>{
 for(const modify of [r=>r.draft=true,r=>r.prerelease=true,r=>r.assets[0].size=301*1024*1024,r=>r.assets[0].browser_download_url=base+name+'?x=1',r=>r.assets[0].browser_download_url='https://github.com/other/project/releases/download/v0.4.4/'+name,r=>r.html_url='https://example.com/release']){
  const raw=release();modify(raw);assert.throws(()=>parseAppRelease(raw,'0.4.3','velopack'));
 }
 assert.throws(()=>parseAppRelease(release(),'0.4.3','external'),{code:'APP_UPDATE_TRANSPORT_INVALID'});
 assert.throws(()=>new AppUpdateService({currentVersion:'0.4.3',updateTransport:'external'}),{code:'APP_UPDATE_TRANSPORT_INVALID'});
});
test('Velopack checksum names reject delta, traversal, leading zeros and duplicates',()=>{
 assert.equal(publishedSetupHash(sums,name),hash);
 for(const bad of ['../'+name,'CodexLightDesktop-00.4.4-full.nupkg','CodexLightDesktop-0.4.4-delta.nupkg'])assert.throws(()=>publishedSetupHash(`${hash}  ${bad}\n`,bad));
 assert.throws(()=>publishedSetupHash(sums+sums,name));assert.throws(()=>publishedSetupHash(sums.replace('0.4.4','0.4.5'),name));
});
test('full package stages under its canonical name and invokes only injected native hook',async t=>{
 const launches=[];const {service,calls}=await fixture(t,{launchFn:async(...args)=>launches.push(args)});
 assert.equal(service.status().updateTransport,'velopack');await service.check();assert.equal(calls.length,2);
 await service.download({version});assert.equal(launches.length,0);await service.install({version,confirmed:true});
 assert.equal(launches.length,1);assert.equal(path.basename(launches[0][0]),name);assert.deepEqual(await readFile(launches[0][0]),data);
 assert.deepEqual(launches[0][1],{sha256:hash,version,updateTransport:'velopack'});
 assert.ok(calls.every(url=>!url.endsWith('.exe')&&!url.includes('-delta.')));
});
test('Velopack missing native launcher is fail-closed and parameter injection cannot change transport',async t=>{
 const {service,root}=await fixture(t);const noNative=new AppUpdateService({currentVersion:'0.4.3',platform:'win32',cacheRoot:root,updateTransport:'velopack',fetchFn:service.fetchFn});t.after(()=>noNative.close());
 await noNative.check();await noNative.download({version});await assert.rejects(noNative.install({version,confirmed:true}),{code:'APP_UPDATE_NATIVE_REQUIRED'});assert.equal(noNative.status().phase,'ready');
 await assert.rejects(service.download({version,updateTransport:'msi'}),{code:'APP_UPDATE_INPUT_INVALID'});
 await assert.rejects(service.install({version,confirmed:true,updateTransport:'msi'}),{code:'APP_UPDATE_INPUT_INVALID'});
 assert.throws(()=>new AppUpdateService({currentVersion:'0.4.3',updateTransport:'velopack',launchFn:null}),{code:'APP_UPDATE_LAUNCHER_INVALID'});
});
test('Velopack tampered/missing packages never reach native launcher',async t=>{
 let called=0;const {service,root}=await fixture(t,{launchFn:async()=>called++});await service.check();await service.download({version});
 const [dir]=await readdir(root);await writeFile(path.join(root,dir,name),Buffer.alloc(data.length,42));await assert.rejects(service.install({version,confirmed:true}),{code:'APP_UPDATE_HASH_MISMATCH'});assert.equal(called,0);
});
test('Velopack bad hashes and external redirects leave no executable staged package',async t=>{
 for(const opts of [{body:Buffer.alloc(data.length,42)},{extra:url=>url===base+name?new Response(null,{status:302,headers:{location:'https://example.com/package.nupkg'}}):null}]){
  const {service,root}=await fixture(t,opts);await service.check();await assert.rejects(service.download({version}));for(const dir of await readdir(root))assert.deepEqual(await readdir(path.join(root,dir)),[]);
 }
});
