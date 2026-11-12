// Parameter-only boundary. No RPC, model call, credential storage or remote activation.
export const REMOTE_METHODS = new Set([
 'remoteControl/status/read','remoteControl/enable','remoteControl/disable',
 'remoteControl/pairing/start','remoteControl/pairing/status',
 'remoteControl/client/list','remoteControl/client/revoke',
]);
export const MUTATING_REMOTE_METHODS = new Set([
 'remoteControl/enable','remoteControl/disable','remoteControl/pairing/start','remoteControl/client/revoke',
]);
const fields = {
 'remoteControl/status/read':[],
 'remoteControl/enable':['ephemeral'], 'remoteControl/disable':['ephemeral'],
 'remoteControl/pairing/start':['manualCode'],
 'remoteControl/pairing/status':['pairingCode','manualPairingCode'],
 'remoteControl/client/list':['environmentId','cursor','limit','order'],
 'remoteControl/client/revoke':['environmentId','clientId'],
};
function reject(message,code='REMOTE_INVALID_PARAMS'){
 throw Object.assign(new Error(message),{code,outcome:'notExecuted'});
}
function identifier(value,name,max=1024){
 if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))reject(`远程控制 ${name} 无效`);
 return value;
}
export function validateRemote(method,params={},options={}){
 if(!REMOTE_METHODS.has(method))reject('未知远程控制操作','REMOTE_METHOD_NOT_ALLOWED');
 if(!params||typeof params!=='object'||Array.isArray(params)||![Object.prototype,null].includes(Object.getPrototypeOf(params)))reject('远程控制参数必须为普通对象');
 for(const key of Object.keys(params))if(!fields[method].includes(key))reject(`不支持的远程控制参数 ${key}`);
 if(MUTATING_REMOTE_METHODS.has(method)&&options.confirmed!==true)reject('此远程控制操作需要明确确认','REMOTE_CONFIRMATION_REQUIRED');
 const out={...params};
 if(method==='remoteControl/enable'||method==='remoteControl/disable'){
  if(params.ephemeral!==undefined&&typeof params.ephemeral!=='boolean')reject('ephemeral 必须为布尔值');
  out.ephemeral=params.ephemeral??true;
 }
 if(method==='remoteControl/pairing/start'&&params.manualCode!==undefined&&typeof params.manualCode!=='boolean')reject('manualCode 必须为布尔值');
 if(method==='remoteControl/pairing/status'){
  const codes=['pairingCode','manualPairingCode'].filter(key=>params[key]!==undefined&&params[key]!==null);
  if(codes.length!==1)reject('配对状态查询必须且只能提供一种配对码');
  identifier(params[codes[0]],codes[0],4096);
 }
 if(method==='remoteControl/client/list'||method==='remoteControl/client/revoke'){
  identifier(params.environmentId,'environmentId');
  if(!options.activeEnvironmentId||params.environmentId!==options.activeEnvironmentId)reject('远程环境与已确认状态不一致','REMOTE_UNKNOWN_ENVIRONMENT');
 }
 if(method==='remoteControl/client/list'){
  if(params.cursor!==undefined&&params.cursor!==null)identifier(params.cursor,'cursor',4096);
  if(params.limit!==undefined&&params.limit!==null&&(!Number.isInteger(params.limit)||params.limit<1||params.limit>100))reject('客户端分页大小须为 1–100');
  if(params.order!==undefined&&params.order!==null&&!['asc','desc'].includes(params.order))reject('客户端排序无效');
 }
 if(method==='remoteControl/client/revoke'){
  identifier(params.clientId,'clientId');
  // A syntactically valid arbitrary ID is not a client the user selected.
  const ids=options.allowedClientIds;
  if(!options.activeEnvironmentId || !(ids instanceof Set?ids.has(params.clientId):Array.isArray(ids)&&ids.includes(params.clientId)))reject('客户端尚未在当前环境的已读取列表中确认','REMOTE_UNKNOWN_CLIENT');
 }
 return out;
}
