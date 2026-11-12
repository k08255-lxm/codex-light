import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {cp,lstat,mkdtemp,readFile,readdir,realpath,rename,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {compareVersions} from './update-manifest.mjs';
import {discoverRuntimeCandidates,findNativeCodexInPackage,parseCodexVersion,probeCodexVersion} from './runtime-path.mjs';

const REGISTRY_URL='https://registry.npmjs.org/@openai%2Fcodex/latest';
const STABLE_VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CHECK_TTL=20*60*1000;
const STATUS_CACHE=10*1000;
const CHECK_TIMEOUT=10*1000;
const CHECK_MAX=256*1024;
const STAGE_TIMEOUT=30*60*1000;
const STAGE_MAX=512*1024;
const CANCEL_GRACE=2*1000;
const FILE_SYSTEM={cp,lstat,mkdtemp,readFile,readdir,realpath,rename,rm};

const fail=(message,code,outcome='notExecuted')=>Object.assign(new Error(message),{code,outcome});
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const stableVersion=value=>typeof value==='string'&&value.length<=256&&STABLE_VERSION.test(value);
function strictKeys(input,allowed){
 if(!plain(input))throw fail('运行引擎参数无效','RUNTIME_INPUT_INVALID');
 for(const key of Object.keys(input))if(!allowed.includes(key))throw fail(`不支持参数 ${key}`,'RUNTIME_INPUT_INVALID');
}
const emptyCandidate=()=>({available:false,path:null,version:null});

async function limitedText(response,max){
 const declared=Number(response?.headers?.get?.('content-length'));
 if(Number.isFinite(declared)&&declared>max)throw fail('更新信息响应过大','RUNTIME_CHECK_TOO_LARGE');
 if(response?.body?.getReader){
  const reader=response.body.getReader();const chunks=[];let bytes=0;
  while(true){
   const {done,value}=await reader.read();
   if(done)break;
   bytes+=value.byteLength;
   if(bytes>max){try{await reader.cancel();}catch{}throw fail('更新信息响应过大','RUNTIME_CHECK_TOO_LARGE');}
   chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
 }
 const text=await response.text();
 if(Buffer.byteLength(text,'utf8')>max)throw fail('更新信息响应过大','RUNTIME_CHECK_TOO_LARGE');
 return text;
}

export class RuntimeManager {
 constructor({currentPath='',currentSource=null,platform=process.platform,arch=process.arch,env=process.env,home=os.homedir(),exists=existsSync,discoverDesktop,versionOf,probeVersion,spawnSyncFn,npmCliPath,packageRoot,node=process.execPath,spawnFn,spawn:spawnOption,fetchFn,fetch:fetchOption,fs:fsOptions,operations,rpc,now=Date.now,statusCacheMs=STATUS_CACHE,checkTtlMs=CHECK_TTL,checkTimeoutMs=CHECK_TIMEOUT,maxCheckBytes=CHECK_MAX,stageTimeoutMs,upgradeTimeoutMs,maxStageBytes,maxUpgradeBytes}={}){
  Object.assign(this,{currentPath,currentSource,platform,arch,env,home,exists,discoverDesktop,versionOf,probeVersion,npmCliPath,packageRoot,node,spawnFn:spawnFn||spawnOption||spawn,fetchFn:fetchFn||fetchOption||globalThis.fetch,operations,rpc,now,statusCacheMs,checkTtlMs,checkTimeoutMs,maxCheckBytes,spawnSyncFn});
  this.stageTimeoutMs=stageTimeoutMs??upgradeTimeoutMs??STAGE_TIMEOUT;
  this.maxStageBytes=maxStageBytes??maxUpgradeBytes??STAGE_MAX;
  this.fs={...FILE_SYSTEM,...(fsOptions||{})};
  this.paths=platform==='win32'?path.win32:path.posix;
  this.latest=null;this.upgrading=false;this.closed=false;this._cache=null;this._checking=null;this.activeTurns=new Set();
  this.activeChild=null;this.activeTimer=null;this.forceTimer=null;this.cancelTimer=null;this.activeCancel=null;this.lastDiagnostics=[];this._currentProbe=null;
  this.upgradePromise=null;this.phase=null;this.cancelStage=false;this.swapStarted=false;this.stageRoot=null;this.origParent=null;this.ownPaths=new Set();this.upgradeDiagnostics=[];
  this._onEvent=message=>this._observe(message);
  this.rpc?.on?.('event',this._onEvent);
 }
 _observe(message){
  if(message?.method==='turn/started'){
   const id=message.params?.turn?.id||message.params?.turnId;
   if(typeof id==='string'&&id)this.activeTurns.add(id);
  }else if(['turn/completed','turn/interrupted'].includes(message?.method)){
   const id=message.params?.turn?.id||message.params?.turnId;
   if(typeof id==='string')this.activeTurns.delete(id);
  }
  if(message?.method==='bridge/status'&&message.params?.connected===false)this.activeTurns.clear();
  if(['account/updated','account/login/completed'].includes(message?.method))this.activeTurns.clear();
 }
 _probe(executable){
  try{
   const raw=this.versionOf?this.versionOf(executable):(this.probeVersion||probeCodexVersion)(executable);
   return parseCodexVersion(typeof raw==='string'?raw:'');
  }catch{return null;}
 }
 _samePath(a,b){
  if(!a||!b)return false;
  try{return this.paths.normalize(a).toLowerCase()===this.paths.normalize(b).toLowerCase();}catch{return false;}
 }
 _inside(root,candidate,{equal=false}={}){
  try{
   const relative=this.paths.relative(this.paths.resolve(root),this.paths.resolve(candidate));
   if(relative==='')return equal;
   return !relative.startsWith('..')&&!this.paths.isAbsolute(relative);
  }catch{return false;}
 }
 _insideCwd(candidate){
  try{
   const relative=this.paths.relative(this.paths.resolve(process.cwd()),this.paths.resolve(candidate));
   return relative===''||(!relative.startsWith('..')&&!this.paths.isAbsolute(relative));
  }catch{return true;}
 }
 _packageRootValue(){
  if(this.packageRoot){
   if(typeof this.packageRoot!=='string'||!this.paths.isAbsolute(this.packageRoot)||/[\x00-\x1f\x7f]/.test(this.packageRoot))return null;
   return this.paths.normalize(this.packageRoot);
  }
  if(!this.env.APPDATA||!this.paths.isAbsolute(this.env.APPDATA))return null;
  return this.paths.join(this.env.APPDATA,'npm','node_modules','@openai','codex');
 }
 _npmCli(){
  try{
   if(this.npmCliPath){
    const candidate=this.npmCliPath;
    if(this._insideCwd(candidate)||!this.paths.isAbsolute(candidate)||this.paths.basename(candidate)!=='npm-cli.js'||!/node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/i.test(candidate)||!this.exists(candidate))return null;
    return candidate;
   }
   const candidates=[this.paths.join(this.paths.dirname(this.node),'node_modules','npm','bin','npm-cli.js')];
   if(this.platform==='win32'&&this.env.APPDATA)candidates.push(this.paths.join(this.env.APPDATA,'npm','node_modules','npm','bin','npm-cli.js'));
   for(const candidate of candidates){
    if(this.paths.isAbsolute(candidate)&&this.paths.basename(candidate)==='npm-cli.js'&&/node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/i.test(candidate)&&this.exists(candidate))return candidate;
   }
   return null;
  }catch{return null;}
 }
 async _discovery(force=false){
  if(!force&&this._cache&&this.now()-this._cache.at<this.statusCacheMs)return this._cache.value;
  let value;
  try{
   value=discoverRuntimeCandidates({platform:this.platform,arch:this.arch,env:this.env,home:this.home,exists:this.exists,discoverDesktop:this.discoverDesktop,versionOf:this.versionOf||this.probeVersion,spawnSyncFn:this.spawnSyncFn,npmPackageRoot:this.packageRoot});
  }catch(error){
   value={npm:emptyCandidate(),desktop:emptyCandidate(),diagnostics:[error?.message||'运行引擎探测失败']};
  }
  this._cache={at:this.now(),value};
  return value;
 }
 _latestView(){
  if(!this.latest)return null;
  const age=this.now()-Date.parse(this.latest.checkedAt);
  const view={version:this.latest.version,checkedAt:this.latest.checkedAt};
  if(this.latest.stale||!(age>=0)||age>this.checkTtlMs)view.stale=true;
  return view;
 }
 _latestFresh(latest=this.latest){
  if(!latest||latest.stale||!stableVersion(latest.version))return false;
  const age=this.now()-Date.parse(latest.checkedAt);
  return Number.isFinite(age)&&age>=0&&age<=this.checkTtlMs;
 }
 busy({requestId}={}){
  if(this.activeTurns.size>0)return true;
  if((this.rpc?.requests?.size||0)>0)return true;
  if(this.operations?.entries){for(const [id,entry] of this.operations.entries)if(id!==requestId&&entry?.state==='pending')return true;}
  return false;
 }
 async status(){
  const discovery=await this._discovery();
  const diagnostics=[...discovery.diagnostics,...this.upgradeDiagnostics];
  const npm={...discovery.npm};const desktop={...discovery.desktop};
  let currentVersion=null;
  if(this._samePath(this.currentPath,npm.path))currentVersion=npm.version;
  else if(this._samePath(this.currentPath,desktop.path))currentVersion=desktop.version;
  else if(this.currentPath){
   if(this._currentProbe?.path===this.currentPath&&this.now()-this._currentProbe.at<this.statusCacheMs)currentVersion=this._currentProbe.version;
   else{currentVersion=this._probe(this.currentPath);this._currentProbe={at:this.now(),path:this.currentPath,version:currentVersion};}
  }
  if(this.currentPath&&!currentVersion)diagnostics.push('无法读取当前运行引擎版本');
  const current={source:this.currentSource||(this._samePath(this.currentPath,npm.path)?'npm':this._samePath(this.currentPath,desktop.path)?'desktop':'configured'),path:this.currentPath||null,version:currentVersion};
  const latest=this._latestView();
  const inUse=this.platform==='win32'&&this._samePath(this.currentPath,npm.path);
  const packageRoot=this._packageRootValue();
  const npmInsideRoot=!!(packageRoot&&npm.path&&this._inside(packageRoot,npm.path));
  let blockedReason=null;
  if(this.upgrading)blockedReason='正在升级 npm CLI，请等待完成';
  else if(this.busy())blockedReason='有运行中的任务、待处理审批或未完成操作，暂不能升级';
  else if(this.platform!=='win32')blockedReason='当前平台暂不支持 npm CLI 事务升级';
  else if(inUse)blockedReason='当前正在使用 npm 安装的 Codex CLI，不能就地替换；请关闭当前引擎，或改从桌面内置引擎启动后再升级';
  else if(!latest)blockedReason='请先检查更新';
  else if(latest.stale||!this._latestFresh())blockedReason='检查结果已过期，请重新检查';
  else if(!npm.available)blockedReason='未发现 npm 安装的 Codex CLI';
  else if(!npm.version)blockedReason='无法读取 npm CLI 版本';
  else if(!packageRoot)blockedReason='未发现可信的 npm 安装根目录';
  else if(!npmInsideRoot)blockedReason='npm CLI 不在可信安装目录内';
  else if(!stableVersion(latest.version))blockedReason='最近检查结果不是稳定版本，请重新检查';
  else if(compareVersions(npm.version,latest.version)>0)blockedReason='最近检查结果低于已安装的 npm CLI，请重新检查';
  else if(compareVersions(npm.version,latest.version)===0)blockedReason=null;
  else if(!this._npmCli())blockedReason='未找到可信的 npm-cli.js，暂不能升级';
  this.lastDiagnostics=diagnostics;
  const result={current,npm,desktop,latest,canUpgrade:blockedReason===null&&!!latest&&compareVersions(npm.version,latest.version)<0,blockedReason,upgrading:this.upgrading};
  if(diagnostics.length)result.diagnostics=diagnostics;
  return result;
 }
 async check(){
  if(this.closed)throw fail('运行引擎服务已关闭','RUNTIME_CLOSED');
  if(this._checking)return this._checking;
  const controller=new AbortController();
  this.checkController=controller;
  const timer=setTimeout(()=>controller.abort(),this.checkTimeoutMs);
  this._checking=(async()=>{
   try{
    const response=await this.fetchFn(REGISTRY_URL,{redirect:'error',signal:controller.signal});
    if(response?.ok===false||(Number.isFinite(response?.status)&&(response.status<200||response.status>=300)))throw fail('无法读取 npm 最新版本','RUNTIME_CHECK_FAILED');
    const text=await limitedText(response,this.maxCheckBytes);
    let payload;
    try{payload=JSON.parse(text);}catch{throw fail('npm 最新版本响应格式无效','RUNTIME_CHECK_INVALID');}
    if(!stableVersion(payload?.version))throw fail('npm 最新版本不是有效的稳定 SemVer','RUNTIME_CHECK_INVALID');
    this.latest={version:payload.version,checkedAt:new Date(this.now()).toISOString()};
    return this.status();
   }catch(error){
    const wrapped=fail(error?.message||'检查更新失败','RUNTIME_CHECK_FAILED');
    if(this.latest)this.latest={...this.latest,stale:true};
    throw wrapped;
   }finally{
    clearTimeout(timer);
    if(this.checkController===controller)this.checkController=null;
    this._checking=null;
   }
  })();
  return this._checking;
 }
 async upgrade(input,{requestId}={}){
  strictKeys(input,['version','confirmed']);
  if(!stableVersion(input.version))throw fail('升级版本必须是合法的稳定 SemVer','RUNTIME_VERSION_INVALID');
  if(input.confirmed!==true)throw fail('升级需要明确确认','RUNTIME_CONFIRM_REQUIRED');
  if(this.closed)throw fail('运行引擎服务已关闭','RUNTIME_CLOSED');
  if(this.upgrading)throw fail('已有升级正在进行','RUNTIME_UPGRADING');
  if(this.busy({requestId}))throw fail('有运行中的任务、待处理审批或未完成操作，暂不能升级','RUNTIME_BUSY');
  if(!this._latestFresh())throw fail('请先检查更新，且检查结果需在 20 分钟内','RUNTIME_CHECK_STALE');
  if(input.version!==this.latest.version)throw fail('只能升级到最近一次检查到的稳定版本','RUNTIME_VERSION_STALE');
  if(this.platform!=='win32')throw fail('当前平台暂不支持 npm CLI 事务升级','RUNTIME_PLATFORM_UNSUPPORTED');
  this.upgrading=true;this.cancelStage=false;this.swapStarted=false;this.phase='prepare';this.upgradeDiagnostics=[];
  let run;
  run=(async()=>{
   try{return await this._upgradeTransaction(input.version);}
   catch(error){
    if(!error?.outcome)error.outcome=this.swapStarted?'unknown':'notExecuted';
    throw error;
   }finally{
    this.upgrading=false;this.phase='done';this.upgradePromise=null;this._cache=null;this._currentProbe=null;
   }
  })();
  this.upgradePromise=run;
  return run;
 }
 async _upgradeTransaction(version){
  const discovery=await this._discovery(true);
  if(this.closed||this.cancelStage)throw fail('暂存安装已取消，现有版本未更改','RUNTIME_STAGE_CANCELLED');
  const npm={...discovery.npm};
  if(!npm.available||!npm.path)throw fail('未发现 npm 安装的 Codex CLI','RUNTIME_NPM_MISSING');
  if(!npm.version)throw fail('无法读取已安装 npm CLI 版本','RUNTIME_NPM_VERSION_UNKNOWN');
  if(compareVersions(npm.version,version)>=0)throw fail('目标版本必须高于已安装的 npm CLI 版本','RUNTIME_VERSION_NOT_NEWER');
  if(this._samePath(this.currentPath,npm.path))throw fail('当前正在使用 npm 安装的 Codex CLI，不能就地替换；请关闭当前引擎，或改从桌面内置引擎启动后再升级','RUNTIME_IN_USE');
  const npmCli=this._npmCli();
  if(!npmCli)throw fail('未找到可信的 npm-cli.js，暂不能升级','RUNTIME_NPM_CLI_MISSING');
  const installed=await this._validateInstalledPackage(npm.path,npm.version);
  this.origParent=installed.origParent;
  let stageRoot;
  try{stageRoot=await this.fs.mkdtemp(path.join(os.tmpdir(),'codex-light-runtime-'));}
  catch{throw fail('暂存安装失败，现有版本未更改：无法创建私有暂存目录','RUNTIME_STAGE_FAILED');}
  this.stageRoot=stageRoot;this._track(stageRoot);
  let preserveStage=false;
  try{
   if(this.closed||this.cancelStage)throw fail('暂存安装已取消，现有版本未更改','RUNTIME_STAGE_CANCELLED');
   await this._stageInstall({stageRoot,npmCli,version});
   if(this.closed||this.cancelStage)throw fail('暂存安装已取消，现有版本未更改','RUNTIME_STAGE_CANCELLED');
   this.phase='verify';
   const stagedRoot=this.paths.join(stageRoot,'node_modules','@openai','codex');
   await this._validatePackage(stagedRoot,version,'暂存包验证失败');
   this.phase='copy';
   const sibling=this._track(this._randomSibling(installed.origParent,'.codex-light-stage-'));
   try{
    await this.fs.cp(stagedRoot,sibling,{recursive:true,dereference:false,force:false,errorOnExist:true,preserveTimestamps:true});
   }catch(error){
    await this._removeOwn(sibling);
    throw fail(`暂存包复制失败，现有版本未更改：${error?.message||'复制失败'}`,'RUNTIME_COPY_FAILED');
   }
   try{await this._validatePackage(sibling,version,'暂存包复制验证失败');}
   catch(error){await this._removeOwn(sibling);throw error;}
   this.phase='swap';this.swapStarted=true;
   return await this._swapTransaction({packageRoot:installed.packageRoot,origParent:installed.origParent,stagedSibling:sibling,oldVersion:installed.version,targetVersion:version,npmPath:npm.path});
  }catch(error){
   if(error?.preserveStage)preserveStage=true;
   throw error;
  }finally{
   if(preserveStage){
    this.upgradeDiagnostics.push(`暂存子进程未确认退出，暂存目录保留在 ${stageRoot}`);
    if(this.stageRoot===stageRoot)this.stageRoot=null;
   }else{
    await this._removeOwn(stageRoot);
    if(this.stageRoot===stageRoot)this.stageRoot=null;
   }
  }
 }
 async _stageInstall({stageRoot,npmCli,version}){
  this.phase='stage';
  if(this.closed||this.cancelStage)throw fail('暂存安装已取消，现有版本未更改','RUNTIME_STAGE_CANCELLED');
  const args=[npmCli,'install','--global','--prefix',stageRoot,'--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org',`@openai/codex@${version}`];
  try{await this._runNpm(stageRoot,args);}
  catch(error){
   const wrapped=fail(`暂存安装失败，现有版本未更改：${error?.message||'npm 安装失败'}`,error?.code||'RUNTIME_STAGE_FAILED');
   if(error?.preserveStage)wrapped.preserveStage=true;
   if(error?.childUnconfirmed)wrapped.childUnconfirmed=true;
   throw wrapped;
  }
 }
 _runNpm(cwd,args){
  return new Promise((resolve,reject)=>{
   let child;
   try{child=this.spawnFn(this.node,args,{cwd,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}
   catch{reject(fail('无法启动 npm 暂存安装','RUNTIME_STAGE_SPAWN_FAILED'));return;}
   if(!child||typeof child.once!=='function'){reject(fail('无法启动 npm 暂存安装','RUNTIME_STAGE_SPAWN_FAILED'));return;}
   this.activeChild=child;
   let settled=false,childClosed=false,bytes=0,overflow=false,timedOut=false,errorEvent=null;
   const cleanup=()=>{
    if(this.activeTimer)clearTimeout(this.activeTimer);this.activeTimer=null;
    if(this.forceTimer)clearTimeout(this.forceTimer);this.forceTimer=null;
    if(this.cancelTimer)clearTimeout(this.cancelTimer);this.cancelTimer=null;
    if(this.activeChild===child)this.activeChild=null;
    if(this.activeCancel===cancel)this.activeCancel=null;
   };
   const finish=(code,{forced=false}={})=>{
    if(settled)return;
    settled=true;cleanup();
    const unconfirmed=!childClosed;
    if(forced&&unconfirmed){
     const error=this.cancelStage
      ?fail('npm 暂存安装已取消，子进程未确认退出；暂存目录已保留供诊断','RUNTIME_STAGE_CANCELLED')
      :fail('npm 暂存安装超时，子进程未确认退出；暂存目录已保留供诊断','RUNTIME_STAGE_TIMEOUT');
     error.preserveStage=true;error.childUnconfirmed=true;reject(error);return;
    }
    if(this.cancelStage)reject(fail('npm 暂存安装已取消','RUNTIME_STAGE_CANCELLED'));
    else if(errorEvent)reject(fail('无法启动 npm 暂存安装','RUNTIME_STAGE_SPAWN_FAILED'));
    else if(timedOut)reject(fail('npm 暂存安装超时','RUNTIME_STAGE_TIMEOUT'));
    else if(overflow)reject(fail('npm 暂存安装输出超过上限','RUNTIME_STAGE_OUTPUT_LIMIT'));
    else if(code!==0)reject(fail(`npm 暂存安装失败（退出码 ${code ?? 'unknown'}）`,'RUNTIME_STAGE_FAILED'));
    else resolve();
   };
   const cancel=()=>{
    if(settled)return;
    this.cancelStage=true;
    try{child.kill();}catch{}
    if(this.cancelTimer)clearTimeout(this.cancelTimer);
    this.cancelTimer=setTimeout(()=>finish(null,{forced:true}),CANCEL_GRACE);
   };
   this.activeCancel=cancel;
   const onData=chunk=>{
    if(settled)return;
    bytes+=Buffer.byteLength(chunk);
    if(bytes>this.maxStageBytes&&!overflow){overflow=true;try{child.kill();}catch{}}
   };
   child.stdout?.on?.('data',onData);
   child.stderr?.on?.('data',onData);
   child.once('error',error=>{errorEvent=error;finish(null);});
   child.once('close',code=>{childClosed=true;finish(code);});
   child.once('exit',code=>{childClosed=true;finish(code);});
   this.activeTimer=setTimeout(()=>{if(settled)return;timedOut=true;try{child.kill();}catch{finish(null);return;}this.forceTimer=setTimeout(()=>finish(null,{forced:true}),1000);},this.stageTimeoutMs);
  });
 }
 async _validateInstalledPackage(npmPath,npmVersion){
  const packageRoot=this._packageRootValue();
  if(!packageRoot)throw fail('未发现可信的 npm 安装根目录','RUNTIME_PACKAGE_ROOT_MISSING');
  if(!this._inside(packageRoot,npmPath))throw fail('npm CLI 不在可信安装目录内','RUNTIME_PACKAGE_ROOT_INVALID');
  await this._assertRealDirectory(packageRoot,'npm Codex 安装目录');
  const exeInfo=await this._lstat(npmPath,'现有 npm CLI 可执行文件');
  if(!exeInfo.isFile()||exeInfo.isSymbolicLink())throw fail('现有 npm CLI 可执行文件不是普通文件','RUNTIME_PACKAGE_INVALID');
  const packageJson=await this._readPackage(packageRoot,npmVersion);
  if(this._probe(npmPath)!==packageJson.version)throw fail('现有 npm CLI 版本探测与 package.json 不一致','RUNTIME_PACKAGE_INVALID');
  const origParent=this.paths.dirname(packageRoot);
  await this._assertRealDirectory(origParent,'@openai 安装父目录');
  return {packageRoot,origParent,version:packageJson.version};
 }
 async _validatePackage(packageRoot,version,prefix){
  try{
   const packageJson=await this._readPackage(packageRoot,version);
   await this._assertNoLinks(packageRoot);
   const executable=findNativeCodexInPackage(packageRoot,{platform:this.platform,arch:this.arch,exists:this.exists,paths:this.paths});
   if(!executable)throw fail('缺少受平台/架构约束的原生 codex.exe','RUNTIME_PACKAGE_INVALID');
   const info=await this._lstat(executable,'暂存 codex.exe');
   if(!info.isFile()||info.isSymbolicLink())throw fail('codex.exe 不是普通文件','RUNTIME_PACKAGE_INVALID');
   if(this._probe(executable)!==packageJson.version)throw fail('codex.exe 版本与 package.json 不一致','RUNTIME_PACKAGE_INVALID');
   return executable;
  }catch(error){
   if(error?.code==='RUNTIME_PACKAGE_INVALID')throw fail(`${prefix}，现有版本未更改：${error.message}`,'RUNTIME_PACKAGE_INVALID');
   throw fail(`${prefix}，现有版本未更改：${error?.message||'包验证失败'}`,'RUNTIME_STAGE_VERIFY_FAILED');
  }
 }
 async _assertRealDirectory(target,label){
  const info=await this._lstat(target,label);
  if(!info.isDirectory()||info.isSymbolicLink())throw fail(`${label}不是真实目录（不接受 symlink/reparse）`,'RUNTIME_PACKAGE_INVALID');
  const resolved=await this.fs.realpath(target);
  if(!this._samePath(resolved,target))throw fail(`${label}的真实路径与给定路径不一致`,'RUNTIME_PACKAGE_INVALID');
  return info;
 }
 async _lstat(target,label){
  try{return await this.fs.lstat(target);}catch{throw fail(`${label}不存在或无法读取`,'RUNTIME_PACKAGE_INVALID');}
 }
 async _readPackage(packageRoot,expectedVersion){
  let info;
  try{info=await this.fs.lstat(this.paths.join(packageRoot,'package.json'));}catch{throw fail('缺少 package.json','RUNTIME_PACKAGE_INVALID');}
  if(!info.isFile()||info.isSymbolicLink())throw fail('package.json 不是普通文件','RUNTIME_PACKAGE_INVALID');
  let data;
  try{data=JSON.parse(await this.fs.readFile(this.paths.join(packageRoot,'package.json'),'utf8'));}catch{throw fail('package.json 无法解析','RUNTIME_PACKAGE_INVALID');}
  if(data?.name!=='@openai/codex')throw fail('package.json name 不是 @openai/codex','RUNTIME_PACKAGE_INVALID');
  if(expectedVersion!==undefined&&data.version!==expectedVersion)throw fail('package.json version 与目标版本不一致','RUNTIME_PACKAGE_INVALID');
  return data;
 }
 async _assertNoLinks(root){
  const walk=async target=>{
   const info=await this.fs.lstat(target);
   if(info.isSymbolicLink())throw fail('包内包含 symlink/reparse，拒绝复制','RUNTIME_PACKAGE_INVALID');
   if(!info.isDirectory())return;
   for(const entry of await this.fs.readdir(target))await walk(this.paths.join(target,entry));
  };
  await walk(root);
 }
 _randomSibling(parent,prefix){return this.paths.join(parent,`${prefix}${randomBytes(8).toString('hex')}`);}
 _track(target){const resolved=this.paths.resolve(target);this.ownPaths.add(resolved);return target;}
 async _removeOwn(target){
  if(!target)return false;
  const stored=this.paths.resolve(target);
  if(!this.ownPaths.has(stored))return false;
  let resolved=stored;
  try{resolved=this.paths.resolve(await this.fs.realpath(target));}catch{}
  const allowedRoots=[this.stageRoot,this.origParent].filter(Boolean).map(root=>this.paths.resolve(root));
  if(!allowedRoots.some(root=>this._inside(root,resolved,{equal:true})))return false;
  this.ownPaths.delete(stored);
  try{await this.fs.rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:100});return true;}catch{return false;}
 }
 async _preserve(source,failed){
  try{await this.fs.lstat(source);await this.fs.rename(source,failed);this._track(failed);return failed;}catch{return source;}
 }
 async _swapTransaction({packageRoot,origParent,stagedSibling,oldVersion,targetVersion,npmPath}){
  const backup=this._randomSibling(origParent,'.codex-light-backup-');
  const failed=this._randomSibling(origParent,'.codex-light-failed-');
  try{await this.fs.rename(packageRoot,backup);}
  catch(error){await this._removeOwn(stagedSibling);throw fail('无法进入替换窗口，现有版本未更改','RUNTIME_SWAP_START_FAILED');}
  this._track(backup);
  try{await this.fs.rename(stagedSibling,packageRoot);}
  catch(error){
   const failedPath=await this._preserve(stagedSibling,failed);
   return this._rollback({backup,packageRoot,npmPath,oldVersion,failedPath,reason:'替换未完成'});
  }
  const installedExecutable=findNativeCodexInPackage(packageRoot,{platform:this.platform,arch:this.arch,exists:this.exists,paths:this.paths});
  if(installedExecutable&&this._probe(installedExecutable)===targetVersion){
   const removed=await this._removeOwn(backup);
   if(!removed)this.upgradeDiagnostics.push(`升级成功，但旧版本备份仍保留在 ${backup}`);
   return {outcome:'succeeded',installedVersion:targetVersion,restartRequired:true};
  }
  const failedPath=await this._preserve(packageRoot,failed);
  return this._rollback({backup,packageRoot,npmPath,oldVersion,failedPath,reason:'新版本验证失败'});
 }
 async _rollback({backup,packageRoot,npmPath,oldVersion,failedPath,reason}){
  try{await this.fs.rename(backup,packageRoot);}
  catch{
   this.upgradeDiagnostics.push(`回滚失败；备份保留在 ${backup}`);
   throw fail(`替换失败且回滚失败，结果未知；请保留备份 ${backup} 和失败副本 ${failedPath} 供诊断`,'RUNTIME_SWAP_ROLLBACK_FAILED','unknown');
  }
  if(this._probe(npmPath)!==oldVersion){
   this.upgradeDiagnostics.push(`回滚后旧版本验证失败；安装路径 ${packageRoot}，失败副本 ${failedPath}`);
   throw fail(`替换失败且回滚验证失败，结果未知；安装路径 ${packageRoot}，失败副本 ${failedPath}`,'RUNTIME_SWAP_ROLLBACK_FAILED','unknown');
  }
  this.upgradeDiagnostics.push(`替换失败，已恢复旧版本 ${oldVersion}；失败副本保留在 ${failedPath}`);
  throw fail(`替换失败，已恢复旧版本 ${oldVersion}，现有安装未改变`,'RUNTIME_SWAP_ROLLED_BACK');
 }
 async close(){
  if(this.closed)return;this.closed=true;
  this.rpc?.off?.('event',this._onEvent);
  if(this.checkController){try{this.checkController.abort();}catch{}this.checkController=null;}
  const pending=this.upgradePromise;
  if(pending){
   if(this.phase==='prepare'||this.phase==='stage'){
    this.cancelStage=true;
    if(this.activeCancel)this.activeCancel();
    else try{this.activeChild?.kill?.();}catch{}
   }
   await pending.catch(()=>{});
  }
  if(this.activeChild&&!this.swapStarted){try{this.activeChild.kill?.();}catch{}}
  if(this.stageRoot){await this._removeOwn(this.stageRoot);this.stageRoot=null;}
 }
}
