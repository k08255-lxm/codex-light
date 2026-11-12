import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
export function inspectPushUrl(raw){
 if(typeof raw!=='string'||!raw||/[\x00-\x20\x7f]/.test(raw))throw new Error('推送目标格式无效');
 if(raw.startsWith('https://')||raw.startsWith('ssh://')){const url=new URL(raw);if(!url.hostname||url.password||url.search||url.hash||(url.protocol==='https:'&&url.username))throw new Error('推送 URL 不允许凭据、query 或 fragment');if(url.protocol==='ssh:'&&url.username&&!/^[a-zA-Z0-9._-]+$/.test(url.username))throw new Error('SSH 用户名格式不支持');if(!url.pathname||url.pathname==='/')throw new Error('推送仓库路径缺失');return {host:url.host,path:url.pathname,transport:url.protocol.slice(0,-1)};}
 const match=/^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+):([^?#]+)$/.exec(raw);if(match&&match[2].includes('.')&&!/^[A-Za-z]:/.test(raw)&&!match[3].startsWith('//'))return {host:match[2],path:match[3],transport:'ssh'};
 throw new Error('仅支持明确的 HTTPS/SSH 远程仓库；不支持 file、ext 或其他 remote helper');
}
export async function inspectPushTarget(root,query,{parseUrl=inspectPushUrl}={}){
 const branch=(await query(root,['symbolic-ref','--quiet','--short','HEAD'])).stdout.trim();if(!branch||/[\x00-\x20\x7f]/.test(branch))throw new Error('推送需要有效本地分支，不能 detached HEAD');
 const remote=(await query(root,['config','--get',`branch.${branch}.remote`])).stdout.trim();if(!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(remote))throw new Error('需要单一明确的 upstream remote');
 const merge=(await query(root,['config','--get',`branch.${branch}.merge`])).stdout.trim();if(!merge.startsWith('refs/heads/')||/[\x00-\x20\x7f]/.test(merge))throw new Error('需要唯一 upstream 分支');await query(root,['check-ref-format',merge]);
 const urls=(await query(root,['remote','get-url','--push','--all',remote])).stdout.trim().split('\n').filter(Boolean);if(urls.length!==1)throw new Error('推送需要唯一 push URL，不会猜测目标');const target=parseUrl(urls[0]);
 const upstream=(await query(root,['rev-parse','--symbolic-full-name','@{upstream}'])).stdout.trim();if(!upstream.startsWith('refs/remotes/'))throw new Error('不支持本地 upstream');
 const head=(await query(root,['rev-parse','--verify','HEAD'])).stdout.trim(),upstreamOid=(await query(root,['rev-parse','--verify',upstream])).stdout.trim();
 if(!/^[a-f0-9]{40,64}$/.test(head)||!/^[a-f0-9]{40,64}$/.test(upstreamOid))throw new Error('无法核实推送提交');
 const count=(await query(root,['rev-list','--count',`${upstreamOid}..${head}`])).stdout.trim();if(!/^\d+$/.test(count))throw new Error('待推提交计数无效');
 const commits=(await query(root,['log','--format=%h %s','--max-count=100',`${upstreamOid}..${head}`,'--'])).stdout.trim().split('\n').filter(Boolean);
 const config=(await query(root,['config','--get-regexp','^(remote\\.|branch\\.|url\\.|push\\.|core\\.sshCommand|ssh\\.)'],[0,1])).stdout;
 return {branch,remote,targetBranch:merge,upstream,head,upstreamOid,target,commitCount:Number(count),commits,truncated:Number(count)>100,fingerprint:digest(JSON.stringify({branch,remote,merge,upstream,head,upstreamOid,urls,config}))};
}
export function pushArgv(target){return ['-c',`remote.${target.remote}.mirror=false`,'push','--porcelain','--no-force','--no-follow-tags','--no-mirror','--recurse-submodules=no',target.remote,`HEAD:${target.targetBranch}`];}
