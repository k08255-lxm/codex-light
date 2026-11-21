import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,lstat,unlink} from 'node:fs/promises';

const exec=promisify(execFile);
const fail=(message,code='WSL_RUNTIME_INVALID')=>Object.assign(new Error(message),{code,outcome:'notExecuted'});
const safeName=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const cleanPath=value=>typeof value==='string'&&value.length<=4096&&!/[\x00-\x1f\x7f]/.test(value);
export function validateWslSelection(value){
 if(value===null)return null;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['distribution','user','codexPath'].includes(k))||!safeName(value.distribution)||(value.user!==undefined&&!safeName(value.user))||(value.codexPath!==undefined&&(!cleanPath(value.codexPath)||!value.codexPath.startsWith('/')||value.codexPath.startsWith('//'))))throw fail('Invalid WSL distribution, user or absolute Linux CLI path');
 return {distribution:value.distribution,...(value.user?{user:value.user}:{}),...(value.codexPath?{codexPath:value.codexPath}:{})};
}
export function wslExecutable(env=process.env){return path.win32.join(env.SystemRoot||'C:\\Windows','System32','wsl.exe');}
function decodeList(value){const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);return bytes.includes(0)?bytes.toString('utf16le'):bytes.toString('utf8');}
const PROBE=`c="$1"
if [ -z "$c" ]; then c=$(command -v codex 2>/dev/null || true); fi
if [ -z "$1" ] && [ -n "$c" ]; then
 fs=$(stat -f -c %T -- "$c" 2>/dev/null || true)
 case "$fs:$c" in 9p:*|drvfs:*|ntfs:*|fuseblk:*|*:*.exe|*:*.cmd|*:*.bat) c='';; esac
fi
if [ -z "$c" ]; then
 count=0; found=''
 for bin in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.local/share/fnm/node-versions/*/installation/bin; do
  if [ -x "$bin/codex" ] && [ -x "$bin/node" ]; then count=$((count + 1)); found="$bin/codex"; fi
 done
 if [ "$count" = 1 ]; then c="$found"; fi
fi
kind=unavailable
nodebin=''
if [ -n "$c" ] && [ -x "$c" ]; then
 bin=$(dirname -- "$c"); PATH="$bin:$PATH"; export PATH
 c=$(readlink -f -- "$c" 2>/dev/null || printf '%s' "$c")
 fs=$(stat -f -c %T -- "$c" 2>/dev/null || true)
 case "$fs:$c" in 9p:*|drvfs:*|ntfs:*|fuseblk:*|*:*.exe|*:*.cmd|*:*.bat) kind=windows-interop;;
 *)
  magic=$(head -c 4 -- "$c" 2>/dev/null | od -An -tx1 | tr -d ' \\n')
  if [ "$magic" = 7f454c46 ]; then kind=linux; else
   n=$(command -v node 2>/dev/null || true)
   nmagic=$(head -c 4 -- "$n" 2>/dev/null | od -An -tx1 | tr -d ' \\n')
   case "$magic:$nmagic" in 2321*:7f454c46) kind=linux; nodebin=$(dirname -- "$n");; *) kind=unsupported;; esac
  fi;;
 esac
fi
h=$(realpath -m -- "$HOME" 2>/dev/null || printf '%s' "$HOME")
ch=$(realpath -m -- "\${CODEX_HOME:-$HOME/.codex}" 2>/dev/null || printf '%s' "\${CODEX_HOME:-$HOME/.codex}")
printf 'CODECANG_WSL\\n'; id -un; printf '%s\\n' "$h" "$ch" "$c" "$kind" "$nodebin"`;
function isolatedWslEnvironment(source){
 const env={...source};
 const blocked=key=>/^(?:CODEX_HOME|CODEX_LIGHT_CODEX|OPENAI_API_KEY|DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|ELECTRON_RUN_AS_NODE|WSLENV)$/i.test(key)||/^(?:DSH_|GIT_)/i.test(key);
 for(const key of Object.keys(env))if(blocked(key))delete env[key];
 // Arbitrary custom credential names may be listed in WSLENV. Do not carry any
 // Windows-selected variables into Linux; the Linux login shell owns its env.
 env.WSLENV='';
 return env;
}
export class WslRuntime {
 constructor({platform=process.platform,env=process.env,run=exec}={}){Object.assign(this,{platform,env,run});this.command=wslExecutable(env);}
 async invoke(args,{encoding='utf8',maxBuffer=128*1024,timeout=10000}={}){if(this.platform!=='win32')throw fail('WSL is available only on Windows','WSL_UNAVAILABLE');const result=await this.run(this.command,args,{encoding,env:isolatedWslEnvironment(this.env),windowsHide:true,shell:false,timeout,maxBuffer});return result.stdout;}
 async distributions({runningOnly=false,timeout=10000,strict=false}={}){const raw=await this.invoke(['--list',...(runningOnly?['--running']:[]),'--quiet'],{encoding:'buffer',timeout});const names=decodeList(raw).replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(strict&&names.some(name=>!safeName(name)))throw fail('WSL 列表包含无法识别的条目','WSL_LIST_UNVERIFIED');return [...new Set(names.filter(safeName))];}
 async probe(input,{runningOnly=false,timeout=10000}={}){
  const selection=validateWslSelection(input);if(!selection)throw fail('Select a WSL distribution');
  if(!(await this.distributions({runningOnly,timeout})).includes(selection.distribution))throw fail(runningOnly?'发行版已停止，未自动启动':'WSL distribution is not registered',runningOnly?'WSL_NOT_RUNNING':'WSL_NOT_FOUND');
  // Windows' WSL filesystem share uses the distribution's default user. Keep
  // execution on that same identity; arbitrary --user would split permissions.
  const args=['--distribution',selection.distribution,'--cd','~','--exec','/bin/sh',runningOnly?'-c':'-lc',PROBE,'codecang-probe',selection.codexPath||''];
  const lines=String(await this.invoke(args,{timeout})).replace(/\r/g,'').split('\n');const start=lines.lastIndexOf('CODECANG_WSL');
  if(start<0)throw fail('Could not read WSL environment','WSL_PROBE_FAILED');
  const [user,home,codexHome,codexPath,runtimeKind,nodeDirectory='']=lines.slice(start+1,start+7);
  if(!safeName(user)||![home,codexHome].every(v=>cleanPath(v)&&v.startsWith('/'))||(codexPath&&(!cleanPath(codexPath)||!codexPath.startsWith('/'))))throw fail('Invalid WSL environment','WSL_PROBE_FAILED');
  wslPathToHost(home,selection.distribution);wslPathToHost(codexHome,selection.distribution);
  if(selection.user&&selection.user!==user)throw fail('仅支持发行版默认用户；默认用户已变化或请求了其他用户，请重新发现并选择','WSL_USER_MISMATCH');
  if(nodeDirectory&&(!cleanPath(nodeDirectory)||!nodeDirectory.startsWith('/')))throw fail('Invalid Linux Node directory','WSL_PROBE_FAILED');
  return {...selection,user,home,codexHome,codexPath:codexPath||null,...(nodeDirectory?{nodeDirectory}:{}),available:!!codexPath&&runtimeKind==='linux',...(runtimeKind==='linux'?{}:{diagnostic:runtimeKind==='windows-interop'?'只发现 Windows interop Codex，请选择 Linux CLI 路径':'非交互 PATH 或标准 nvm/fnm 目录未找到唯一 Linux CLI。可填写其 Linux 绝对路径；这不表示 Codex 未安装。'})};
 }
 async discover(){
  let names;try{names=await this.distributions();}catch{return {available:false,candidates:[],diagnostic:'WSL 不可用或无法查询，未更改系统设置'};}
  const candidates=[];for(const distribution of names){try{candidates.push(await this.probe({distribution}));}catch(error){candidates.push({distribution,available:false,diagnostic:error.code||'WSL_PROBE_FAILED'});}}
  return {available:true,candidates};
 }
 // Coalesce background requests. Probe only distributions observed running,
 // and recheck that state before opening a Linux shell. Do not persist a choice.
 discoverRunning(){
  if(this.runningDiscovery)return this.runningDiscovery;
  const job=this._discoverRunning();
  this.runningDiscovery=job;
  return job.finally(()=>{if(this.runningDiscovery===job)this.runningDiscovery=null;});
 }
 async _discoverRunning(){
  const timeout=3000;
  let names,running;try{[names,running]=await Promise.all([this.distributions({timeout,strict:true}),this.distributions({runningOnly:true,timeout,strict:true})]);}
  catch(error){
   // Distinguish a missing executable/disabled optional component from an
   // unknown failure. Do not parse localized diagnostic prose.
   const unavailable=error?.code==='ENOENT'||(Number.isInteger(error?.code)&&(error.code>>>0)===0x8007019e);
   return {available:false,candidates:[],pendingDistributions:[],discoveryIncomplete:!unavailable,
    diagnostic:unavailable?'此电脑未启用 WSL。':'无法读取 WSL 运行状态；不会据此判断未安装。'};
  }
  const runningNames=names.filter(name=>running.includes(name));
  const checked=runningNames.slice(0,4);
  const results=await Promise.all(checked.map(async distribution=>{
   try{const {codexHome:_home,...candidate}=await this.probe({distribution},{runningOnly:true,timeout});return {...candidate,passiveProbe:true,...(!candidate.available?{probePending:true}:{})};}
   catch{return {distribution,available:false,probePending:true,diagnostic:'自动检测未完成，可重新检测。'};}
  }));
  const detected=new Map(results.map(candidate=>[candidate.distribution,candidate]));
  const candidates=names.map(distribution=>detected.get(distribution)??{
   distribution,available:false,probePending:true,
   diagnostic:runningNames.includes(distribution)?'超出单次自动检测数量，可手动检测。':'发行版未运行。未主动启动。',
  });
  return {available:true,candidates,pendingDistributions:candidates.filter(c=>c.probePending).map(c=>c.distribution),discoveryIncomplete:false};
 }
 async toLinux(value,candidate){
  if(!/^[A-Za-z]:[\\/]/.test(value))return hostPathToWsl(value,candidate.distribution);
  if(!cleanPath(value))throw fail('Invalid workspace path');
  const result=String(await this.invoke(['--distribution',candidate.distribution,'--user',candidate.user,'--exec','wslpath','-a','-u',value])).trim();
  if(!result.startsWith('/')||!cleanPath(result))throw fail('Could not map the Windows path into WSL','WSL_PATH_UNSUPPORTED');
  return result;
 }
 async gitRead(cwd,args,candidate){
  if(this.platform!=='win32')throw fail('WSL is available only on Windows','WSL_UNAVAILABLE');
  validateWslSelection({distribution:candidate?.distribution,user:candidate?.user});
  if(!candidate?.user||!Array.isArray(args)||args.some(value=>typeof value!=='string'))throw fail('Invalid WSL Git read parameters');
  const directory=await this.toLinux(cwd,candidate);
  // Preserve the selected Linux user's Git configuration, but never allow an
  // inherited GIT_DIR/GIT_WORK_TREE to redirect the explicitly selected repo.
  const script=`for key in $(env | sed -n 's/^\\(GIT_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$key"; done
g=$(command -v git 2>/dev/null || true)
case "$g" in /*) ;; *) printf '%s\\n' '所选 WSL 发行版未找到 Linux Git，请先在该发行版安装 Git。' >&2; exit 127;; esac
g=$(readlink -f -- "$g")
magic=$(head -c 4 -- "$g" | od -An -tx1 | tr -d ' \\n')
[ "$magic" = 7f454c46 ] || { printf '%s\\n' '所选 WSL 环境中的 Git 不是 Linux 可执行文件；未改用 Windows Git。' >&2; exit 126; }
export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_LITERAL_PATHSPECS=1
exec "$g" --no-pager -c core.fsmonitor=false "$@"`;
  const argv=['--distribution',candidate.distribution,'--user',candidate.user,'--cd',directory,'--exec','/bin/sh','-lc',script,'codecang-git',...args];
  try{
   const result=await this.run(this.command,argv,{cwd:os.tmpdir(),encoding:'utf8',env:isolatedWslEnvironment(this.env),windowsHide:true,shell:false,timeout:15000,maxBuffer:2*1024*1024});
   return {exitCode:0,stdout:result.stdout||'',stderr:result.stderr||''};
  }catch(error){
   if(error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')throw fail('WSL Git 输出超过限制，请缩小查询范围','WSL_GIT_OUTPUT_LIMIT');
   if(error.killed)throw fail('WSL Git 查询超时','WSL_GIT_TIMEOUT');
   if(Number.isInteger(error.code))return {exitCode:error.code,stdout:error.stdout||'',stderr:error.stderr||''};
   throw fail('无法在所选 WSL 发行版中启动 Git：'+(typeof error.code==='string'?error.code:'unknown'),'WSL_GIT_UNAVAILABLE');
  }
 }
 launch(candidate){
  if(!candidate?.available||!candidate.codexPath)throw fail('Codex was not found in the selected WSL user environment','WSL_CODEX_NOT_FOUND');
  // Never forward a Windows account's configuration or API key into Linux.
  const env=isolatedWslEnvironment(this.env);
  return {command:this.command,args:['--distribution',candidate.distribution,'--user',candidate.user,'--cd',candidate.home,'--exec','/bin/sh','-lc','if [ -n "$1" ]; then PATH="$1:$PATH"; export PATH; fi; shift; exec "$@"','codecang-wsl',candidate.nodeDirectory||'',candidate.codexPath,'app-server','--listen','stdio://','-c','thread_unload_delay_secs=0'],env,cwd:os.tmpdir()};
 }
}

export function wslPathToHost(value,distribution){
 if(!cleanPath(value)||!safeName(distribution)||!value.startsWith('/'))throw fail('Invalid Linux path');
 if(value.split('/').some(p=>p==='..'||p==='.'||p.includes('\\')||/[:*?"<>|]/.test(p)||/[. ]$/.test(p)))throw fail('Linux path cannot be represented safely on Windows','WSL_PATH_UNSUPPORTED');
 return `\\\\wsl.localhost\\${distribution}`+value.replaceAll('/','\\');
}
export function hostPathToWsl(value,distribution){
 if(!cleanPath(value)||!safeName(distribution))throw fail('Invalid workspace path');
 if(value.startsWith('/')&&!value.startsWith('//'))return value;
 const unc=/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i.exec(value);
 if(unc){if(unc[1].toLowerCase()!==distribution.toLowerCase())throw fail('Workspace belongs to a different WSL distribution','WSL_CROSS_DISTRIBUTION');return (unc[2]||'\\').replaceAll('\\','/');}
 // Drive paths must be converted by wslpath, not guessed as /mnt/<drive>.
 throw fail('Choose a directory inside the selected WSL distribution','WSL_PATH_UNSUPPORTED');
}
export function wslProfileId(candidate){return createHash('sha256').update(JSON.stringify([candidate.distribution,candidate.user,candidate.codexHome])).digest('hex').slice(0,24);}

const PATH_KEYS=new Set(['cwd','cwds','path','filePath','file_path','rootPath','workingDirectory','writableRoots','marketplacePath','savedPath']);
export async function mapWslRequest(value,convert,key=''){
 if(typeof value==='string'&&PATH_KEYS.has(key)&&(/^[A-Za-z]:[\\/]/.test(value)||value.startsWith('\\\\')||value.startsWith('/')))return convert(value);
 if(Array.isArray(value)){const result=[];for(const item of value)result.push(await mapWslRequest(item,convert,key));return result;}
 if(value&&typeof value==='object'){const result=[];for(const [k,v] of Object.entries(value))result.push([k,await mapWslRequest(v,convert,k)]);return Object.fromEntries(result);}
 return value;
}
export function mapWslResponse(value,distribution,key=''){
 if(typeof value==='string'&&PATH_KEYS.has(key)&&value.startsWith('/')){try{return wslPathToHost(value,distribution);}catch{return value;}}
 if(Array.isArray(value))return value.map(item=>mapWslResponse(item,distribution,key));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,mapWslResponse(v,distribution,k)]));
 return value;
}

export class WslSelectionStore {
 constructor({root=process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'CodexLight','state'):path.join(os.homedir(),'.codex-light'),fs={mkdir,readFile,writeFile,rename,lstat,unlink}}={}){this.root=root;this.file=path.join(root,'wsl-runtime.json');this.fs=fs;}
 async safe(){for(let p=this.file;;p=path.dirname(p)){try{if((await this.fs.lstat(p)).isSymbolicLink())throw fail('Runtime settings path is a link');}catch(e){if(e.code!=='ENOENT')throw e;}if(path.dirname(p)===p)break;}}
 async read(){await this.safe();try{const stat=await this.fs.lstat(this.file);if(!stat.isFile()||stat.size>4096)throw fail('Invalid runtime settings');return validateWslSelection(JSON.parse(await this.fs.readFile(this.file,'utf8')));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async save(value){const selected=validateWslSelection(value);await this.safe();await this.fs.mkdir(this.root,{recursive:true});const temporary=path.join(this.root,`.wsl-runtime-${randomBytes(12).toString('hex')}.tmp`);try{await this.fs.writeFile(temporary,JSON.stringify(selected),{flag:'wx',mode:0o600});await this.safe();await this.fs.rename(temporary,this.file);}finally{await this.fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}return selected;}
}
