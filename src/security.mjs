import { isDeepStrictEqual } from 'node:util';
import { permissionOptions, permissionResponse, formResponse, approvalDecisions } from '../public/approval-schemas.js';
import path from 'node:path';
export function isAbsoluteWorkingDirectory(value,platform=process.platform){
 if(typeof value!=='string'||!value||value.includes('\0'))return false;
 if(platform==='win32')return /^[A-Za-z]:[\\/]/.test(value)||/^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value);
 return path.isAbsolute(value);
}
const plainObject=value=>!!value && typeof value==='object' && !Array.isArray(value);
export function validApprovalPolicy(value){
 if(['on-request','untrusted','never'].includes(value))return true;
 if(!plainObject(value)||Object.keys(value).join(',')!=='granular'||!plainObject(value.granular))return false;
 const keys=['mcp_elicitations','rules','sandbox_approval','request_permissions','skill_approval'];
 return ['mcp_elicitations','rules','sandbox_approval'].every(key=>typeof value.granular[key]==='boolean')&&Object.entries(value.granular).every(([key,item])=>keys.includes(key)&&typeof item==='boolean');
}
export function validSandboxPolicy(value){
 if(!plainObject(value))return false;
 const keys=value.type==='workspaceWrite'?['type','writableRoots','networkAccess','excludeSlashTmp','excludeTmpdirEnvVar']:value.type==='readOnly'?['type','networkAccess']:value.type==='dangerFullAccess'?['type']:[];
 if(!keys.length||Object.keys(value).some(key=>!keys.includes(key)))return false;
 for(const key of ['networkAccess','excludeSlashTmp','excludeTmpdirEnvVar'])if(value[key]!==undefined&&typeof value[key]!=='boolean')return false;
 return value.writableRoots===undefined||(Array.isArray(value.writableRoots)&&value.writableRoots.length<=100&&value.writableRoots.every(root=>isAbsoluteWorkingDirectory(root)));
}
const METHODS = new Set(['model/list','thread/list','thread/read','thread/items/list','thread/turns/list','thread/start','thread/resume','thread/unsubscribe','thread/loaded/list','thread/compact/start','skills/list','turn/start','turn/steer','turn/interrupt','mcpServerStatus/list','thread/name/set','thread/archive','thread/unarchive','thread/fork','account/read','account/rateLimits/read','review/start','plugin/list','plugin/read','account/usage/read']);
METHODS.add('account/rateLimitResetCredit/consume');
const fields = {
 'account/rateLimitResetCredit/consume':['creditId','idempotencyKey'],
 'plugin/list':['cwds','marketplaceKinds','forceRefetch'],
 'plugin/read':['pluginName','marketplacePath','remoteMarketplaceName'],
 'account/usage/read':['threadId'],
 'model/list':['cursor','limit'], 'mcpServerStatus/list':['cursor','limit','threadId'],
 'thread/list':['cursor','limit','sortKey','sortDirection','searchTerm','archived'],
 'thread/read':['threadId','includeTurns'],
 'thread/items/list':['threadId','turnId','cursor','limit','sortDirection'],
 'thread/turns/list':['threadId','cursor','limit','sortDirection','itemsView'],
 'thread/start':['cwd','model','approvalPolicy','approvalsReviewer','sandbox','serviceTier'],
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
 'account/rateLimits/read':['excludeResetCreditDetails'],
 'review/start':['threadId','target','delivery'],
 'turn/start':['threadId','input','cwd','model','effort','approvalPolicy','approvalsReviewer','sandboxPolicy','serviceTier'],
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
 if(method==='account/rateLimits/read'&&params.excludeResetCreditDetails!==undefined&&typeof params.excludeResetCreditDetails!=='boolean')throw new Error('额度读取参数无效');
 if(method==='account/rateLimitResetCredit/consume'){
  if(typeof params.idempotencyKey!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(params.idempotencyKey))throw new Error('重置操作需要稳定的幂等标识');
  if(typeof params.creditId!=='string'||!params.creditId||params.creditId.length>512||/[\x00-\x1f\x7f]/.test(params.creditId))throw new Error('请选择具体可用的重置卡');
 }
 for(const key of ['includeTurns','excludeTurns','archived'])if(params[key]!==undefined&&typeof params[key]!=='boolean')throw new Error('布尔参数无效');
 if(params.limit!==undefined && (!Number.isInteger(params.limit)||params.limit<1||params.limit>100))throw new Error('分页大小须为 1–100');
 if(params.cwd!==undefined && !isAbsoluteWorkingDirectory(params.cwd))throw new Error('工作目录必须为本机绝对路径');
 if(method==='turn/interrupt'&&!params.turnId)throw new Error('停止任务需要明确的 turnId');
 if(method==='thread/start') {
   if(!params.cwd)throw new Error('请选择工作目录');
   if(params.sandbox!==undefined&&!['workspace-write','read-only','danger-full-access'].includes(params.sandbox))throw new Error('沙箱模式无效');
 }
 if(['thread/start','turn/start'].includes(method)){
  if(params.approvalPolicy!==undefined&&!validApprovalPolicy(params.approvalPolicy))throw new Error('批准策略无效');
  if(params.approvalsReviewer!==undefined&&!['user','auto_review','guardian_subagent'].includes(params.approvalsReviewer))throw new Error('批准审查方无效');
  if(params.serviceTier!==undefined&&!['fast','default'].includes(params.serviceTier))throw new Error('服务速度无效');
  if(params.sandboxPolicy!==undefined&&!validSandboxPolicy(params.sandboxPolicy))throw new Error('沙箱策略无效');
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
   if(Object.keys(result).length!==1)throw new Error('审批结果包含未知字段');
   const allowed=request.params?.availableDecisions;
   const refusal=['decline','cancel'].includes(result.decision)&&(!Array.isArray(allowed)||allowed.includes(result.decision));
   if(!refusal&&!approvalDecisions(method,request.params).some(choice=>isDeepStrictEqual(choice.decision,result.decision)))throw new Error('该请求不允许此决定或规则与原请求不一致');
 }else if(['execCommandApproval','applyPatchApproval'].includes(method)){
   if(Object.keys(result).length!==1)throw new Error('旧版审批结果包含未知字段');
   const decision=result.decision;
   if(decision!=='abort'&&!approvalDecisions(method,request.params).some(choice=>isDeepStrictEqual(choice.decision,decision))&&!(plainObject(decision)&&Object.keys(decision).length===1&&plainObject(decision.denied)&&Object.keys(decision.denied).length===1&&typeof decision.denied.rejection==='string'&&decision.denied.rejection.length<=20000))throw new Error('旧版审批决定无效');
 }else if(method==='item/permissions/requestApproval'){
   if(!['turn','session'].includes(result.scope)||!plainObject(result.permissions)||Object.keys(result).some(k=>!['scope','permissions'].includes(k)))throw new Error('权限响应仅支持 turn 或 session 范围');
   // Empty permissions remain a safe refusal even when the requested schema is unsupported.
   if(Object.keys(result.permissions).length){
    if(typeof request.params?.threadId!=='string'||!request.params.threadId||typeof request.params?.turnId!=='string'||!request.params.turnId)throw new Error('权限授予缺少原请求的对话或任务标识');
    const definition=permissionOptions(request.params);if(!definition.supported)throw new Error(definition.reason);
    // Derive each grant from the shared canonical builder, including modern entries.
    const subset=(wanted,actual)=>Array.isArray(wanted)?Array.isArray(actual)&&wanted.every(value=>actual.some(entry=>isDeepStrictEqual(value,entry))):plainObject(wanted)?plainObject(actual)&&Object.entries(wanted).every(([key,value])=>Object.hasOwn(actual,key)&&subset(value,actual[key])):isDeepStrictEqual(wanted,actual);
    const selected=definition.options.filter(option=>subset(permissionResponse(request.params,[option.id]).permissions,result.permissions)).map(option=>option.id);
    const expected=permissionResponse(request.params,selected,result.scope);
    if(!isDeepStrictEqual(expected,result))throw new Error('只能授予原请求中明确选择的权限子集，不能扩大或变更结构');
    if(result.permissions.fileSystem){const denied=request.params?.permissions?.fileSystem?.entries?.filter(entry=>entry.access==='deny')||[];if(denied.some(entry=>!result.permissions.fileSystem.entries?.some(value=>isDeepStrictEqual(value,entry))))throw new Error('文件权限授予必须保留原请求的全部 deny 限制');}
    return expected;
   }
 }else if(method==='mcpServer/elicitation/request'){
   if(Object.keys(result).some(k=>!['action','content','_meta'].includes(k))||(result._meta!==undefined&&result._meta!==null))throw new Error('MCP 响应包含未知字段或元数据');
   if(result.action==='accept'){
    const kind=request.params?._meta?.codex_approval_kind;
    if(kind!==undefined&&kind!=='mcp_tool_call')throw new Error('此 MCP 审批类型需要专用验证流程，不能作为普通表单批准');
    return formResponse(request.params,result.content);
   }
   if(!['decline','cancel'].includes(result.action)||(result.content!==undefined&&result.content!==null))throw new Error('拒绝或取消时不能携带表单内容');
   return {action:result.action,content:null,_meta:null};
 }else if(method==='item/tool/requestUserInput' || method==='tool/requestUserInput'){
   if(!plainObject(result.answers)||Object.keys(result).length!==1)throw new Error('用户输入格式无效');
   const questions=request.params?.questions;
   if(!Array.isArray(questions)||questions.some(q=>!plainObject(q)||typeof q.id!=='string')||new Set(questions.map(q=>q.id)).size!==questions.length)throw new Error('问题定义无效');
   if(questions.some(q=>!Object.hasOwn(result.answers,q.id)))throw new Error('请回答全部问题');
   for(const [id,answer] of Object.entries(result.answers))if(!questions.some(q=>q.id===id)||!plainObject(answer)||Object.keys(answer).some(k=>k!=='answers')||!Array.isArray(answer?.answers)||answer.answers.length>20||answer.answers.some(a=>typeof a!=='string'||a.length>20000))throw new Error('用户输入字段无效');
 }else throw new Error('尚不支持此请求，不能批准');
 return result;
}
