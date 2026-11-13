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
const MAX_SETUP=300*1024*1024;
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
function asset(release,name){
 const matches=Array.isArray(release.assets)?release.assets.filter(item=>item?.name===name):[];
 if(matches.length!==1)throw fail(`发布版本缺少唯一的 ${name}`,'APP_UPDATE_ASSET_MISSING');
 const item=matches[0];const url=trustedUrl(item.browser_download_url);
 const expected=`${REPO_DOWNLOAD}${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`;
 if(url.hostname!=='github.com'||url.pathname!==expected||url.search)throw fail('发布附件地址与版本不匹配','APP_UPDATE_SOURCE_INVALID');
 if(!Number.isSafeInteger(item.size)||item.size<1||item.size>(name===SETUP?MAX_SETUP:128*1024))throw fail('发布附件大小无效','APP_UPDATE_TOO_LARGE');
 return {url:url.href,size:item.size};
}
export function parseAppRelease(release,currentVersion){
 const version=typeof release?.tag_name==='string'?release.tag_name.replace(/^v/,''):'';
 if(!VERSION.test(version)||release.draft===true||release.prerelease===true)throw fail('没有可安装的稳定发布版本','APP_UPDATE_RELEASE_INVALID');
 const setup=asset(release,SETUP);const sums=asset(release,SUMS);
 if(release.html_url!==`https://github.com/k08255-lxm/codex-light/releases/tag/${encodeURIComponent(release.tag_name)}`)throw fail('发布页面来源无效','APP_UPDATE_SOURCE_INVALID');
 return {version,tag:release.tag_name,releaseUrl:release.html_url,notes:typeof release.body==='string'?release.body.slice(0,12000):'',publishedAt:typeof release.published_at==='string'?release.published_at:null,available:compareVersions(currentVersion,version)<0,setup,sums};
}
export function publishedSetupHash(text){
 const matches=String(text).replace(/^\uFEFF/,'').split(/\r?\n/).map(line=>/^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line)).filter(match=>match&&match[2]===SETUP);
 if(matches.length!==1)throw fail('发布校验文件缺少唯一的安装包 SHA256','APP_UPDATE_CHECKSUM_INVALID');
 return matches[0][1].toLowerCase();
}
async function fileHash(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function launchInstaller(file){
 await new Promise((resolve,reject)=>{
  let child;try{child=spawn(file,[],{detached:true,stdio:'ignore',shell:false,windowsHide:false});}catch(error){reject(Object.assign(error,{outcome:'notExecuted'}));return;}
  child.once('error',error=>reject(Object.assign(error,{outcome:'notExecuted'})));
  child.once('spawn',()=>{child.unref();resolve();});
 });
}

/** Application updates only. Never installs npm packages or touches conversation/data directories. */
export class AppUpdateService{
 constructor({currentVersion,cacheRoot,platform=process.platform,arch=process.arch,fetchFn=globalThis.fetch,launchFn=launchInstaller,now=Date.now,checkTimeoutMs=15000,downloadTimeoutMs=15*60000}={}){
  if(!VERSION.test(currentVersion||''))throw fail('当前应用版本无效','APP_UPDATE_VERSION_INVALID');
  Object.assign(this,{currentVersion,platform,arch,fetchFn,launchFn,now,checkTimeoutMs,downloadTimeoutMs});
  this.cacheRoot=path.resolve(cacheRoot||path.join(platform==='win32'?(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local')):os.tmpdir(),'CodexLight','Updates'));
  this.latest=null;this.phase='idle';this.error=null;this.checkedAt=null;this.receivedBytes=0;this.totalBytes=0;this.prepared=null;this.checking=null;this.downloading=null;this.installing=null;this.closed=false;this.abortController=null;
 }
 status(){
  const latest=this.latest?{version:this.latest.version,releaseUrl:this.latest.releaseUrl,notes:this.latest.notes,publishedAt:this.latest.publishedAt,available:this.latest.available}:null;
  return {currentVersion:this.currentVersion,supported:this.platform==='win32'&&this.arch==='x64',phase:this.phase,checkedAt:this.checkedAt,latest,receivedBytes:this.receivedBytes,totalBytes:this.totalBytes,preparedVersion:this.prepared?.version||null,...(this.error?{error:this.error}:{}),releasesUrl:APP_RELEASES_URL};
 }
 async _fetch(url,signal,{api=false}={}){
  let target=trustedUrl(url,{api});
  for(let redirects=0;redirects<=4;redirects++){
   const response=await this.fetchFn(target.href,{redirect:'manual',signal,headers:{Accept:api?'application/vnd.github+json':'application/octet-stream','User-Agent':`Codex-Light/${this.currentVersion}`}});
   if([301,302,303,307,308].includes(response.status)){
    if(api)throw fail('应用更新 API 重定向被拒绝','APP_UPDATE_SOURCE_INVALID');
    const next=new URL(response.headers.get('location')||'',target);target=trustedUrl(next.href);await response.body?.cancel?.();continue;
   }
   if(!response.ok){await response.body?.cancel?.();throw fail(response.status===404?'尚未发布可用的应用版本':`应用更新请求失败（HTTP ${response.status}）`,'APP_UPDATE_HTTP_FAILED');}
   return response;
  }
  throw fail('安装包重定向次数过多','APP_UPDATE_REDIRECT_LIMIT');
 }
 async check(){
  if(this.closed)throw fail('应用更新服务已关闭','APP_UPDATE_CLOSED');
  if(this.checking)return this.checking;
  if(this.downloading||this.installing)throw fail('正在处理应用更新，请稍后检查','APP_UPDATE_BUSY');
  if(this.phase==='launchUnknown')throw fail('安装程序启动结果未知，请先核对，不能自动重试','APP_UPDATE_LAUNCH_UNKNOWN','unknown');
  if(this.phase==='launched')return this.status();
  this.phase='checking';this.error=null;
  this.checking=(async()=>{
   try{
    const response=await this._fetch(APP_RELEASES_API,AbortSignal.timeout(this.checkTimeoutMs),{api:true});
    let raw;try{raw=JSON.parse((await limitedBytes(response,2*1024*1024)).toString('utf8'));}catch(error){if(error.code)throw error;throw fail('发布信息无法解析','APP_UPDATE_RELEASE_INVALID');}
    const latest=parseAppRelease(raw,this.currentVersion);const sums=await this._fetch(latest.sums.url,AbortSignal.timeout(this.checkTimeoutMs));
    const checksumBytes=await limitedBytes(sums,128*1024);
    if(checksumBytes.length!==latest.sums.size)throw fail('发布校验文件大小与元数据不一致','APP_UPDATE_CHECKSUM_INVALID');
    latest.sha256=publishedSetupHash(checksumBytes.toString('utf8'));
    this.latest=latest;this.checkedAt=new Date(this.now()).toISOString();
    if(this.prepared&&(this.prepared.version!==latest.version||this.prepared.sha256!==latest.sha256))this.prepared=null;
    this.phase=this.prepared?'ready':latest.available?'available':'upToDate';return this.status();
   }catch(error){this.phase='failed';this.error=error?.message||'应用更新检查失败';throw error;}
   finally{this.checking=null;}
  })();return this.checking;
 }
 _release(params){
  if(this.closed)throw fail('应用更新服务已关闭','APP_UPDATE_CLOSED');
  if(this.platform!=='win32'||this.arch!=='x64')throw fail('此安装包仅支持 Windows x64','APP_UPDATE_UNSUPPORTED');
  if(!this.latest?.available||params.version!==this.latest.version)throw fail('请先检查并选择当前可用的更新版本','APP_UPDATE_STALE');
  if(!this.checkedAt||this.now()-Date.parse(this.checkedAt)>60*60000)throw fail('更新信息已过期，请重新检查','APP_UPDATE_STALE');
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
 async download(params){
  strict(params,['version']);const latest=this._release(params);
  if(this.downloading)return this.downloading;
  if(this.checking||this.installing||this.phase==='launchUnknown'||this.phase==='launched')throw fail('当前更新操作尚未结束','APP_UPDATE_BUSY');
  if(this.prepared?.version===latest.version&&this.prepared.sha256===latest.sha256){
   try{await this._verifyPrepared();this.phase='ready';this.error=null;return this.status();}catch(error){this.phase='failed';this.error=error.message;throw error;}
  }
  this.phase='downloading';this.error=null;this.receivedBytes=0;this.totalBytes=latest.setup.size;
  this.downloading=(async()=>{
   let partial;let handle;this.abortController=new AbortController();const timeout=setTimeout(()=>this.abortController?.abort(),this.downloadTimeoutMs);
   try{
    const root=await this._safeRoot();const directory=path.join(root,`${latest.version}-${latest.sha256.slice(0,16)}`);
    await mkdir(directory,{recursive:true});if((await lstat(directory)).isSymbolicLink())throw fail('更新缓存路径不能是链接','APP_UPDATE_PATH_INVALID');
    partial=path.join(directory,`${randomUUID()}.partial`);handle=await open(partial,'wx');
    const response=await this._fetch(latest.setup.url,this.abortController.signal);
    const declared=response.headers.get('content-length');if(declared!==null&&Number(declared)!==latest.setup.size)throw fail('安装包大小与发布信息不一致','APP_UPDATE_SIZE_MISMATCH');
    if(!response.body)throw fail('安装包下载内容为空','APP_UPDATE_EMPTY');
    const hash=createHash('sha256');
    for await(const chunk of response.body){this.receivedBytes+=chunk.length;if(this.receivedBytes>latest.setup.size||this.receivedBytes>MAX_SETUP)throw fail('安装包下载超过允许大小','APP_UPDATE_TOO_LARGE');hash.update(chunk);await handle.writeFile(chunk);}
    await handle.close();handle=null;
    if(this.receivedBytes!==latest.setup.size)throw fail('安装包下载不完整','APP_UPDATE_SIZE_MISMATCH');
    if(hash.digest('hex')!==latest.sha256)throw fail('安装包 SHA256 校验失败，已拒绝安装','APP_UPDATE_HASH_MISMATCH');
    const file=path.join(directory,SETUP);await rename(partial,file);partial=null;
    this.prepared={version:latest.version,sha256:latest.sha256,size:latest.setup.size,file};this.phase='ready';return this.status();
   }catch(error){this.phase='failed';this.error=error?.message||'安装包下载失败';throw error;}
   finally{clearTimeout(timeout);this.abortController=null;await handle?.close().catch(()=>{});if(partial)await rm(partial,{force:true}).catch(()=>{});this.downloading=null;}
  })();return this.downloading;
 }
 async _verifyPrepared(){
  const prepared=this.prepared;
  if(!prepared)throw fail('请先下载并校验安装包','APP_UPDATE_NOT_READY');
  const root=await this._safeRoot();const parent=path.dirname(prepared.file);const dirInfo=await lstat(parent);const info=await lstat(prepared.file);
  if(dirInfo.isSymbolicLink()||info.isSymbolicLink()||!info.isFile()||info.size!==prepared.size||path.dirname(parent)!==root||path.basename(prepared.file)!==SETUP||await fileHash(prepared.file)!==prepared.sha256){this.prepared=null;throw fail('已下载的安装包发生变化，请重新检查并下载','APP_UPDATE_HASH_MISMATCH');}
  return prepared;
 }
 async install(params){
  strict(params,['version','confirmed']);if(params.confirmed!==true)throw fail('请确认打开应用安装程序','APP_UPDATE_CONFIRM_REQUIRED');
  this._release(params);
  if(this.phase==='launched')return this.status();
  if(this.phase==='launchUnknown')throw fail('安装程序启动结果未知，请人工核对；不会再次启动','APP_UPDATE_LAUNCH_UNKNOWN','unknown');
  if(this.installing)return this.installing;
  if(this.downloading||this.checking)throw fail('安装包尚未准备完成','APP_UPDATE_BUSY');
  this.installing=(async()=>{
   let launching=false;
   try{
    const prepared=await this._verifyPrepared();this.phase='launching';this.error=null;launching=true;
    await this.launchFn(prepared.file,{sha256:prepared.sha256});this.phase='launched';return this.status();
   }catch(error){
    const failure=error instanceof Error?error:new Error(String(error));
    this.phase=launching&&failure.outcome!=='notExecuted'?'launchUnknown':'failed';this.error=failure.message||'安装程序未能启动';
    if(this.phase==='launchUnknown')failure.outcome='unknown';else if(!launching)failure.outcome='notExecuted';throw failure;
   }
   finally{this.installing=null;}
  })();return this.installing;
 }
 close(){this.closed=true;this.abortController?.abort();return this.downloading?.catch(()=>{});}
}
