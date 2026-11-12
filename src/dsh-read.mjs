import {DshTaskStore,isDshItem} from '../public/dsh.js';
import {isAbsoluteWorkingDirectory} from './security.mjs';

const READ_TOOLS={status:'dsh_status',events:'dsh_events'};
const MAX_PENDING=16;
const MAX_ID=200;
const MAX_CWD=4096;
const STALE='DSH 查询已失效，请重新加载';
const plainObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function strictKeys(input,allowed){
 if(!plainObject(input))throw new Error('DSH 查询参数无效');
 for(const key of Object.keys(input))if(!allowed.includes(key))throw new Error(`不支持参数 ${key}`);
}
function boundedString(value,max=MAX_ID){
 return typeof value==='string'&&value.length>0&&value.length<=max&&value.trim().length>0&&!/[\x00-\x1f\x7f]/.test(value);
}
function requireId(value,label){
 if(!boundedString(value))throw new Error(`${label}无效`);
 return value;
}
function mcpError(result,fallback){
 const text=Array.isArray(result?.content)?result.content.filter(block=>block?.type==='text').map(block=>block.text).join('\n'):'';
 return new Error((text||fallback).slice(0,4000));
}
function validateCursor(value){
 if(typeof value==='number'){
  if(!Number.isSafeInteger(value)||value<0)throw new Error('分页游标须为非负安全整数或 digits:digits:digits');
  return value;
 }
 if(typeof value==='string'&&value.length<=100&&/^\d+:\d+:\d+$/.test(value))return value;
 throw new Error('分页游标须为非负安全整数或 digits:digits:digits');
}
/** Bound to task IDs observed in this Codex thread. This is provenance against accidental
 * cross-thread mixups, not a sandbox or proof of the external tool server's honesty. */
export class DshReadService {
 constructor(rpc){this.rpc=rpc;this.threads=new Map();this.bindings=new Map();this.pending=new Map();this.generation=0;this.sequence=0;}
 _store(threadId){
  let store=this.threads.get(threadId);
  if(!store){store=new DshTaskStore(100);store.reset(threadId);this.threads.set(threadId,store);}
  return store;
 }
 _touch(threadId){
  const store=this.threads.get(threadId);
  if(store){this.threads.delete(threadId);this.threads.set(threadId,store);}
  const cwd=this.bindings.get(threadId);
  if(cwd!==undefined){this.bindings.delete(threadId);this.bindings.set(threadId,cwd);}
  // Last visited 100 threads only; older tasks can be re-bound by reading history.
  while(this.threads.size>100){
   const oldest=this.threads.keys().next().value;
   this.threads.delete(oldest);this.bindings.delete(oldest);
  }
 }
 bindThread(thread){
  if(!plainObject(thread))return false;
  const {id,cwd}=thread;
  if(!boundedString(id)||typeof cwd!=='string'||cwd.length>MAX_CWD||/[\x00-\x1f\x7f]/.test(cwd)||!isAbsoluteWorkingDirectory(cwd))return false;
  this._store(id);this.bindings.set(id,cwd);this._touch(id);
  return true;
 }
 observe(threadId,item,{older=false}={}){
  if(!boundedString(threadId)||!isDshItem(item))return;
  this._store(threadId).ingest(threadId,item,{older});this._touch(threadId);
 }
 _connected(){if(this.rpc?.connected===false)throw new Error('Codex 尚未连接');}
 _settle(threadId,generation,tool,argumentsValue,result){
  if(generation!==this.generation)throw new Error(STALE);
  const store=this.threads.get(threadId);
  if(!store)throw new Error(STALE);
  if(result?.isError)throw mcpError(result,'DSH 工具返回错误');
  store.ingest(threadId,{id:`dsh-bridge:${++this.sequence}`,type:'mcpToolCall',server:'dsh_subagent',tool,arguments:argumentsValue,status:'completed',result});
 }
 async monitor(input){
  strictKeys(input,['threadId']);
  const threadId=requireId(input.threadId,'对话标识');
  const cwd=this.bindings.get(threadId);
  if(!cwd)throw new Error('此对话尚未绑定真实工作目录');
  this._connected();
  const generation=this.generation;
  const key=JSON.stringify(['monitor',threadId]);
  if(this.pending.has(key))return this.pending.get(key);
  if(this.pending.size>=MAX_PENDING)throw new Error('同时查询过多，请等待已有查询结束');
  const argumentsValue={cwd,legacy:false,limit:50,max_chars:16000};
  const request=this.rpc.call('mcpServer/tool/call',{
   threadId,server:'dsh_subagent',tool:'dsh_list',arguments:argumentsValue,
  });
  let operation;
  operation=Promise.resolve(request).then(result=>{
   if(generation!==this.generation||this.bindings.get(threadId)!==cwd)throw new Error(STALE);
   this._settle(threadId,generation,'dsh_list',argumentsValue,result);
   return {threadId,cwd,tool:'dsh_list',result,checkedAt:new Date().toISOString()};
  }).finally(()=>{if(this.pending.get(key)===operation)this.pending.delete(key);});
  this.pending.set(key,operation);return operation;
 }
 async read(input){
  strictKeys(input,['threadId','agentId','kind','after']);
  const threadId=requireId(input.threadId,'对话标识');
  const agentId=requireId(input.agentId,'任务标识');
  const kind=input.kind;
  const tool=typeof kind==='string'?READ_TOOLS[kind]:null;
  if(!tool)throw new Error('仅允许读取 DSH 状态或事件');
  const hasAfter=input.after!==undefined;
  if(hasAfter&&kind!=='events')throw new Error('仅事件读取支持分页游标');
  const after=hasAfter?validateCursor(input.after):undefined;
  this._connected();
  const store=this.threads.get(threadId);
  if(!store?.values().some(task=>task.agentId===agentId))throw new Error('此对话尚未观察到该 DSH 任务，请先加载对应任务历史或列表');
  const generation=this.generation;
  const argumentsValue=kind==='status'
   ?{agent_id:agentId,legacy:false}
   :{agent_id:agentId,include_progress:true,include_tool_events:true,include_descendants:true,limit:100,max_chars:12000,...(hasAfter?{after}:{})};
  const key=JSON.stringify(['read',threadId,agentId,kind,hasAfter?after:null]);
  if(this.pending.has(key))return this.pending.get(key);
  if(this.pending.size>=MAX_PENDING)throw new Error('同时查询过多，请等待已有查询结束');
  const request=this.rpc.call('mcpServer/tool/call',{
   threadId,server:'dsh_subagent',tool,arguments:argumentsValue,
  });
  let operation;
  operation=Promise.resolve(request).then(result=>{
   if(generation!==this.generation)throw new Error(STALE);
   const current=this.threads.get(threadId);
   if(!current?.values().some(task=>task.agentId===agentId))throw new Error(STALE);
   this._settle(threadId,generation,tool,argumentsValue,result);
   return {threadId,agentId,tool,result,checkedAt:new Date().toISOString()};
  }).finally(()=>{if(this.pending.get(key)===operation)this.pending.delete(key);});
  this.pending.set(key,operation);return operation;
 }
 clear(){this.generation++;this.threads.clear();this.bindings.clear();this.pending.clear();}
}
