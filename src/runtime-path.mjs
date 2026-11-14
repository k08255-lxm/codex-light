import {discoverPrivateCodex} from './private-codex.mjs';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {compareVersions} from './update-manifest.mjs';

const PROBE_TIMEOUT=5000;
const PROBE_MAX_OUTPUT=64*1024;
const VERSION_TOKEN=/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\b/g;
const PACKAGE_NAME=/^OpenAI\.Codex_[A-Za-z0-9._-]+$/i;

function versionFromText(value){
 if(typeof value!=='string')return null;
 VERSION_TOKEN.lastIndex=0;
 let match;
 while((match=VERSION_TOKEN.exec(value))){
  const start=match.index;
  const end=start+match[0].length;
  if(value[end]==='+'||value[start-1]==='+')continue;
  try{compareVersions(match[1],match[1]);return match[1];}catch{}
 }
 return null;
}

export function parseCodexVersion(value){return versionFromText(value);}

export function nativeCodexCandidatesInPackage(packageRoot,{platform='win32',arch=process.arch,paths=platform==='win32'?path.win32:path.posix}={}){
 if(platform!=='win32')return [];
 if(arch==='x64')return [
  paths.join(packageRoot,'node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe'),
  paths.join(packageRoot,'vendor','x86_64-pc-windows-msvc','codex','codex.exe'),
 ];
 if(arch==='arm64')return [
  paths.join(packageRoot,'node_modules','@openai','codex-win32-arm64','vendor','aarch64-pc-windows-msvc','bin','codex.exe'),
  paths.join(packageRoot,'vendor','aarch64-pc-windows-msvc','codex','codex.exe'),
 ];
 return [];
}

export function findNativeCodexInPackage(packageRoot,{platform='win32',arch=process.arch,exists=existsSync,paths}={}){
 const roots=paths||(platform==='win32'?path.win32:path.posix);
 return nativeCodexCandidatesInPackage(packageRoot,{platform,arch,paths:roots}).find(candidate=>roots.isAbsolute(candidate)&&exists(candidate))||null;
}

export function probeCodexVersion(executable,{spawnSyncFn=spawnSync}={}){
 try{
  const result=spawnSyncFn(executable,['--version'],{encoding:'utf8',timeout:PROBE_TIMEOUT,maxBuffer:PROBE_MAX_OUTPUT,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  if(result?.error||result?.status!==0)return null;
  return versionFromText(`${result.stdout||''}\n${result.stderr||''}`);
 }catch{return null;}
}

function powershellPath(env){
 const root=env.SystemRoot||env.windir||'C:\\Windows';
 return path.win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
}

export function discoverDesktopLocation({platform=process.platform,env=process.env,spawnSyncFn=spawnSync}={}){
 if(platform!=='win32')return null;
 const result=spawnSyncFn(powershellPath(env),['-NoLogo','-NoProfile','-NonInteractive','-Command','Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation'],{encoding:'utf8',timeout:PROBE_TIMEOUT,maxBuffer:PROBE_MAX_OUTPUT,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
 if(result?.error)throw new Error('无法查询官方桌面引擎安装位置');
 if(result?.status!==0)throw new Error('官方桌面引擎查询失败');
 const lines=String(result.stdout||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
 const official=lines.find(line=>{
  if(!path.win32.isAbsolute(line))return false;
  const parts=line.replace(/\//g,'\\').split('\\').filter(Boolean);
  return PACKAGE_NAME.test(parts.at(-1)||'');
 });
 return official||lines[0]||null;
}

function desktopExecutable(location,{paths,exists,diagnostics}){
 if(typeof location!=='string'||!location||location.length>4096||/[\x00-\x1f\x7f]/.test(location)||!paths.isAbsolute(location)){
  diagnostics.push('官方桌面引擎安装位置不是有效的绝对路径');
  return null;
 }
 const normalized=paths.normalize(location);
 const parts=normalized.split(/[\\/]+/).filter(Boolean);
 const packageName=parts.at(-1)||'';
 if(!PACKAGE_NAME.test(packageName)){
  diagnostics.push('官方桌面引擎路径不是 OpenAI.Codex 包目录');
  return null;
 }
 const executable=paths.join(normalized,'app','resources','codex.exe');
 if(!paths.isAbsolute(executable)){
  diagnostics.push('官方桌面引擎路径无效');
  return null;
 }
 if(!exists(executable)){
  diagnostics.push('官方桌面引擎目录存在但缺少 app/resources/codex.exe');
  return null;
 }
 return executable;
}

function candidateVersion(label,executable,versionOf,diagnostics){
 if(!executable)return null;
 let raw;
 try{raw=versionOf(executable);}catch{diagnostics.push(`${label}版本探测失败`);return null;}
 const version=versionFromText(typeof raw==='string'?raw:'');
 if(!version){diagnostics.push(`${label}版本输出无法解析`);return null;}
 return version;
}

export function discoverRuntimeCandidates({platform=process.platform,arch=process.arch,env=process.env,home=os.homedir(),exists=existsSync,discoverDesktop,versionOf,spawnSyncFn=spawnSync,npmPackageRoot}={}){
 const paths=platform==='win32'?path.win32:path.posix;
 const diagnostics=[];
 const discover=discoverDesktop||((options={})=>discoverDesktopLocation({platform,env,...options}));
 const readVersion=versionOf||((executable)=>probeCodexVersion(executable,{spawnSyncFn}));
 let npmPath=null,desktopPath=null;
 if(platform==='win32'){
  const root=env.APPDATA||paths.join(home,'AppData','Roaming');
  const packageRoot=npmPackageRoot&&paths.isAbsolute(npmPackageRoot)?npmPackageRoot:paths.join(root,'npm','node_modules','@openai','codex');
  npmPath=findNativeCodexInPackage(packageRoot,{platform,arch,exists,paths});
  let location=null;
  try{location=discover();}catch(error){diagnostics.push(error?.message||'官方桌面引擎查询失败');}
  if(location)desktopPath=desktopExecutable(location,{paths,exists,diagnostics});
 }else{
  for(const folder of (env.PATH||'').split(':')){
   if(!folder||!path.posix.isAbsolute(folder))continue;
   const candidate=path.posix.join(folder,'codex');
   if(exists(candidate)){npmPath=candidate;break;}
  }
 }
 return {
  npm:{available:!!npmPath,path:npmPath,version:candidateVersion('npm CLI',npmPath,readVersion,diagnostics)},
  desktop:{available:!!desktopPath,path:desktopPath,version:candidateVersion('官方桌面引擎',desktopPath,readVersion,diagnostics)},
  diagnostics,
 };
}

function validateExplicit(value,{platform,paths,exists}){
 if(!paths.isAbsolute(value)||/[\x00-\x1f\x7f]/.test(value)||(platform==='win32'&&!/\.exe$/i.test(value))||!exists(value))throw new Error('CODEX_LIGHT_CODEX 必须是存在的 Codex 原生程序绝对路径。');
 return value;
}

export function resolveCodexRuntime({platform=process.platform,arch=process.arch,env=process.env,home=os.homedir(),exists=existsSync,discoverDesktop,versionOf,spawnSyncFn=spawnSync}={}){
 const paths=platform==='win32'?path.win32:path.posix;
 if(env.CODEX_LIGHT_CODEX){
  return {path:validateExplicit(env.CODEX_LIGHT_CODEX,{platform,paths,exists}),source:'env',npm:{available:false,path:null,version:null},desktop:{available:false,path:null,version:null},diagnostics:[]};
 }
 if(platform!=='win32'){
  for(const folder of (env.PATH||'').split(':')){
   if(!folder||!path.posix.isAbsolute(folder))continue;
   const candidate=path.posix.join(folder,'codex');
   if(exists(candidate))return {path:candidate,source:'path',npm:{available:true,path:candidate,version:null},desktop:{available:false,path:null,version:null},diagnostics:[]};
  }
  throw new Error('未找到已安装的 Codex CLI，请安装官方 CLI 或指定原生程序绝对路径。');
 }
 const candidates=discoverRuntimeCandidates({platform,arch,env,home,exists,discoverDesktop,versionOf,spawnSyncFn});
 const {npm,desktop}=candidates; // Reuse runnable system candidates first. App-private CLI is an explicit-install fallback.
 if(!npm.version&&!desktop.version){
  try{const privateCli=discoverPrivateCodex({platform,arch,env,home});
   if(privateCli&&probeCodexVersion(privateCli.path,{spawnSyncFn})===privateCli.version)return {...candidates,path:privateCli.path,source:'private'};
  }catch{candidates.diagnostics.push('App-private Codex CLI could not be verified; no files changed');}
 }
 if(!npm.path&&!desktop.path)throw new Error('未找到官方 npm 安装的 Codex 原生程序。请指定 CODEX_LIGHT_CODEX 绝对路径；不会从工作目录寻找 codex.exe。');
 let selected;
 if(npm.path&&desktop.path){
  if(npm.version&&desktop.version){
   const order=compareVersions(npm.version,desktop.version);
   selected=order<0?{path:desktop.path,source:'desktop'}:{path:npm.path,source:'npm'};
  }else{
   selected={path:npm.path,source:'npm'};
   candidates.diagnostics.push('npm 与官方桌面引擎版本不完整，按既有 npm 优先规则回退');
  }
 }else if(npm.path)selected={path:npm.path,source:'npm'};
 else selected={path:desktop.path,source:'desktop'};
 return {...candidates,path:selected.path,source:selected.source};
}

export function nativeCodex(options={}){
 return resolveCodexRuntime(options).path;
}
