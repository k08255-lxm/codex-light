import {DshTaskStore,isDshItem,dshToolResultAgentId,dshToolResultParentThreadId,dshResultError,dshFilterListResult,dshSafeStatusResult,dshListSnapshot,dshStatusSnapshot} from '../public/dsh.js';
import {isAbsoluteWorkingDirectory} from './security.mjs';
import {DshReaderSession} from './dsh-reader-session.mjs';
import {DshChangeReader} from './dsh-changes.mjs';

const READ_TOOLS={status:'dsh_status',events:'dsh_events',changes:'dsh_events'};
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
 constructor(rpc){this.rpc=rpc;this.reader=new DshReaderSession(rpc);this.changes=new DshChangeReader();this.threads=new Map();this.bindings=new Map();this.observed=new Map();this.provenance=new Map();this.pending=new Map();this.generation=0;this.sequence=0;}
 get releaseError(){return this.reader.releaseError?.message||null;}
 isReaderThread(id){return this.reader.isReaderThread(id);}
 _store(threadId){
  let store=this.threads.get(threadId);
  if(!store){store=new DshTaskStore(100);store.reset(threadId);this.threads.set(threadId,store);}
  return store;
 }
 _observed(threadId){
  let ids=this.observed.get(threadId);
  if(!ids){ids=new Set();this.observed.set(threadId,ids);}
  return ids;
 }
 _observeId(threadId,agentId){
  if(!boundedString(agentId))return;
  const ids=this._observed(threadId);ids.add(agentId);
  while(ids.size>500)ids.delete(ids.values().next().value);
 }
 _touch(threadId){
  const store=this.threads.get(threadId);
  if(store){this.threads.delete(threadId);this.threads.set(threadId,store);}
  const ids=this.observed.get(threadId);
  if(ids){this.observed.delete(threadId);this.observed.set(threadId,ids);}
  const cwd=this.bindings.get(threadId);
  if(cwd!==undefined){this.bindings.delete(threadId);this.bindings.set(threadId,cwd);}
  // Last visited 100 threads only; older tasks can be re-bound by reading history.
  while(this.threads.size>100){
   const oldest=this.threads.keys().next().value;
   this.threads.delete(oldest);this.bindings.delete(oldest);this.observed.delete(oldest);
  }
 }
 bindThread(thread){
  if(!plainObject(thread))return false;
  const {id,cwd}=thread;
  if(!boundedString(id)||typeof cwd!=='string'||cwd.length>MAX_CWD||/[\x00-\x1f\x7f]/.test(cwd)||!isAbsoluteWorkingDirectory(cwd))return false;
  // The same thread id must not retain tasks observed under a different working directory.
  if(this.bindings.has(id)&&this.bindings.get(id)!==cwd){this.threads.get(id)?.reset(id);this.observed.delete(id);}
  this._store(id);this.bindings.set(id,cwd);this._touch(id);
  return true;
 }
 observe(threadId,item,{older=false}={}){
  if(!boundedString(threadId)||!isDshItem(item))return;
  // Only a direct tool call naming an agent (or legacy parent_thread_id) is provenance.
  // A cwd listing is discovery metadata and must never expand this thread's ownership set.
  if(item.tool!=='dsh_list'){
   let input=item.arguments;
   if(typeof input==='string'){try{input=JSON.parse(input);}catch{input=null;}}
   const args=plainObject(input)?input:{};
   const fromArgs=typeof args.agent_id==='string'?args.agent_id:'';
   const returned=dshToolResultAgentId(item.result);
   const parent=dshToolResultParentThreadId(item.result);
   const usable=returned&&returned!=='conflict'?returned:'';
   if(!parent||parent===threadId){
    if(!(fromArgs&&usable&&fromArgs!==usable))this._observeId(threadId,fromArgs||usable);
   }
  }
  this._store(threadId).ingest(threadId,item,{older});this._touch(threadId);
 }
 _connected(){if(this.rpc?.connected===false)throw new Error('Codex 尚未连接');}
 _settle(threadId,generation,tool,argumentsValue,result,{expectedAgentId=null}={}){
  if(generation!==this.generation)throw new Error(STALE);
  const store=this.threads.get(threadId);
  if(!store)throw new Error(STALE);
  const toolError=dshResultError(result);if(toolError)throw new Error(toolError);
  const parentThreadId=dshToolResultParentThreadId(result);
  if(parentThreadId&&parentThreadId!==threadId)throw new Error('DSH 返回了其他父对话，已丢弃');
  const returnedAgentId=dshToolResultAgentId(result);
  if(expectedAgentId&&returnedAgentId&&returnedAgentId!==expectedAgentId)throw new Error('DSH 返回了其他任务，已丢弃');
  if(tool==='dsh_list')store.ingestLiveList(threadId,dshListSnapshot(result),{cwd:this.bindings.get(threadId)});
  else store.ingest(threadId,{id:`dsh-bridge:${++this.sequence}`,type:'mcpToolCall',server:'dsh_subagent',tool,arguments:argumentsValue,status:'completed',result});
  if(expectedAgentId)this._observeId(threadId,expectedAgentId);
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
  const request=this.reader.call(cwd,'dsh_list',argumentsValue);
  let operation;
  operation=Promise.resolve(request).then(async result=>{
   if(generation!==this.generation||this.bindings.get(threadId)!==cwd)throw new Error(STALE);
   const toolError=dshResultError(result);if(toolError)throw new Error(toolError);
   const listing=dshListSnapshot(result);
   if(!listing.available)throw new Error('DSH 列表返回格式无法识别');
   const enriched=[];
   for(const row of listing.items){
    if(generation!==this.generation||this.bindings.get(threadId)!==cwd)throw new Error(STALE);
    let proof=this.provenance.get(row.agent_id);
    // Compact listings omit parent_thread_id. Resolve it once per task/update instead
    // of depending on whether its old spawn message happens to be loaded in the UI.
    if(!proof||proof.cwd!==cwd||proof.updatedAt!==row.updated_at){
     const statusResult=await this.reader.call(cwd,'dsh_status',{agent_id:row.agent_id,legacy:true});
     if(generation!==this.generation||this.bindings.get(threadId)!==cwd)throw new Error(STALE);
     const statusError=dshResultError(statusResult);if(statusError)throw new Error(statusError);
     const returned=dshToolResultAgentId(statusResult);
     if(returned&&returned!==row.agent_id)throw new Error('DSH 返回了其他任务，已丢弃');
     proof={cwd,parent:dshToolResultParentThreadId(statusResult),updatedAt:row.updated_at,status:dshStatusSnapshot(statusResult)};
     this.provenance.set(row.agent_id,proof);
     while(this.provenance.size>500)this.provenance.delete(this.provenance.keys().next().value);
    }
    if(proof.parent===threadId)this._observeId(threadId,row.agent_id);
    if(proof.parent&&proof.parent!==threadId)continue;
    if(this._observed(threadId).has(row.agent_id))enriched.push({...row,...(proof.status.available?proof.status:{})});
   }
   const filtered=dshFilterListResult({structuredContent:{...listing,items:enriched}},this._observed(threadId));
   if(!filtered)throw new Error('DSH 列表返回格式无法识别');
   this._settle(threadId,generation,'dsh_list',argumentsValue,filtered);
   return {threadId,cwd,tool:'dsh_list',result:filtered,checkedAt:new Date().toISOString()};
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
  if(!this.observed.get(threadId)?.has(agentId))throw new Error('此对话尚未观察到该 DSH 任务，请先加载对应任务历史');
  const bindingCwd=this.bindings.get(threadId);
  if(!bindingCwd)throw new Error('此对话尚未绑定真实工作目录');
  const generation=this.generation;
  const argumentsValue=kind==='status'
   ?{agent_id:agentId,legacy:true}
   :{agent_id:agentId,include_progress:true,include_tool_events:true,include_descendants:true,limit:100,max_chars:12000,...(hasAfter?{after}:{})};
  const key=JSON.stringify(['read',threadId,agentId,kind,hasAfter?after:null]);
  if(this.pending.has(key))return this.pending.get(key);
  if(this.pending.size>=MAX_PENDING)throw new Error('同时查询过多，请等待已有查询结束');
  const cachedProof=this.provenance.get(agentId),proof=cachedProof?.cwd===bindingCwd?cachedProof:null;
  const request=kind==='changes'
   ?this.changes.read(`${threadId}:${agentId}`,agentId,(name,args)=>{
     if(generation!==this.generation||this.bindings.get(threadId)!==bindingCwd)throw new Error(STALE);
     return this.reader.call(bindingCwd,name,args);
    },{status:proof?.status?.status,updatedAt:proof?.updatedAt})
   :this.reader.call(bindingCwd,tool,argumentsValue);
  let operation;
  operation=Promise.resolve(request).then(result=>{
   if(generation!==this.generation)throw new Error(STALE);
   if(this.bindings.get(threadId)!==bindingCwd)throw new Error(STALE);
   if(!this.observed.get(threadId)?.has(agentId))throw new Error(STALE);
   if(kind==='status'){
    const toolError=dshResultError(result);if(toolError)throw new Error(toolError);
    const parentThreadId=dshToolResultParentThreadId(result);
    if(parentThreadId&&parentThreadId!==threadId)throw new Error('DSH 返回了其他父对话，已丢弃');
    const safe=dshSafeStatusResult(result);
    if(!safe)throw new Error('DSH 状态返回格式无法识别');
    result=safe;
   }
   if(kind!=='changes')this._settle(threadId,generation,tool,argumentsValue,result,{expectedAgentId:agentId});
   return {threadId,agentId,tool,result,checkedAt:new Date().toISOString()};
  }).finally(()=>{if(this.pending.get(key)===operation)this.pending.delete(key);});
  this.pending.set(key,operation);return operation;
 }
 clear(){this.generation++;this.threads.clear();this.bindings.clear();this.observed.clear();this.provenance.clear();this.changes.clear();this.pending.clear();return this.reader.clear();}
 close(){this.generation++;this.threads.clear();this.bindings.clear();this.observed.clear();this.provenance.clear();this.changes.clear();this.pending.clear();return this.reader.close();}
}
