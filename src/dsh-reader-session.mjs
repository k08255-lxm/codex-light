import path from 'node:path';
import {isAbsoluteWorkingDirectory} from './security.mjs';

const tools=new Set(['dsh_list','dsh_status','dsh_events']);
const stale=()=>Object.assign(new Error('DSH 读取会话已失效，请重新查询'),{code:'DSH_READER_STALE'});
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x20\x7f]/.test(value);
/** One serialized, ephemeral MCP context. Never resumes user threads or starts a model turn. */
export class DshReaderSession {
 constructor(rpc){this.rpc=rpc;this.lease=null;this.queue=Promise.resolve();this.generation=0;this.connectionEpoch=0;this.closed=false;this.queued=0;this.releaseError=null;this.unknownStart=false;this.ids=new Set();}
 isReaderThread(id){return this.ids.has(id);}
 _serial(run){
  const operation=this.queue.then(run,run);
  // Retain failures on their caller; the queue itself must still permit an explicit cleanup retry.
  this.queue=operation.then(()=>{},()=>{});
  return operation;
 }
 _connected(){if(this.rpc?.connected===false)throw Object.assign(new Error('Codex 尚未连接，无法查询 DSH'),{code:'NOT_CONNECTED'});}
 async _release(){
  const lease=this.lease;
  if(this.unknownStart&&this.rpc?.connected!==false)throw this.releaseError;
  if(!lease){this.releaseError=null;return;}
  if(this.rpc?.connected===false){this.lease=null;this.releaseError=null;return;}
  const epoch=this.connectionEpoch;
  try{
   await this.rpc.call('thread/unsubscribe',{threadId:lease.id});
   if(this.lease===lease)this.lease=null;
   this.releaseError=null;
  }catch(cause){
   if(epoch!==this.connectionEpoch)return;
   if(this.rpc?.connected===false){if(this.lease===lease)this.lease=null;this.releaseError=null;return;}
   this.releaseError=Object.assign(new Error('DSH 内部读取会话未能释放：'+(cause?.message||'未知错误')),{code:'DSH_READER_RELEASE_FAILED',cause});
   throw this.releaseError;
  }
 }
 async _ensure(cwd,generation,epoch){
  if(generation!==this.generation||this.closed)throw stale();
  this._connected();
  if(this.releaseError)throw this.releaseError;
  const key=process.platform==='win32'?path.resolve(cwd).toLowerCase():path.resolve(cwd);
  if(this.lease?.key===key)return this.lease;
  await this._release();
  if(generation!==this.generation||this.closed)throw stale();
  let result;
  try{result=await this.rpc.call('thread/start',{cwd,ephemeral:true,sandbox:'read-only',approvalPolicy:'never'});}
  catch(cause){
   if(cause?.code==='RPC_TIMEOUT'&&epoch===this.connectionEpoch&&this.rpc?.connected!==false){this.unknownStart=true;this.releaseError=Object.assign(new Error('DSH 内部读取会话初始化结果未知，不能重复创建；请重新连接本应用的 Codex 引擎。'),{code:'DSH_READER_START_UNKNOWN',cause});throw this.releaseError;}
   throw cause;
  }
  const id=result?.thread?.id;
  if(!validId(id))throw new Error('Codex 未返回有效的 DSH 内部读取会话标识');
  if(epoch!==this.connectionEpoch||this.rpc?.connected===false)throw stale();
  this.ids.add(id);while(this.ids.size>128)this.ids.delete(this.ids.values().next().value);
  // Keep a successfully created but superseded lease for the queued clear/close to release.
  this.lease={id,cwd,key};
  if(generation!==this.generation||this.closed)throw stale();
  return this.lease;
 }
 call(cwd,tool,args){
  if(this.closed)return Promise.reject(stale());
  if(!isAbsoluteWorkingDirectory(cwd)||cwd.length>4096||/[\x00-\x1f\x7f]/.test(cwd)||!tools.has(tool))return Promise.reject(new Error('DSH 内部只读查询参数无效'));
  if(this.queued>=16)return Promise.reject(new Error('DSH 读取队列已满，请等待已有查询结束'));
  const generation=this.generation,epoch=this.connectionEpoch;this.queued++;
  return this._serial(async()=>{
   const lease=await this._ensure(cwd,generation,epoch);
   if(generation!==this.generation||this.closed)throw stale();
   const result=await this.rpc.call('mcpServer/tool/call',{threadId:lease.id,server:'dsh_subagent',tool,arguments:args});
   if(generation!==this.generation||this.closed)throw stale();
   return result;
  }).finally(()=>{this.queued--;});
 }
 clear(){
  this.generation++;
  if(this.rpc?.connected===false){this.connectionEpoch++;this.lease=null;this.releaseError=null;this.unknownStart=false;return Promise.resolve();}
  return this._serial(()=>this._release());
 }
 close(){this.closed=true;return this.clear();}
}
