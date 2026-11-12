// Experimental internal-only transaction. NOT exposed through HTTP or main UI.
// Deliberately supports ordinary tracked files only; no filters, conversions, hooks or commits.
import {spawn} from 'node:child_process';
import {readFile,lstat,realpath,open,rename,rm} from 'node:fs/promises';
import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const keys=(value,allowed)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new Error('无效事务参数');};
export async function runGitMutation(cwd,args,{index,stdin,spawnProcess=spawn}={}){return new Promise((resolve,reject)=>{
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_LITERAL_PATHSPECS:'1'};if(index)env.GIT_INDEX_FILE=index;
 const child=spawnProcess('git',['--no-pager','-c','core.fsmonitor=false',...args],{cwd,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});let size=0,output=[],errors=[],done=false;
 const end=(err,result)=>{if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(result);};const timer=setTimeout(()=>{child.kill();end(new Error('Git事务超时；未发布候选index'));},10000);
 for(const [stream,chunks] of [[child.stdout,output],[child.stderr,errors]])stream.on('data',x=>{size+=x.length;if(size>2*1024*1024){child.kill();end(new Error('Git事务输出超限'));}else chunks.push(x);});
 child.on('error',end);child.on('close',code=>code===0?end(null,Buffer.concat(output)):end(new Error('Git事务命令失败：'+Buffer.concat(errors).toString('utf8').slice(0,1000))));child.stdin.on('error',()=>{});child.stdin.end(stdin);
 });}
async function optionalFile(file){try{return await readFile(file);}catch(e){if(e.code==='ENOENT')return Buffer.alloc(0);throw e;}}
async function normalPath(root,relative){if(typeof relative!=='string'||!relative||relative.includes('\0')||path.isAbsolute(relative)||relative.split(/[\\/]/).some(x=>!x||x==='.'||x==='..'||x.toLowerCase()==='.git'))throw new Error('必须是精确仓库相对文件路径');let current=root;for(const part of relative.split(/[\\/]/)){current=path.join(current,part);const s=await lstat(current);if(s.isSymbolicLink())throw new Error('不支持符号链接或跳转路径');}const info=await lstat(current);if(!info.isFile()||info.size>5*1024*1024)throw new Error('仅支持不超过5MiB普通文件');return {file:current,mode:info.mode&0o111?'100755':'100644'};}
export class GitMutationService{
 constructor({run=runGitMutation}={}){this.plans=new Map();this.run=run;}
 async inspect(cwd,paths){
  if(!path.isAbsolute(cwd)||await realpath(cwd)!==path.resolve(cwd))throw new Error('工作目录必须是无符号链接的仓库根');
  const metadata=await lstat(path.join(cwd,'.git'));if(!metadata.isDirectory()||metadata.isSymbolicLink())throw new Error('暂不支持worktree、子模块或gitdir跳转');
  const root=(await this.run(cwd,['rev-parse','--show-toplevel'])).toString().trim();if(path.resolve(root)!==path.resolve(cwd))throw new Error('只允许选定仓库根');
  // Any attribute or conversion setting is unsupported instead of silently bypassed.
  const conversion=(await this.run(cwd,['config','--get-regexp','^core\\.(autocrlf|eol|attributesfile)$']).catch(e=>{if(e.message.startsWith('Git事务命令失败：')&&e.message==='Git事务命令失败：')return Buffer.alloc(0);throw e;})).toString().trim();if(conversion)throw new Error('转换配置可能改变暂存内容；请使用原Git工具');
  const attrs=await this.run(cwd,['check-attr','-z','--all','--',...paths]);if(attrs.length)throw new Error('文件含Git attributes，clean/filter可能执行代码；本事务不执行，使用原Git工具');
  const entries=[];let total=0;
  for(const relative of paths){const resolved=await normalPath(cwd,relative),bytes=await readFile(resolved.file);total+=bytes.length;if(total>10*1024*1024)throw new Error('选定内容总计超过10MiB');const tracked=await this.run(cwd,['ls-files','--stage','-z','--',relative]);const rows=tracked.toString().split('\0').filter(Boolean);if(rows.length!==1||!/^100(644|755) [0-9a-f]+ 0\t/.test(rows[0]))throw new Error('仅支持无冲突已跟踪普通文件');const flags=(await this.run(cwd,['ls-files','-v','-z','--',relative])).toString();if(!flags.startsWith('H '))throw new Error('不支持skip-worktree或assume-unchanged文件');entries.push({relative,mode:rows[0].slice(0,6),bytes,hash:digest(bytes)});}
  const indexPath=path.join(cwd,'.git','index');const indexInfo=await lstat(indexPath);if(!indexInfo.isFile()||indexInfo.isSymbolicLink())throw new Error('index必须是普通文件');const index=await optionalFile(indexPath);const head=(await this.run(cwd,['rev-parse','--verify','HEAD'])).toString().trim();return {entries,index,head,fingerprint:digest(JSON.stringify({index:digest(index),head,files:entries.map(({relative,mode,hash})=>({relative,mode,hash}))}))};
 }
 async plan(input){keys(input,['cwd','action','paths']);if(!['stage','unstage'].includes(input.action)||!Array.isArray(input.paths)||input.paths.length<1||input.paths.length>32||new Set(input.paths).size!==input.paths.length)throw new Error('事务需stage/unstage及1–32个不同精确路径');if(this.plans.size>=32)throw new Error('计划数量已满');const state=await this.inspect(input.cwd,input.paths);const id=randomUUID();this.plans.set(id,{...input,state,expiresAt:Date.now()+120000,status:'ready'});return {planId:id,action:input.action,cwd:input.cwd,paths:input.paths,expiresAt:this.plans.get(id).expiresAt,fingerprint:state.fingerprint,warnings:['仅已跟踪普通文件；含attributes/转换/filter的文件拒绝，不执行clean filters或hooks。','仅改变Git index；不提交、不推送、不修改工作文件。']};}
 async apply(input){keys(input,['planId','confirmed']);if(input.confirmed!==true)throw new Error('必须明确确认方案');const p=this.plans.get(input.planId);if(!p||p.status!=='ready'||p.expiresAt<Date.now())throw new Error('计划不存在、过期或已使用');p.status='applying';const lock=path.join(p.cwd,'.git','index.lock'),candidate=path.join(p.cwd,'.git','codex-light-index-'+randomUUID());let handle,ownsLock=false,published=false;
  try{handle=await open(lock,'wx',0o600);ownsLock=true;const state=await this.inspect(p.cwd,p.paths);if(state.fingerprint!==p.state.fingerprint)throw new Error('仓库已变化，拒绝旧方案');await (await open(candidate,'wx',0o600)).close();const candidateHandle=await open(candidate,'w');try{await candidateHandle.writeFile(p.state.index);}finally{await candidateHandle.close();}
   for(const entry of p.state.entries){let mode,oid;
    if(p.action==='stage'){mode=entry.mode;oid=(await this.run(p.cwd,['hash-object','-w','--stdin'],{stdin:entry.bytes})).toString().trim();}
    else{const row=(await this.run(p.cwd,['ls-tree','-z',p.state.head,'--',entry.relative])).toString();const match=/^(100644|100755) blob ([0-9a-f]+)\t/.exec(row);if(!match)throw new Error('HEAD中不是普通文件，暂不支持此取消暂存');[,mode,oid]=match;}
    await this.run(p.cwd,['update-index','--add','--cacheinfo',mode,oid,entry.relative],{index:candidate});
   }
   const check=await this.inspect(p.cwd,p.paths);if(check.fingerprint!==p.state.fingerprint)throw new Error('生成候选期间仓库已变化，未发布index');const bytes=await readFile(candidate);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await rename(lock,path.join(p.cwd,'.git','index'));published=true;ownsLock=false;p.status='applied';return {applied:true,action:p.action,paths:p.paths};
  }catch(error){p.status='failed';throw error;}finally{if(handle)await handle.close();if(ownsLock)await rm(lock,{force:true});await rm(candidate,{force:true});if(!published&&p.status==='applying')p.status='failed';}
 }
 cancel(planId){const p=this.plans.get(planId);if(p?.status==='ready')this.plans.delete(planId);}
}
