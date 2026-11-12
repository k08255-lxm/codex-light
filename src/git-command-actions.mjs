// Explicit local Git commands. Not a filesystem transaction and never auto-retried.
import {inspectPushTarget,pushArgv} from './git-push-plan.mjs';
import {resolveGitExecutable} from './git-runtime.mjs';
import {spawn} from 'node:child_process';
import {realpath,lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const fields=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new Error('无效 Git 操作参数');};
export async function boundedGitFileHash(file,budget={remaining:32*1024*1024}){
 const before=await lstat(file);if(!before.isFile()||before.isSymbolicLink())throw new Error('Git 检查只接受普通文件，拒绝符号链接');
 const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{const opened=await handle.stat();if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino)throw new Error('检查文件身份已改变');
 const digest=createHash('sha256'),buffer=Buffer.alloc(65536);let bytes=0;
 for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;bytes+=bytesRead;budget.remaining-=bytesRead;if(bytes>32*1024*1024||budget.remaining<0)throw new Error('Git 检查读取超过32MiB限制');digest.update(buffer.subarray(0,bytesRead));}
 const after=await handle.stat();if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)throw new Error('文件在读取期间变化，请重新检查');return digest.digest('hex');
 }finally{await handle.close();}
}
export function validateGitActionPath(value){
 if(typeof value!=='string'||!value||value.length>4096||/[\x00-\x1f\x7f\\:]/.test(value)||path.posix.isAbsolute(value)||path.win32.isAbsolute(value)||value.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git'))throw new Error('需要无穿越、无 magic 的仓库相对路径');
 return value;
}
export async function runGitCommand(cwd,args,{resolveExecutable=resolveGitExecutable,timeoutMs=30000,maxBytes=2*1024*1024}={}){
 let executable;try{executable=await resolveExecutable(cwd);}catch(error){return {outcome:'notExecuted',exitCode:null,stdout:'',stderr:'',error:error.message};}
 return new Promise(resolve=>{
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('GIT_'))),GIT_LITERAL_PATHSPECS:'1',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'};
  let child,done=false,timer,bytes=0,stdout=[],stderr=[];
  const finish=(outcome,exitCode,error)=>{if(done)return;done=true;clearTimeout(timer);resolve({outcome,exitCode,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),...(error?{error}: {})});};
  try{child=spawn(executable,['--no-pager','--literal-pathspecs','-c','core.fsmonitor=false',...args],{cwd,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch{finish('notExecuted',null,'Git 无法启动');return;}
  timer=setTimeout(()=>{child.kill();finish('unknown',null,'Git 超时，结果未知；请只读检查仓库，不要自动重试');},timeoutMs);
  for(const [stream,chunks] of [[child.stdout,stdout],[child.stderr,stderr]])stream.on('data',chunk=>{const available=Math.max(0,maxBytes-bytes);if(available)chunks.push(chunk.subarray(0,available));bytes+=chunk.length;if(bytes>maxBytes){child.kill();finish('unknown',null,'Git 输出超过限制，结果未知；请检查仓库');}});
  child.on('error',()=>finish('notExecuted',null,'Git 无法启动'));
  child.on('close',code=>finish(code===null?'unknown':'completed',code));
 });
}
export class GitCommandActions{
 constructor({run=runGitCommand,now=()=>Date.now()}={}){this.run=run;this.now=now;this.plans=new Map();}
 async query(cwd,args,allowed=[0]){const result=await this.run(cwd,args);if(result.outcome==='unknown'||!allowed.includes(result.exitCode))throw new Error('Git 只读检查失败：'+(result.error||result.stderr||result.exitCode));return result;}
 async inspect(cwd,paths){
  const root=await realpath((await this.query(cwd,['rev-parse','--show-toplevel'])).stdout.trim());
  const gitDir=await realpath((await this.query(root,['rev-parse','--absolute-git-dir'])).stdout.trim());
  const headResult=await this.query(root,['rev-parse','--verify','HEAD'],[0,128]);
  // An unborn branch is different from an arbitrary corrupt HEAD failure.
  if(headResult.exitCode!==0)await this.query(root,['symbolic-ref','HEAD']);
  const head=headResult.exitCode===0?headResult.stdout.trim():null;
  const indexRaw=(await this.query(root,['rev-parse','--git-path','index'])).stdout.trim();
  const budget={remaining:32*1024*1024};
  const indexPath=path.resolve(root,indexRaw);let index;
  try{index=await boundedGitFileHash(indexPath,budget);}catch(e){if(e.code!=='ENOENT')throw e;index='missing';}
  const status=(await this.query(root,['status','--porcelain=v1','-z','--untracked-files=all','--',...paths])).stdout;
  const diff=(await this.query(root,['diff','--no-ext-diff','--no-textconv','--no-color','--',...paths])).stdout;
  const stagedDiff=(await this.query(root,['diff','--cached','--no-ext-diff','--no-textconv','--no-color','--',...paths])).stdout;
  const staged=(await this.query(root,['diff','--cached','--name-only','--no-renames','-z','--'])).stdout.split('\0').filter(Boolean);
  // Snapshot selected untracked bytes too; Git diff intentionally excludes them.
  const untracked=(await this.query(root,['ls-files','--others','--exclude-standard','-z','--',...paths])).stdout.split('\0').filter(Boolean);
  if(untracked.length>1000)throw new Error('未跟踪文件过多，请缩小范围');
  const untrackedHashes=[];for(const p of untracked){validateGitActionPath(p);const file=path.resolve(root,p);const canonical=await realpath(file);if(!canonical.startsWith(root+path.sep))throw new Error('未跟踪文件跳转到仓库外，拒绝计划');untrackedHashes.push([p,await boundedGitFileHash(file,budget)]);}
  const config=(await this.query(root,['config','--name-only','--get-regexp','^(filter\\.|core\\.(hooksPath|attributesFile)|commit\\.gpgSign|gpg\\.)'],[0,1])).stdout.trim().split('\n').filter(Boolean);
  const configValues=(await this.query(root,['config','--get-regexp','^(filter\\.|core\\.(hooksPath|attributesFile)|commit\\.gpgSign|gpg\\.)'],[0,1])).stdout;
  const hookPath=(await this.query(root,['rev-parse','--git-path','hooks'])).stdout.trim();
  const fingerprint=hash(JSON.stringify({root,gitDir,head,index,status,diff,stagedDiff,untrackedHashes,configHash:hash(configValues),hookPath}));
  return {root,head,fingerprint,staged,diffSummary:{unstaged:diff.slice(0,16000),staged:stagedDiff.slice(0,16000),truncated:diff.length>16000||stagedDiff.length>16000},configurationKeys:config,hooksPath:path.resolve(root,hookPath)};
 }
 async plan(input){
  fields(input,['cwd','action','paths','message','confirmedInspection']);
  if(input.confirmedInspection!==true){const error=new Error('检查计划可能运行 Git filters；必须先明确确认本次检查及 hooks/签名风险');error.code='GIT_INSPECTION_CONFIRMATION_REQUIRED';throw error;}
  if(typeof input.cwd!=='string'||!path.isAbsolute(input.cwd)||!['stage','unstage','commit','push'].includes(input.action))throw new Error('需要绝对目录及受支持的 Git 动作');
  const paths=input.paths??[];
  if(!Array.isArray(paths)||paths.length>100||new Set(paths).size!==paths.length||(!['commit','push'].includes(input.action)&&!paths.length)||(['commit','push'].includes(input.action)&&paths.length))throw new Error('暂存需明确选择路径，提交仅使用已暂存列表');
  paths.forEach(validateGitActionPath);
  if(input.action==='commit'&&(typeof input.message!=='string'||!input.message.trim()||input.message.length>10000||input.message.includes('\0')))throw new Error('提交信息必须非空且不超过10000字符');
  if(input.action!=='commit'&&input.message!==undefined)throw new Error('此动作不接受提交信息');
  for(const [id,p]of this.plans)if(p.expiresAt<this.now())this.plans.delete(id);
  if(this.plans.size>=32)throw new Error('待确认计划过多');
  const state=await this.inspect(input.cwd,paths);const push=input.action==='push'?await inspectPushTarget(state.root,this.query.bind(this)):null;if(input.action==='commit'&&!state.staged.length)throw new Error('没有已暂存文件，未创建提交计划');
  const planId=randomUUID(),expiresAt=this.now()+120000;
  const warnings=['Git filters、hooks 及签名程序可能运行本机代码；本客户端不会跳过正常 hooks。','执行时读取当前工作树；其他进程可同时修改仓库，不是跨进程原子快照。','操作失败也可能已有部分变化；未知结果必须只读检查，不能自动重试。'];
  this.plans.set(planId,{action:input.action,paths:[...paths],message:input.message,state,push,expiresAt,used:false});
  if(push)warnings.push('代码和提交将发送到显示的远程仓库及分支；本地 tracking 可能过期，没有自动 fetch。正常 pre-push hooks 和 SSH/凭据程序可能运行。禁止 force、mirror、跟随 tags 和递归推送子模块。');
  return {planId,expiresAt,action:input.action,push:push?{branch:push.branch,remote:push.remote,targetBranch:push.targetBranch,target:push.target,commitCount:push.commitCount,commits:push.commits,truncated:push.truncated}:undefined,root:state.root,paths:[...paths],stagedFiles:state.staged,message:input.message,...state.diffSummary,configurationKeys:state.configurationKeys,hooksPath:state.hooksPath,warnings};
 }
 async apply(input){
  fields(input,['planId','confirmed']);if(input.confirmed!==true)throw new Error('必须明确确认原计划');
  const p=this.plans.get(input.planId);if(!p||p.used||p.expiresAt<=this.now())throw new Error('计划已使用或过期，请重新检查确认');p.used=true;
  const state=await this.inspect(p.state.root,p.paths);if(state.fingerprint!==p.state.fingerprint)throw new Error('仓库、HEAD、index 或工作树已变化；请重新检查确认');
  if(p.action==='push'){const current=await inspectPushTarget(state.root,this.query.bind(this));if(current.fingerprint!==p.push.fingerprint)throw new Error('实际推送目标、分支或提交已变化，请重新确认');}
  const args=p.action==='push'?pushArgv(p.push):p.action==='stage'?['add','--',...p.paths]:p.action==='unstage'?(state.head?['restore','--staged','--',...p.paths]:['rm','--cached','--ignore-unmatch','--',...p.paths]):['commit','-m',p.message];
  let result;try{result=await this.run(state.root,args,p.action==='push'?{timeoutMs:120000}:{});}catch{result={outcome:'unknown',exitCode:null,stdout:'',stderr:'',error:'Git 执行结果未知；请只读检查，不能自动重试'};}
  return {planId:input.planId,action:p.action,root:state.root,...result,requiresInspection:result.outcome==='unknown'||result.exitCode!==0};
 }
}
