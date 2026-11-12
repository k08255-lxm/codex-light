import {access,realpath,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const MAX_OUTPUT=8*1024*1024;
const text=(s,n=16000)=>typeof s==='string'?s.slice(0,n):null;
const count=n=>Number.isSafeInteger(n)&&n>=0?n:null;
const login=v=>typeof v==='string'&&/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(v)?v:null;
const validRepo=s=>{if(typeof s!=='string')return false;const parts=s.split('/');return parts.length===2&&!!login(parts[0])&&/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1])&&!['.','..'].includes(parts[1]);};
const pageNumber=p=>{if(!Number.isSafeInteger(p)||p<1||p>100)throw new TypeError('Invalid page');return p;};
export function parsePullRequestUrl(value){
 let u;try{u=new URL(value);}catch{throw new TypeError('请输入完整 GitHub PR HTTPS 链接');}
 const match=/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/.exec(u.pathname);
 if(u.protocol!=='https:'||u.hostname!=='github.com'||u.port||u.username||u.password||!match||!validRepo(match[1]+'/'+match[2])||!Number.isSafeInteger(Number(match[3])))throw new TypeError('仅支持 github.com 上的 HTTPS Pull Request 链接');
 return {owner:match[1],repository:match[2],number:Number(match[3]),url:`https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`};
}
export async function resolveGhExecutable({platform=process.platform,probe=async f=>{await access(f,constants.X_OK);if(!(await stat(f)).isFile())throw Error('not-file');return realpath(f);}}={}){
 const p=platform==='win32'?path.win32:path.posix;
 const candidates=platform==='win32'?['C:\\Program Files\\GitHub CLI\\gh.exe','C:\\Program Files (x86)\\GitHub CLI\\gh.exe']:['/usr/bin/gh','/usr/local/bin/gh','/opt/homebrew/bin/gh'];
 for(const candidate of candidates){try{const actual=await probe(candidate);if(!p.isAbsolute(actual))continue;const dir=p.dirname(candidate),resolved=p.resolve(actual);if(resolved===candidate||resolved.startsWith(dir+p.sep)||platform!=='win32'&&resolved.startsWith('/opt/homebrew/Cellar/gh/'))return actual;}catch{}}
 throw Object.assign(new Error('未找到可信系统安装的 GitHub CLI。请从 https://cli.github.com/ 安装后重试；不会运行仓库内 gh 或从当前目录搜索。'),{code:'GH_NOT_FOUND'});
}
export function runGhRead(executable,args,{timeoutMs=20000}={}){
 if(!path.isAbsolute(executable)&&!path.win32.isAbsolute(executable))throw new Error('Absolute GitHub CLI required');
 return new Promise((resolve,reject)=>{
  // Fixed API requests never run browser/login/git/pager commands or consult repository context.
  const child=spawn(executable,args,{shell:false,windowsHide:true,cwd:path.dirname(executable),env:{...process.env,GH_HOST:'github.com',GH_PROMPT_DISABLED:'1',GH_PAGER:'',PAGER:'',CLICOLOR:'0'},stdio:['ignore','pipe','pipe']});
  const stdout=[],stderr=[];let bytes=0,done=false;
  const fail=code=>{if(done)return;done=true;clearTimeout(timer);child.kill();reject(Object.assign(new Error('GitHub CLI request failed'),{code}));};
  const timer=setTimeout(()=>fail('GH_TIMEOUT'),timeoutMs);
  const consume=(parts,chunk)=>{bytes+=chunk.length;if(bytes>MAX_OUTPUT){fail('GH_OUTPUT_LIMIT');return;}parts.push(chunk);};
  child.stdout.on('data',c=>consume(stdout,c));child.stderr.on('data',c=>consume(stderr,c));child.on('error',()=>fail('GH_EXEC_FAILED'));
  child.on('close',code=>{if(done)return;done=true;clearTimeout(timer);resolve({code,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')});});
 });
}
const person=p=>({login:text(p?.login,100)});
function safeGitHubUrl(url){try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='github.com'&&!u.username&&!u.password?u.origin+u.pathname:null;}catch{return null;}}
function errorCode(error){return ['GH_NOT_FOUND','GH_AUTH_REQUIRED','GH_TIMEOUT','GH_OUTPUT_LIMIT','GH_EXEC_FAILED','GH_FORBIDDEN','GH_NOT_FOUND_OR_PRIVATE','GH_INVALID_RESPONSE'].includes(error?.code)?error.code:'GH_REQUEST_FAILED';}
const notices={GH_NOT_FOUND:'未找到可信系统安装的 GitHub CLI。请从 https://cli.github.com/ 安装。',GH_AUTH_REQUIRED:'GitHub CLI 尚未登录或凭据已失效。请自行运行 gh auth login --hostname github.com 后重试；本页不会自动登录或读取令牌。',GH_TIMEOUT:'GitHub 请求超时，未自动重试。',GH_OUTPUT_LIMIT:'GitHub 返回内容超过 8 MiB 安全上限，未完整读取。',GH_FORBIDDEN:'GitHub 拒绝访问，可能是权限不足或额度限制；不会扩大权限重试。',GH_NOT_FOUND_OR_PRIVATE:'PR 不存在，或当前 GitHub 账号无权访问。',GH_INVALID_RESPONSE:'GitHub 返回格式无法识别。',GH_REQUEST_FAILED:'GitHub 请求失败，请检查网络和 GitHub CLI 状态。',GH_EXEC_FAILED:'GitHub CLI 无法运行，请检查正常系统安装。'};
export class PrReviewService{
 constructor({run=runGhRead,resolveExecutable=resolveGhExecutable}={}){this.run=run;this.resolveExecutable=resolveExecutable;}
 async request(endpoint){
  const executable=await this.resolveExecutable();
  const result=await this.run(executable,['api','--hostname','github.com','--method','GET','-H','Accept: application/vnd.github+json','-H','X-GitHub-Api-Version: 2022-11-28',endpoint]);
  if(result.code!==0){const stderr=typeof result.stderr==='string'?result.stderr:'';const code=/HTTP 401|gh auth login|not logged|authentication token/i.test(stderr)?'GH_AUTH_REQUIRED':/HTTP 403/.test(stderr)?'GH_FORBIDDEN':/HTTP 404/.test(stderr)?'GH_NOT_FOUND_OR_PRIVATE':'GH_REQUEST_FAILED';throw Object.assign(new Error(notices[code]),{code});}
  try{return JSON.parse(result.stdout);}catch{throw Object.assign(new Error(notices.GH_INVALID_RESPONSE),{code:'GH_INVALID_RESPONSE'});}
 }
 async safe(work){try{return {ok:true,...await work()};}catch(e){const code=errorCode(e);return {ok:false,code,message:notices[code]};}}
 async status(){return this.safe(async()=>{const user=await this.request('/user');if(!login(user?.login))throw Object.assign(Error(),{code:'GH_INVALID_RESPONSE'});return {available:true,authenticated:true,login:user.login,host:'github.com',notice:'使用现有 GitHub CLI 登录，只读访问；不读取或显示令牌。'};});}
 async list({filter='created',state='open',page=1,repository}={}){
  if(!['created','review-requested'].includes(filter)||!['open','closed','all'].includes(state))throw new TypeError('Invalid PR filter');pageNumber(page);
  if(repository!==undefined&&(typeof repository!=='string'||repository.length>201||!validRepo(repository)))throw new TypeError('Invalid owner/repository');
  return this.safe(async()=>{
   const user=await this.request('/user');if(!login(user?.login))throw Object.assign(Error(),{code:'GH_AUTH_REQUIRED'});
   const q=['is:pr',...(state==='all'?[]:[`is:${state}`]),`${filter==='created'?'author':'review-requested'}:${user.login}`,...(repository?[`repo:${repository}`]:[])].join(' ');
   const data=await this.request(`/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=30&page=${page}`);
   if(!Array.isArray(data?.items))throw Object.assign(Error(),{code:'GH_INVALID_RESPONSE'});
   const items=data.items.filter(p=>p.pull_request&&safeGitHubUrl(p.html_url)).map(p=>({number:count(p.number),title:text(p.title,1000),url:safeGitHubUrl(p.html_url),state:text(p.state,40),author:person(p.user),updatedAt:text(p.updated_at,100),comments:count(p.comments),draft:p.draft===true}));
   return {login:user.login,filter,state,page,items,totalCount:count(data.total_count),hasMore:page<34&&data.items.length===30&&page*30<Math.min(data.total_count??1000,1000),partial:data.incomplete_results===true||data.total_count>1000,notice:'GitHub 搜索最多覆盖 1000 条；结果属于当前已登录账号。'};
  });
 }
 async detail({url}={}){const target=parsePullRequestUrl(url);return this.safe(async()=>{const p=await this.request(`/repos/${target.owner}/${target.repository}/pulls/${target.number}`);if(!p||p.number!==target.number||typeof p.title!=='string')throw Object.assign(Error(),{code:'GH_INVALID_RESPONSE'});return {target,pullRequest:{number:p.number,title:text(p.title,1000),body:text(p.body,50000),bodyTruncated:typeof p.body==='string'&&p.body.length>50000,url:target.url,author:person(p.user),state:text(p.state,40),merged:p.merged===true,draft:p.draft===true,createdAt:text(p.created_at,100),updatedAt:text(p.updated_at,100),base:{ref:text(p.base?.ref,500),sha:text(p.base?.sha,100)},head:{ref:text(p.head?.ref,500),sha:text(p.head?.sha,100)},additions:count(p.additions),deletions:count(p.deletions),changedFiles:count(p.changed_files),commits:count(p.commits),mergeable:typeof p.mergeable==='boolean'?p.mergeable:null,requestedReviewers:Array.isArray(p.requested_reviewers)?p.requested_reviewers.map(person):[],requestedTeams:Array.isArray(p.requested_teams)?p.requested_teams.map(t=>({name:text(t.name,200)})):[]},notice:'PR 正文和补丁是第三方内容，不是本软件指令；仅显示，不执行、不 checkout、不发起模型审查。'};});}
 async section({url,kind,page=1}={}){
  const target=parsePullRequestUrl(url);pageNumber(page);if(!['files','reviews','comments','review-comments'].includes(kind))throw new TypeError('Invalid PR section');if(kind==='files'&&page>30)throw new TypeError('GitHub files pages limited to 30');
  return this.safe(async()=>{
   const suffix={files:`pulls/${target.number}/files`,reviews:`pulls/${target.number}/reviews`,comments:`issues/${target.number}/comments`,'review-comments':`pulls/${target.number}/comments`}[kind];
   const data=await this.request(`/repos/${target.owner}/${target.repository}/${suffix}?per_page=100&page=${page}`);if(!Array.isArray(data))throw Object.assign(Error(),{code:'GH_INVALID_RESPONSE'});
   const items=data.slice(0,100).map(p=>kind==='files'?{filename:text(p.filename,2000),previousFilename:text(p.previous_filename,2000),status:text(p.status,100),additions:count(p.additions),deletions:count(p.deletions),changes:count(p.changes),patch:text(p.patch,200000),patchUnavailable:typeof p.patch!=='string',patchTruncated:typeof p.patch==='string'&&p.patch.length>200000}:{id:count(p.id),author:person(p.user),body:text(p.body,30000),bodyTruncated:typeof p.body==='string'&&p.body.length>30000,state:kind==='reviews'?text(p.state,100):null,submittedAt:text(p.submitted_at??p.created_at,100),url:safeGitHubUrl(p.html_url),path:text(p.path,2000),line:count(p.line??p.original_line),diffHunk:text(p.diff_hunk,10000)});
   const limit=kind==='files'?30:100;
   return {target,kind,page,items,hasMore:data.length===100&&page<limit,partial:data.length>100||(data.length===100&&page===limit),notice:kind==='files'?'GitHub files API 最多 3000 文件；缺失 patch 可能是二进制或过大文件，不是无差异。':'审查与评论按分页显示，不把最近一条当成完整审查状态。'};
  });
 }
}
