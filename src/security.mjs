import { isDeepStrictEqual } from 'node:util';
import { permissionOptions, permissionResponse, formResponse } from '../public/approval-schemas.js';
import path from 'node:path';
export function isAbsoluteWorkingDirectory(value,platform=process.platform){
 if(typeof value!=='string'||!value||value.includes('\0'))return false;
 if(platform==='win32')return /^[A-Za-z]:[\\/]/.test(value)||/^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value);
 return path.isAbsolute(value);
}
const plainObject=value=>!!value && typeof value==='object' && !Array.isArray(value);
const METHODS = new Set(['model/list','thread/list','thread/read','thread/items/list','thread/turns/list','thread/start','thread/resume','thread/unsubscribe','thread/loaded/list','thread/compact/start','skills/list','turn/start','turn/steer','turn/interrupt','mcpServerStatus/list','thread/name/set','thread/archive','thread/unarchive','thread/fork','account/read','account/rateLimits/read','review/start','plugin/list','plugin/read','account/usage/read']);
const fields = {
 'plugin/list':['cwds','marketplaceKinds','forceRefetch'],
 'plugin/read':['pluginName','marketplacePath','remoteMarketplaceName'],
 'account/usage/read':['threadId'],
 'model/list':['cursor','limit'], 'mcpServerStatus/list':['cursor','limit','threadId'],
 'thread/list':['cursor','limit','sortKey','sortDirection','searchTerm','archived'],
 'thread/read':['threadId','includeTurns'],
 'thread/items/list':['threadId','turnId','cursor','limit','sortDirection'],
 'thread/turns/list':['threadId','cursor','limit','sortDirection','itemsView'],
 'thread/start':['cwd','model','approvalPolicy','sandbox'],
 'thread/resume':['threadId','excludeTurns'],
 'thread/unsubscribe':['threadId'],
 'thread/loaded/list':['cursor','limit'],
 'thread/compact/start':['threadId'],
 'skills/list':['cwds','forceReload'],
 'thread/name/set':['threadId','name'],
 'thread/archive':['threadId'],
 'thread/unarchive':['threadId'],
 'thread/fork':['threadId','excludeTurns'],
 'account/read':['refreshToken'],
 'account/rateLimits/read':[],
 'review/start':['threadId','target','delivery'],
 'turn/start':['threadId','input','cwd','model','effort'],
 'turn/steer':['threadId','expectedTurnId','input'],
 'turn/interrupt':['threadId','turnId'],
};
export function validateRpc(method,params,{hasAttachments=false}={}) {
 if(!METHODS.has(method))throw new Error('此 GUI 不提供该 RPC 方法');
 if(!params || typeof params!=='object' || Array.isArray(params))throw new Error('参数格式错误');
 for(const key of Object.keys(params))if(!fields[method].includes(key))throw new Error(`不支持参数 ${key}`);
 for(const key of ['threadId','turnId','expectedTurnId'])if(params[key]!==undefined && (typeof params[key]!=='string'||!params[key]||params[key].length>256||/[\x00-\x1f]/.test(params[key])))throw new Error('对话标识无效');
 if(method.startsWith('turn/') || ['thread/read','thread/items/list','thread/turns/list','thread/resume','thread/unsubscribe','thread/compact/start','thread/name/set','thread/archive','thread/unarchive','thread/fork','review/start'].includes(method))if(!params.threadId)throw new Error('缺少对话标识');
 if(method==='turn/steer'&&!params.expectedTurnId)throw new Error('立即发送需要明确的 expectedTurnId');
 if(params.cursor!==undefined&&params.cursor!==null&&(typeof params.cursor!=='string'||params.cursor.length>4096||params.cursor.includes('\0')))throw new Error('分页游标无效');
 if(method==='skills/list'){
  if(params.forceReload!==undefined&&params.forceReload!==false)throw new Error('技能目录只允许非强制只读查询');
  if(params.cwds!==undefined&&(!Array.isArray(params.cwds)||params.cwds.length>1||params.cwds.some(x=>!isAbsoluteWorkingDirectory(x))))throw new Error('技能发现最多一个绝对工作目录');
 }
 if(method==='account/usage/read'&&params.threadId!==undefined&&!params.threadId)throw new Error('对话标识无效');
 if(method==='plugin/list'){
  if(params.forceRefetch!==false)throw new Error('插件目录只允许非强制只读查询');
  if(params.cwds!==undefined&&(!Array.isArray(params.cwds)||params.cwds.length>1||params.cwds.some(x=>!isAbsoluteWorkingDirectory(x))))throw new Error('插件发现最多一个绝对工作目录');
  if(params.marketplaceKinds!==undefined&&(!Array.isArray(params.marketplaceKinds)||params.marketplaceKinds.length!==1||params.marketplaceKinds[0]!=='local'))throw new Error('不支持的目录过滤');
 }
 if(method==='plugin/read'){
  const valid=x=>typeof x==='string'&&x.length>0&&x.length<=512&&!/[\x00-\x1f]/.test(x);
  if(!valid(params.pluginName)||(params.marketplacePath===undefined)===(params.remoteMarketplaceName===undefined))throw new Error('插件需名称与唯一目录选择器');
  if(params.marketplacePath!==undefined&&(!valid(params.marketplacePath)||!isAbsoluteWorkingDirectory(params.marketplacePath)))throw new Error('插件目录需绝对路径');
  if(params.remoteMarketplaceName!==undefined&&!valid(params.remoteMarketplaceName))throw new Error('远程目录名称无效');
 }
 if(method==='review/start' && (!plainObject(params.target)||params.target.type!=='uncommittedChanges'||Object.keys(params.target).length!==1||params.delivery!=='inline'))throw new Error('此版本只支持在当前对话审查本地未提交改动');
 if(method==='thread/name/set' && (typeof params.name!=='string'||!params.name.trim()||params.name.length>200))throw new Error('对话名称须为1–200字符');
 if(method==='account/read' && params.refreshToken!==undefined && params.refreshToken!==false)throw new Error('此界面只读取账号状态，不主动刷新或更换登录');
 for(const key of ['includeTurns','excludeTurns','archived'])if(params[key]!==undefined&&typeof params[key]!=='boolean')throw new Error('布尔参数无效');
 if(params.limit!==undefined && (!Number.isInteger(params.limit)||params.limit<1||params.limit>100))throw new Error('分页大小须为 1–100');
 if(params.cwd!==undefined && !isAbsoluteWorkingDirectory(params.cwd))throw new Error('工作目录必须为本机绝对路径');
 if(method==='turn/interrupt'&&!params.turnId)throw new Error('停止任务需要明确的 turnId');
 if(method==='thread/start') {
   if(!params.cwd)throw new Error('请选择工作目录');
   if(params.approvalPolicy!==undefined&&!['on-request','untrusted'].includes(params.approvalPolicy))throw new Error('新对话必须保留人工审批');
   if(params.sandbox!==undefined&&!['workspace-write','read-only'].includes(params.sandbox))throw new Error('新对话必须启用沙箱');
 }
 if(method==='turn/start'||method==='turn/steer') {
   if(method==='turn/start'&&!params.cwd)throw new Error('发送前必须确认工作目录');
   if(!Array.isArray(params.input)||params.input.length!==1||params.input[0]?.type!=='text'||typeof params.input[0].text!=='string'||(!params.input[0].text.trim()&&!hasAttachments)||params.input[0].text.length>100000)throw new Error('请输入有效文本（不超过 100000 字符）');
   const item=params.input[0];
   if(Object.keys(item).some(k=>!['type','text','text_elements'].includes(k)))throw new Error('不支持的输入格式');
   if(item.text_elements!==undefined){
    if(!Array.isArray(item.text_elements)||item.text_elements.length>100)throw new Error('文本标记无效');
    const bytes=Buffer.from(item.text,'utf8');
    for(const span of item.text_elements){
     if(!plainObject(span)||Object.keys(span).some(k=>!['byteRange','placeholder'].includes(k))||!plainObject(span.byteRange)||Object.keys(span.byteRange).sort().join(',')!=='end,start')throw new Error('文本标记无效');
     const {start,end}=span.byteRange;
     if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>bytes.length||[start,end].some(offset=>offset<bytes.length&&(bytes[offset]&0xc0)===0x80)||(span.placeholder!==undefined&&span.placeholder!==null&&(typeof span.placeholder!=='string'||span.placeholder.length>1000)))throw new Error('文本标记范围无效');
    }
   }
 }
 if(params.effort!==undefined && (typeof params.effort!=='string'||!/^[-a-zA-Z0-9_]{1,64}$/.test(params.effort)))throw new Error('思考强度无效');
 if(params.model!==undefined && (typeof params.model!=='string'||params.model.length>256))throw new Error('模型标识无效');
 if(params.sortDirection!==undefined&&!['asc','desc'].includes(params.sortDirection))throw new Error('排序方向无效');
 return ['turn/start','turn/steer'].includes(method)?{...params,input:params.input.map(item=>({...item,text_elements:item.text_elements||[]}))}:params;
}
export function validateResponse(request,result) {
 if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('审批结果格式无效');
 const method=request.method;
 if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method)){
   if(!['accept','decline','cancel'].includes(result.decision)||Object.keys(result).length!==1)throw new Error('仅支持本次批准或拒绝');
   const allowed=request.params?.availableDecisions;
   if(Array.isArray(allowed) && !allowed.includes(result.decision))throw new Error('该请求不允许此决定');
 }else if(method==='item/permissions/requestApproval'){
   if(result.scope!=='turn'||!plainObject(result.permissions)||Object.keys(result).some(k=>!['scope','permissions'].includes(k)))throw new Error('权限响应仅支持本次 turn 范围');
   // Empty permissions remain a safe refusal even when the requested schema is unsupported.
   if(Object.keys(result.permissions).length){
    const definition=permissionOptions(request.params);if(!definition.supported)throw new Error(definition.reason);
    const selected=definition.options.filter(option=>option.kind==='network'?result.permissions.network?.enabled===true:Array.isArray(result.permissions.fileSystem?.[option.kind])&&result.permissions.fileSystem[option.kind].includes(option.path)).map(option=>option.id);
    const expected=permissionResponse(request.params,selected);
    if(!isDeepStrictEqual(expected,result))throw new Error('只能授予原请求中明确选择的权限子集，不能扩大或变更结构');
    return expected;
   }
 }else if(method==='mcpServer/elicitation/request'){
   if(Object.keys(result).some(k=>!['action','content','_meta'].includes(k))||(result._meta!==undefined&&result._meta!==null))throw new Error('MCP 响应包含未知字段或元数据');
   if(result.action==='accept')return formResponse(request.params,result.content);
   if(!['decline','cancel'].includes(result.action)||result.content!==null)throw new Error('拒绝或取消时不能携带表单内容');
   return {action:result.action,content:null,_meta:null};
 }else if(method==='item/tool/requestUserInput' || method==='tool/requestUserInput'){
   if(!plainObject(result.answers)||Object.keys(result).length!==1)throw new Error('用户输入格式无效');
   const questions=request.params?.questions || [];
   if(questions.some(q=>!Object.hasOwn(result.answers,q.id)))throw new Error('请回答全部问题');
   for(const [id,answer] of Object.entries(result.answers))if(!questions.some(q=>q.id===id)||!plainObject(answer)||Object.keys(answer).some(k=>k!=='answers')||!Array.isArray(answer?.answers)||answer.answers.length<1||answer.answers.length>20||answer.answers.some(a=>typeof a!=='string'||!a.trim()||a.length>20000))throw new Error('用户输入字段无效');
 }else throw new Error('尚不支持此请求，不能批准');
 return result;
}
