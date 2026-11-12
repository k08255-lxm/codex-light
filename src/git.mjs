import {resolveGitExecutable} from './git-runtime.mjs';
import {spawn} from 'node:child_process';
import {stat} from 'node:fs/promises';
import {isAbsoluteWorkingDirectory} from './security.mjs';

// Local, explicitly requested reads only. No shell, hooks, external diff or textconv.
export async function runGitRead(cwd,args,{spawnProcess=spawn,resolveExecutable=resolveGitExecutable,maxBytes=2*1024*1024,timeoutMs=15000}={}) {
 const executable=await resolveExecutable(cwd);
 return new Promise((resolve,reject)=>{
  const child=spawnProcess(executable,['--no-pager','-c','core.fsmonitor=false',...args],{cwd,shell:false,windowsHide:true,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('GIT_'))),GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_LITERAL_PATHSPECS:'1'}});
  let output=[],errors=[],bytes=0,settled=false;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
  const timer=setTimeout(()=>{child.kill();finish(new Error('Git 查询超时'));},timeoutMs);
  const capture=(chunks)=>chunk=>{bytes+=chunk.length;if(bytes>maxBytes){child.kill();finish(new Error('Git 输出超过限制，请缩小查询范围'));}else chunks.push(chunk);};
  child.stdout.on('data',capture(output));child.stderr.on('data',capture(errors));
  child.on('error',error=>finish(new Error(error.code==='ENOENT'?'未找到 Git，请先安装官方 Git':`Git 无法启动：${error.code||'unknown'}`)));
  child.on('close',code=>finish(null,{exitCode:code,stdout:Buffer.concat(output).toString('utf8'),stderr:Buffer.concat(errors).toString('utf8')}));
 });
}
export function parseGitStatus(raw){
 const records=raw.split('\0'),files=[];
 for(let i=0;i<records.length;i++){
  const row=records[i];if(!row)continue;
  if(row.length<4||row[2]!==' ')throw new Error('Git 状态格式无效');
  const index=row[0],worktree=row[1],path=row.slice(3);
  const file={index,worktree,path};
  if(index==='R'||index==='C'||worktree==='R'||worktree==='C'){
   if(!records[i+1])throw new Error('Git 重命名状态不完整');file.originalPath=records[++i];
  }
  files.push(file);
 }
 return files;
}
export class GitService {
 constructor({run=runGitRead,platform=process.platform,validateDirectory=async cwd=>{if(!(await stat(cwd)).isDirectory())throw new Error('工作目录不存在');}}={}){Object.assign(this,{run,platform,validateDirectory});}
 async read(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['cwd','kind','confirmedInspection'].includes(k)))throw new Error('Git 查询参数无效');
  if(!isAbsoluteWorkingDirectory(input.cwd,this.platform))throw new Error('Git 需要绝对工作目录');
  if(!['status','diff','stagedDiff'].includes(input.kind))throw new Error('不支持的 Git 查询');
  if(input.confirmedInspection!==undefined && typeof input.confirmedInspection!=='boolean')throw new Error('Git 检查确认无效');
  await this.validateDirectory(input.cwd);
  const filters=await this.run(input.cwd,['config','--name-only','--get-regexp','^filter\\..*\\.(clean|process)$']);
  if(![0,1].includes(filters.exitCode))throw new Error(`Git 配置检查失败 (${filters.exitCode})：${filters.stderr.slice(0,2000)}`);
  if(filters.stdout.trim() && input.confirmedInspection!==true){const error=new Error('此仓库配置了 Git clean/process filters。读取状态或差异也可能运行本机代码；请明确确认本次读取。');error.code='GIT_INSPECTION_CONFIRMATION_REQUIRED';error.outcome='notExecuted';throw error;}
  const args=input.kind==='status'?['status','--porcelain=v1','-z','--untracked-files=normal']:['diff','--no-ext-diff','--no-textconv','--no-color',...(input.kind==='stagedDiff'?['--cached']:[]),'--'];
  const result=await this.run(input.cwd,args);
  if(result.exitCode!==0)throw new Error(`Git 查询失败 (${result.exitCode})：${result.stderr.slice(0,2000)}`);
  return input.kind==='status'?{files:parseGitStatus(result.stdout)}:{diff:result.stdout};
 }
}
