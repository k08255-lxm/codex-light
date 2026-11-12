import {MUTATING_REMOTE_METHODS} from './remote.mjs';
import { createHash, randomBytes } from 'node:crypto';
export const MUTATING_METHODS = new Set(['thread/start','turn/start','turn/steer','turn/interrupt','thread/compact/start','thread/name/set','thread/archive','thread/unarchive','thread/fork','review/start',...MUTATING_REMOTE_METHODS]);
const fail = (message,code,outcome='notExecuted',status=409) => Object.assign(new Error(message),{code,outcome,status});
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function classify(error) {
  if(error.outcome)return error.outcome;
  if(['INPUT_BACKPRESSURE','TOO_MANY_REQUESTS'].includes(error.code))return 'notExecuted';
  if(typeof error.code==='number' && [-32600,-32601,-32602].includes(error.code))return 'failed';
  return 'unknown'; // A transport/timeout/internal failure is not proof the operation did not happen.
}
export class OperationStore {
  constructor({serverInstance=randomBytes(16).toString('hex'),retentionMs=86400000,limit=1024,now=Date.now,hooks}={}){
    Object.assign(this,{serverInstance,retentionMs,limit,now});this.entries=new Map();this.hooks=hooks;this.persistenceWarning=null;
  }
  validate(id) {
    if(typeof id!=='string')throw fail('此次操作缺少 requestId，请更新或刷新界面','REQUEST_ID_REQUIRED','notExecuted',400);
    const parts=id.split(':');
    if(parts.length!==3 || !/^\d{13}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{8,100}$/.test(parts[2]))throw fail('requestId 格式无效','INVALID_REQUEST_ID','notExecuted',400);
    if(parts[0]!==this.serverInstance)throw fail('服务已重启，无法确认此前操作结果；不会重发任务','REQUEST_INSTANCE_CHANGED','unknown');
    const timestamp=Number(parts[1]),now=this.now();
    if(timestamp>now+300000)throw fail('请求时间超出本机时钟范围，此请求未发送','REQUEST_IN_FUTURE');
    if(now-timestamp>this.retentionMs)throw fail('请求已过保存期，原结果未知；不会重发任务','REQUEST_EXPIRED','unknown');
    return timestamp;
  }
  prune(){const cutoff=this.now()-this.retentionMs;for(const [id,entry] of this.entries)if(entry.timestamp<cutoff)this.entries.delete(id);}
  execute(id,method,params,run){
    const timestamp=this.validate(id);this.prune();
    const signature=createHash('sha256').update(JSON.stringify(canonical({method,params}))).digest('hex');
    const old=this.entries.get(id);
    if(old){if(old.signature!==signature)throw fail('同一 requestId 不能提交不同内容；未执行第二次操作','REQUEST_ID_CONFLICT','unknown');return old.promise;}
    if(this.entries.size>=this.limit)throw fail('操作记录已满，此请求未发送。请先确认已有任务结果，再重启本地服务','OPERATION_LIMIT');
    const entry={timestamp,signature,method,state:'pending'};
    const meta={requestId:id,method,createdAt:timestamp};
    const finish=async(state,outcome)=>{if(!this.hooks?.after)return;try{await this.hooks.after({...meta,state,outcome});}catch{this.persistenceWarning=entry.persistenceWarning='操作可能已经执行，但最终状态未保存；请人工核对，不能自动重发。';}};
    entry.promise=(async()=>{
      try{await this.hooks?.before(meta);}catch{const e=fail('本机待核对记录无法保存，此次操作未执行','PERSISTENCE_WRITE_FAILED');entry.state='failed';entry.error=e.message;entry.code=e.code;entry.outcome=e.outcome;throw e;}
      let result;
      try{result=await run();}catch(error){
        const e=error instanceof Error?error:new Error(String(error));e.outcome=classify(e);entry.state=e.outcome==='unknown'?'unknown':'failed';entry.error=e.message;entry.code=e.code;entry.outcome=e.outcome;
        await finish(entry.state,e.outcome);throw e;
      }
      entry.state='succeeded';entry.result=structuredClone(result);
      let state='succeeded',outcome='succeeded';
      if(method==='plugin/apply'||method==='git/apply'||method==='config/apply'){
       if(result?.outcome==='unknown'||result?.requiresInspection===true||(method==='git/apply'&&result?.exitCode!==0)){state='inspection';outcome='inspection';}
       else if(['not-executed','notExecuted'].includes(result?.outcome)){state='failed';outcome='notExecuted';}
       else if(result?.outcome!=='succeeded'&&!(method==='git/apply'&&result?.exitCode===0)){state='inspection';outcome='inspection';}
      }
      await finish(state,outcome);return entry.result;
    })();
    this.entries.set(id,entry);return entry.promise;
  }
  get(id){
    try{this.validate(id);}catch(error){return {state:error.outcome==='unknown'?'unknown':'notFound',error:error.message,code:error.code,outcome:error.outcome,serverInstance:this.serverInstance};}
    const entry=this.entries.get(id);
    if(!entry)return {state:'notFound',outcome:'notExecuted',serverInstance:this.serverInstance};
    return {state:entry.state,method:entry.method,...(entry.persistenceWarning?{persistenceWarning:entry.persistenceWarning}:{}),...(entry.state==='succeeded'?{result:entry.result}:{}),...(entry.error?{error:entry.error,code:entry.code,outcome:entry.outcome}:{}),serverInstance:this.serverInstance};
  }
}
