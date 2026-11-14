import path from 'node:path';
import {spawnSync} from 'node:child_process';
const fail=message=>Object.assign(new Error(message),{code:'DSH_WSL_PATH_UNSUPPORTED'});
const safe=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\x00-\x1f\x7f]/.test(value);
export function windowsWorkspace(value,distribution,{run=spawnSync,env=process.env,user}={}) {
 if(!safe(value)||!value.startsWith('/')||value.startsWith('//')||value.split('/').some(x=>x==='..'||x==='.')||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(distribution))throw fail('Pass the current absolute WSL workspace path');
 if(user!==undefined&&! /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(user))throw fail('Invalid WSL user');
 const command=path.win32.join(env.SystemRoot||'C:\\Windows','System32','wsl.exe');
 const result=run(command,['--distribution',distribution,...(user?['--user',user]:[]),'--exec','wslpath','-a','-w',value],{encoding:'utf8',timeout:10000,maxBuffer:8192,windowsHide:true,shell:false});
 const output=String(result.stdout||'').trim();
 if(result.error||result.status!==0||!safe(output)||! /^[A-Za-z]:\\/.test(output))throw fail('Windows DSH supports Windows-drive workspaces only. For Linux /home projects choose DSH inside WSL; the workspace was not changed.');
 const round=run(command,['--distribution',distribution,...(user?['--user',user]:[]),'--exec','wslpath','-a','-u',output],{encoding:'utf8',timeout:10000,maxBuffer:8192,windowsHide:true,shell:false});
 if(round.error||round.status!==0||String(round.stdout||'').trim()!==value.replace(/\/$/,''))throw fail('WSL workspace mapping is ambiguous; the workspace was not changed');
 return output;
}
export function mapWindowsRequest(message,distribution,options){
 if(message?.method!=='tools/call'||!['dsh_start','dsh_list'].includes(message.params?.name)||message.params?.arguments?.cwd===undefined)return message;
 return {...message,params:{...message.params,arguments:{...message.params.arguments,cwd:windowsWorkspace(message.params.arguments.cwd,distribution,options)}}};
}
export function parseWindowsLaunch(encoded){
 let value;try{if(typeof encoded!=='string'||encoded.length>20000)throw Error();value=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));}catch{throw Error('Invalid Windows bridge launch configuration');}
 if(!value||!['config,data,distribution,state,user','config,data,distribution,queueDescriptor,state,user'].includes(Object.keys(value).sort().join(','))||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.distribution)||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.user)||![value.config,value.data,value.state].every(x=>safe(x)&&/^[A-Za-z]:[\\/]/.test(x)))throw Error('Invalid Windows bridge launch configuration');
 if(value.queueDescriptor!==undefined&&(!safe(value.queueDescriptor)||!/^[A-Za-z]:[\\/]/.test(value.queueDescriptor)))throw Error('Invalid callback queue descriptor path');
 return value;
}
export function assertQueueCapability(result){
 if(result?.capabilities?.experimental?.codecangCallbackQueue?.version!==1)throw Error('The running DSH bridge does not support this GUI completion queue. Restart the bridge after existing tasks finish; no fallback to a different Codex instance was attempted.');
}
