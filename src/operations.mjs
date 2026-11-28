import {MUTATING_REMOTE_METHODS} from './remote.mjs';
import { createHash, randomBytes } from 'node:crypto';
export const MUTATING_METHODS = new Set(['thread/start','turn/start','turn/steer','turn/interrupt','thread/compact/start','thread/name/set','thread/archive','thread/unarchive','thread/delete','thread/summary','thread/fork','review/start',...MUTATING_REMOTE_METHODS]);
MUTATING_METHODS.add('account/rateLimitResetCredit/consume');
MUTATING_METHODS.add('turn/settings/update');
MUTATING_METHODS.add('app-update/download');MUTATING_METHODS.add('app-update/install');
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
  constructor({serverInstance=randomBytes(16).toString('hex'),retentionMs=86400000,limit=1024,now=Date.now}={}){
    Object.assign(this,{serverInstance,retentionMs,limit,now});this.entries=new Map();
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
    if(this.entries.size>=this.limit)throw fail('操作记录已满，此请求未发送。请稍后再试','OPERATION_LIMIT');
    const entry={timestamp,signature,method,state:'pending'};
    // A lost response can stay unknown even after its target turn has demonstrably ended.
    // Keep only the scope needed to verify occupancy, never the submitted text.
    if(['turn/interrupt','turn/steer','turn/settings/update'].includes(method)&&typeof params.threadId==='string'){
      entry.workThreadId=params.threadId;
      entry.workTurnId=params.turnId||params.expectedTurnId||null;
    }
    entry.promise=Promise.resolve().then(async()=>{
      let result;
      try{result=await run();}catch(error){
        const e=error instanceof Error?error:new Error(String(error));e.outcome=classify(e);entry.state=e.outcome==='unknown'?'unknown':'failed';entry.error=e.message;entry.code=e.code;entry.outcome=e.outcome;
        if(e.outcome==='unknown'&&['turn/start','thread/compact/start','review/start'].includes(method)&&typeof e.observedWorkTurnId==='string'){
          entry.workThreadId=params.threadId;entry.workTurnId=e.observedWorkTurnId;
        }
        throw e;
      }
      entry.state='succeeded';entry.result=structuredClone(result);
      return entry.result;
    });
    this.entries.set(id,entry);return entry.promise;
  }
  get(id){
    try{this.validate(id);}catch(error){return {state:error.outcome==='unknown'?'unknown':'notFound',error:error.message,code:error.code,outcome:error.outcome,serverInstance:this.serverInstance};}
    const entry=this.entries.get(id);
    if(!entry)return {state:'notFound',outcome:'notExecuted',serverInstance:this.serverInstance};
    return {state:entry.state,method:entry.method,...(entry.state==='succeeded'?{result:entry.result}:{}),...(entry.error?{error:entry.error,code:entry.code,outcome:entry.outcome}:{}),serverInstance:this.serverInstance};
  }
}
