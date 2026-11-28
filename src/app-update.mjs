import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,mkdir,open,realpath,rename,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {compareVersions} from './update-manifest.mjs';

export const APP_RELEASES_API='https://api.github.com/repos/k08255-lxm/codex-light/releases/latest';
export const APP_RELEASES_URL='https://github.com/k08255-lxm/codex-light/releases';
const REPO_DOWNLOAD='/k08255-lxm/codex-light/releases/download/';
const SETUP='CodexLight-Setup.exe';
const SUMS='SHA256SUMS.txt';
const FULL_PACKAGE=/^CodexLightDesktop-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-full\.nupkg$/;
function transport(value){if(value!=='msi'&&value!=='velopack')throw fail('Unsupported application update transport','APP_UPDATE_TRANSPORT_INVALID');return value;}
function cacheName(version,updateTransport){return updateTransport==='velopack'?`CodexLightDesktop-${version}-full.nupkg`:SETUP;}
const MAX_SETUP=300*1024*1024;
const MIN_PARALLEL_SIZE=4*1024*1024;
const DOWNLOAD_SEGMENTS=4;
const VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const fail=(message,code,outcome='notExecuted')=>Object.assign(new Error(message),{code,outcome});
function strict(input,keys){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key)))throw fail('应用更新参数无效','APP_UPDATE_INPUT_INVALID');
}
function trustedUrl(value,{api=false}={}){
 let url;try{url=new URL(value);}catch{throw fail('更新下载地址无效','APP_UPDATE_SOURCE_INVALID');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)throw fail('更新仅允许可信 HTTPS 来源','APP_UPDATE_SOURCE_INVALID');
 if(api){if(url.href!==APP_RELEASES_API)throw fail('更新信息来源不属于本项目','APP_UPDATE_SOURCE_INVALID');}
 else if(!(url.hostname==='github.com'&&url.pathname.startsWith(REPO_DOWNLOAD))&&!['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname))throw fail('安装包来源不属于 GitHub Release','APP_UPDATE_SOURCE_INVALID');
 return url;
}
async function limitedBytes(response,max){
 const declared=Number(response.headers.get('content-length'));
 if(declared>max)throw fail('应用更新响应过大','APP_UPDATE_TOO_LARGE');
 const chunks=[];let count=0;
 if(!response.body)throw fail('应用更新响应为空','APP_UPDATE_EMPTY');
 for await(const chunk of response.body){count+=chunk.length;if(count>max)throw fail('应用更新响应过大','APP_UPDATE_TOO_LARGE');chunks.push(Buffer.from(chunk));}
 return Buffer.concat(chunks);
}
function asset(release,name,{installer=false}={}){
 const matches=Array.isArray(release.assets)?release.assets.filter(item=>item?.name===name):[];
 if(matches.length!==1)throw fail(`发布版本缺少唯一的 ${name}`,'APP_UPDATE_ASSET_MISSING');
 const item=matches[0];const url=trustedUrl(item.browser_download_url);
 const expected=`${REPO_DOWNLOAD}${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`;
 if(item.browser_download_url!==`https://github.com${expected}`)throw fail('发布附件地址与版本不匹配','APP_UPDATE_SOURCE_INVALID');
 if(!Number.isSafeInteger(item.size)||item.size<1||item.size>(installer?MAX_SETUP:128*1024))throw fail('发布附件大小无效','APP_UPDATE_TOO_LARGE');
 return {name,url:url.href,size:item.size};
}
export function parseAppRelease(release,currentVersion,updateTransport='msi'){
 transport(updateTransport);
 const version=typeof release?.tag_name==='string'?release.tag_name.replace(/^v/,''):'';
 if(!VERSION.test(version)||release.draft===true||release.prerelease===true)throw fail('没有可安装的稳定发布版本','APP_UPDATE_RELEASE_INVALID');
 const versionedSetup=`CodexLight-Setup-${version}-x64.exe`;
 // A present versioned asset must validate; never hide a bad or duplicate asset behind the legacy alias.
 const setupName=updateTransport==='velopack'?cacheName(version,updateTransport):(Array.isArray(release.assets)&&release.assets.some(item=>item?.name===versionedSetup)?versionedSetup:SETUP);
 const setup=asset(release,setupName,{installer:true});const sums=asset(release,SUMS);
 if(release.html_url!==`https://github.com/k08255-lxm/codex-light/releases/tag/${encodeURIComponent(release.tag_name)}`)throw fail('发布页面来源无效','APP_UPDATE_SOURCE_INVALID');
 return {version,tag:release.tag_name,releaseUrl:release.html_url,notes:typeof release.body==='string'?release.body.slice(0,12000):'',publishedAt:typeof release.published_at==='string'?release.published_at:null,available:compareVersions(currentVersion,version)<0,setup,sums,...(updateTransport==='velopack'?{updateTransport}:{} )};
}
export function publishedSetupHash(text,name=SETUP){
 if(name!==SETUP&&!/^CodexLight-Setup-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-x64\.exe$/.test(name)&&!FULL_PACKAGE.test(name))throw fail('发布安装包文件名无效','APP_UPDATE_CHECKSUM_INVALID');
 const matches=String(text).replace(/^\uFEFF/,'').split(/\r?\n/).map(line=>/^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line)).filter(match=>match&&match[2]===name);
 if(matches.length!==1)throw fail('发布校验文件缺少唯一的安装包 SHA256','APP_UPDATE_CHECKSUM_INVALID');
 return matches[0][1].toLowerCase();
}
async function fileHash(file,signal){const hash=createHash('sha256');for await(const chunk of createReadStream(file,{signal}))hash.update(chunk);return hash.digest('hex');}
async function launchInstaller(file){
 await new Promise((resolve,reject)=>{
  let child;try{child=spawn(file,[],{detached:true,stdio:'ignore',shell:false,windowsHide:false});}catch(error){reject(Object.assign(error,{outcome:'notExecuted'}));return;}
  child.once('error',error=>reject(Object.assign(error,{outcome:'notExecuted'})));
  child.once('spawn',()=>{child.unref();resolve();});
 });
}

/** Application updates only. Never installs npm packages or touches conversation/data directories. */
export class AppUpdateService{
 constructor({currentVersion,cacheRoot,platform=process.platform,arch=process.arch,fetchFn=globalThis.fetch,launchFn,updateTransport='msi',now=Date.now,checkTimeoutMs=15000,downloadTimeoutMs=15*60000}={}){
  if(!VERSION.test(currentVersion||''))throw fail('当前应用版本无效','APP_UPDATE_VERSION_INVALID');
  transport(updateTransport);
  if(launchFn!==undefined&&typeof launchFn!=='function')throw fail('Native update launcher must be a function','APP_UPDATE_LAUNCHER_INVALID');
  this.nativeLaunchAvailable=updateTransport==='msi'||typeof launchFn==='function';
  Object.assign(this,{currentVersion,platform,arch,fetchFn,launchFn:launchFn||(updateTransport==='msi'?launchInstaller:null),updateTransport,now,checkTimeoutMs,downloadTimeoutMs});
  this.cacheRoot=path.resolve(cacheRoot||path.join(platform==='win32'?(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local')):os.tmpdir(),'CodexLight','Updates'));
  this.latest=null;this.phase='idle';this.error=null;this.checkedAt=null;this.receivedBytes=0;this.totalBytes=0;this.prepared=null;this.checking=null;this.checkAbortController=null;this.downloading=null;this.installing=null;this.closed=false;this.abortController=null;
 }
 releaseExpired(){return !this.checkedAt||this.now()-Date.parse(this.checkedAt)>60*60000;}
 status(){
  const latest=this.latest?{version:this.latest.version,releaseUrl:this.latest.releaseUrl,notes:this.latest.notes,publishedAt:this.latest.publishedAt,available:this.latest.available,downloadBytes:this.latest.setup.size}:null;
  return {currentVersion:this.currentVersion,...(this.updateTransport==='velopack'?{updateTransport:this.updateTransport}:{}),supported:this.platform==='win32'&&this.arch==='x64',phase:this.phase,checkedAt:this.checkedAt,latest,requiresRecheck:!!latest?.available&&this.releaseExpired(),receivedBytes:this.receivedBytes,totalBytes:this.totalBytes,preparedVersion:this.prepared?.version||null,...(this.error?{error:this.error}:{}),releasesUrl:APP_RELEASES_URL};
 }
 async _fetch(url,signal,{api=false,range}={}){
  let target=trustedUrl(url,{api});
  const headers={
   Accept:api?'application/vnd.github+json':'application/octet-stream',
   'User-Agent':`Codex-Light/${this.currentVersion}`,
   ...(range?{Range:`bytes=${range.start}-${range.end}`,'Accept-Encoding':'identity'}:{})
  };
  for(let redirects=0;redirects<=4;redirects++){
   signal.throwIfAborted();
   const response=await this.fetchFn(target.href,{redirect:'manual',signal,headers});
   if([301,302,303,307,308].includes(response.status)){
    await response.body?.cancel?.();
    if(api)throw fail('应用更新 API 重定向被拒绝','APP_UPDATE_SOURCE_INVALID');
    const next=new URL(response.headers.get('location')||'',target);target=trustedUrl(next.href);continue;
   }
   if(!response.ok){await response.body?.cancel?.();throw fail(response.status===404?'尚未发布可用的应用版本':`应用更新请求失败（HTTP ${response.status}）`,'APP_UPDATE_HTTP_FAILED');}
   return response;
  }
  throw fail('安装包重定向次数过多','APP_UPDATE_REDIRECT_LIMIT');
 }
 async check({automatic=false}={}){
  if(this.closed)throw fail('应用更新服务已关闭','APP_UPDATE_CLOSED');
  if(this.checking)return this.checking;
  if(this.downloading||this.installing)throw fail('正在处理应用更新，请稍后检查','APP_UPDATE_BUSY');
  if(this.phase==='launchUnknown'){
   if(automatic)return this.status();
   throw fail('未收到安装程序的启动回执。如果已出现更新窗口，请在该窗口继续。','APP_UPDATE_LAUNCH_UNKNOWN','unknown');
  }
  if(this.phase==='launched')return this.status();
  if(automatic&&['available','ready','upToDate'].includes(this.phase)&&this.checkedAt&&this.now()-Date.parse(this.checkedAt)<5*60*1000)return this.status();
  const previousPhase=this.phase,previousError=this.error;
  this.phase='checking';this.error=null;
  const controller=new AbortController();this.checkAbortController=controller;
  const upstreamSignal=()=>AbortSignal.any([controller.signal,AbortSignal.timeout(this.checkTimeoutMs)]);
  this.checking=(async()=>{
   try{
    const response=await this._fetch(APP_RELEASES_API,upstreamSignal(),{api:true});
    let raw;try{raw=JSON.parse((await limitedBytes(response,2*1024*1024)).toString('utf8'));}catch(error){if(error.code)throw error;throw fail('发布信息无法解析','APP_UPDATE_RELEASE_INVALID');}
    const latest=parseAppRelease(raw,this.currentVersion,this.updateTransport);const sums=await this._fetch(latest.sums.url,upstreamSignal());
    const checksumBytes=await limitedBytes(sums,128*1024);
    if(checksumBytes.length!==latest.sums.size)throw fail('发布校验文件大小与元数据不一致','APP_UPDATE_CHECKSUM_INVALID');
    latest.sha256=publishedSetupHash(checksumBytes.toString('utf8'),latest.setup.name);
    this.latest=latest;this.checkedAt=new Date(this.now()).toISOString();
    if(this.prepared&&(this.prepared.version!==latest.version||this.prepared.sha256!==latest.sha256))this.prepared=null;
    this.phase=this.prepared?'ready':latest.available?'available':'upToDate';return this.status();
   }catch(error){
    this.phase=automatic?previousPhase:'failed';
    this.error=automatic?previousError:error?.message||'应用更新检查失败';
    throw error;
   }
   finally{this.checking=null;this.checkAbortController=null;}
  })();return this.checking;
 }
 _release(params){
  if(this.closed)throw fail('应用更新服务已关闭','APP_UPDATE_CLOSED');
  if(this.platform!=='win32'||this.arch!=='x64')throw fail('此安装包仅支持 Windows x64','APP_UPDATE_UNSUPPORTED');
  if(!this.latest?.available||params.version!==this.latest.version)throw fail('请先检查并选择当前可用的更新版本','APP_UPDATE_STALE');
  if(this.releaseExpired())throw fail('更新信息已过期，请重新检查','APP_UPDATE_STALE');
  return this.latest;
 }
 async _safeRoot(){
  let current=this.cacheRoot;
  while(true){
   try{if((await lstat(current)).isSymbolicLink())throw fail('更新缓存路径不能是链接','APP_UPDATE_PATH_INVALID');}catch(error){if(error.code!=='ENOENT')throw error;}
   const parent=path.dirname(current);if(parent===current)break;current=parent;
  }
  await mkdir(this.cacheRoot,{recursive:true});
  if((await lstat(this.cacheRoot)).isSymbolicLink())throw fail('更新缓存路径不能是链接','APP_UPDATE_PATH_INVALID');
  return realpath(this.cacheRoot);
 }
 async _writeAsset(response,write,signal,size,range){
  try{
   const contentRange=response.headers.get('content-range');
   let length=size;
   if(range){
    const match=/^bytes (\d+)-(\d+)\/(\d+)$/i.exec(contentRange||'');
    const encoding=response.headers.get('content-encoding');
    if(response.status!==206||!match||Number(match[1])!==range.start||Number(match[2])!==range.end||Number(match[3])!==size||(encoding!==null&&encoding.toLowerCase()!=='identity'))throw fail('安装包分段响应与请求范围不一致','APP_UPDATE_RANGE_INVALID');
    length=range.end-range.start+1;
   }else if(response.status!==200||contentRange!==null){
    throw fail('安装包请求未返回完整文件','APP_UPDATE_RANGE_INVALID');
   }
   const declared=response.headers.get('content-length');
   if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)!==length))throw fail('安装包大小与发布信息不一致','APP_UPDATE_SIZE_MISMATCH');
   if(!response.body)throw fail('安装包下载内容为空','APP_UPDATE_EMPTY');
   const start=range?.start??0;
   let received=0;
   for await(const chunk of response.body){
    if(received+chunk.length>length)throw fail('安装包下载超过允许大小','APP_UPDATE_TOO_LARGE');
    let offset=0;
    while(offset<chunk.length){
     const {bytesWritten}=await write(chunk,offset,start+received,signal);
     offset+=bytesWritten;
     received+=bytesWritten;
     this.receivedBytes+=bytesWritten;
    }
   }
   signal.throwIfAborted();
   if(received!==length)throw fail('安装包下载不完整','APP_UPDATE_SIZE_MISMATCH');
  }finally{
   await response.body?.cancel?.()?.catch(()=>{});
  }
 }
 async _downloadAsset({url,size},handle,signal){
  // The requests stream concurrently, but writes to their shared file handle must be serialized.
  let pendingWrite=Promise.resolve(),writeError;
  const write=(chunk,offset,position,writeSignal)=>{
   pendingWrite=pendingWrite.then(async()=>{
    writeSignal.throwIfAborted();
    try{
     const result=await handle.write(chunk,offset,chunk.length-offset,position);
     if(result.bytesWritten===0)throw fail('安装包写入失败','APP_UPDATE_WRITE_FAILED');
     return result;
    }catch(error){writeError=error;throw error;}
   });
   return pendingWrite;
  };
  if(size<MIN_PARALLEL_SIZE){
   await this._writeAsset(await this._fetch(url,signal),write,signal,size);
   return;
  }
  const ranges=Array.from({length:DOWNLOAD_SEGMENTS},(_,index)=>({
   start:Math.floor(index*size/DOWNLOAD_SEGMENTS),
   end:Math.floor((index+1)*size/DOWNLOAD_SEGMENTS)-1
  }));
  const segments=new AbortController();
  const rangeSignal=AbortSignal.any([signal,segments.signal]);
  let first,sourceError;
  try{
   first=await this._fetch(url,rangeSignal,{range:ranges[0]});
   if(first.status===206){
    await Promise.allSettled(ranges.map(async(range,index)=>{
     try{
      const response=index===0?first:await this._fetch(url,rangeSignal,{range});
      await this._writeAsset(response,write,rangeSignal,size,range);
     }catch(error){
      if(error?.code==='APP_UPDATE_SOURCE_INVALID'||error?.code==='APP_UPDATE_REDIRECT_LIMIT')sourceError=error;
      segments.abort(error);
      throw error;
     }
    }));
    rangeSignal.throwIfAborted();
    return;
   }
  }catch(error){
   signal.throwIfAborted();
   if(writeError||sourceError)throw writeError||sourceError;
   if(error?.code==='APP_UPDATE_SOURCE_INVALID'||error?.code==='APP_UPDATE_REDIRECT_LIMIT')throw error;
   // All range workers are settled. Discard their partial bytes before
   // retrying once without Range under the original deadline.
   await pendingWrite.catch(()=>{});
   signal.throwIfAborted();
   await handle.truncate(0);
   this.receivedBytes=0;
   pendingWrite=Promise.resolve();
   await this._writeAsset(await this._fetch(url,signal),write,signal,size);
   return;
  }
  // Reuse an already complete response if the server ignored the first Range.
  await this._writeAsset(first,write,signal,size);
 }
 async download(params){
  strict(params,['version']);const latest=this._release(params);
  if(this.downloading)return this.downloading;
  if(this.checking||this.installing||this.phase==='launchUnknown'||this.phase==='launched')throw fail('当前更新操作尚未结束','APP_UPDATE_BUSY');
  if(this.prepared?.version===latest.version&&this.prepared.sha256===latest.sha256){
   try{await this._verifyPrepared();this.phase='ready';this.error=null;return this.status();}catch(error){this.phase='failed';this.error=error.message;error.outcome??='failed';throw error;}
  }
  this.phase='downloading';this.error=null;this.receivedBytes=0;this.totalBytes=latest.setup.size;
  this.downloading=(async()=>{
   let partial;let handle;this.abortController=new AbortController();const timeout=setTimeout(()=>this.abortController?.abort(),this.downloadTimeoutMs);
   try{
    const root=await this._safeRoot();const directory=path.join(root,`${latest.version}-${latest.sha256.slice(0,16)}`);
    await mkdir(directory,{recursive:true});if((await lstat(directory)).isSymbolicLink())throw fail('更新缓存路径不能是链接','APP_UPDATE_PATH_INVALID');
    partial=path.join(directory,`${randomUUID()}.partial`);handle=await open(partial,'wx');
    const {signal}=this.abortController;
    await this._downloadAsset(latest.setup,handle,signal);
    if(this.receivedBytes!==latest.setup.size||(await handle.stat()).size!==latest.setup.size)throw fail('安装包下载不完整','APP_UPDATE_SIZE_MISMATCH');
    await handle.close();handle=null;
    if(await fileHash(partial,signal)!==latest.sha256)throw fail('安装包 SHA256 校验失败，已拒绝安装','APP_UPDATE_HASH_MISMATCH');
    signal.throwIfAborted();
    const file=path.join(directory,cacheName(latest.version,this.updateTransport));await rename(partial,file);partial=null;
    this.prepared={version:latest.version,sha256:latest.sha256,size:latest.setup.size,file};this.phase='ready';return this.status();
   }catch(error){
    // Staging ended before a verified package was handed off. A failed fetch or
    // file write must not leave an indeterminate installer operation in the ledger.
    const failure=error instanceof Error?error:new Error(String(error));
    this.phase='failed';this.error=failure.message||'安装包下载失败';failure.outcome??='failed';throw failure;
   }
   finally{clearTimeout(timeout);this.abortController=null;await handle?.close().catch(()=>{});if(partial)await rm(partial,{force:true}).catch(()=>{});this.downloading=null;}
  })();return this.downloading;
 }
 async _verifyPrepared(){
  const prepared=this.prepared;
  if(!prepared)throw fail('请先下载并校验安装包','APP_UPDATE_NOT_READY');
  const root=await this._safeRoot();const parent=path.dirname(prepared.file);const dirInfo=await lstat(parent);const info=await lstat(prepared.file);
  if(dirInfo.isSymbolicLink()||info.isSymbolicLink()||!info.isFile()||info.size!==prepared.size||path.dirname(parent)!==root||path.basename(prepared.file)!==cacheName(prepared.version,this.updateTransport)||await fileHash(prepared.file)!==prepared.sha256){this.prepared=null;throw fail('已下载的安装包发生变化，请重新检查并下载','APP_UPDATE_HASH_MISMATCH');}
  return prepared;
 }
 async install(params){
  strict(params,['version','confirmed']);if(params.confirmed!==true)throw fail('请确认打开应用安装程序','APP_UPDATE_CONFIRM_REQUIRED');
  this._release(params);
  if(!this.nativeLaunchAvailable)throw fail('Velopack requires the trusted native update launcher','APP_UPDATE_NATIVE_REQUIRED');
  if(this.phase==='launched')return this.status();
  if(this.phase==='launchUnknown')throw fail('未收到安装程序的启动回执。如果已出现更新窗口，请在该窗口继续。','APP_UPDATE_LAUNCH_UNKNOWN','unknown');
  if(this.installing)return this.installing;
  if(this.downloading||this.checking)throw fail('安装包尚未准备完成','APP_UPDATE_BUSY');
  this.installing=(async()=>{
   let launching=false;
   try{
    const prepared=await this._verifyPrepared();this.phase='launching';this.error=null;launching=true;
    await this.launchFn(prepared.file,{sha256:prepared.sha256,...(this.updateTransport==='velopack'?{version:prepared.version,updateTransport:this.updateTransport}:{})});this.phase='launched';return this.status();
   }catch(error){
    const failure=error instanceof Error?error:new Error(String(error));
    this.phase=launching&&failure.outcome!=='notExecuted'?'launchUnknown':'failed';this.error=failure.message||'安装程序未能启动';
    if(this.phase==='launchUnknown')failure.outcome='unknown';else if(!launching)failure.outcome='notExecuted';throw failure;
   }
   finally{this.installing=null;}
  })();return this.installing;
 }
 close(){this.closed=true;this.checkAbortController?.abort();this.abortController?.abort();return this.downloading?.catch(()=>{});}
}
