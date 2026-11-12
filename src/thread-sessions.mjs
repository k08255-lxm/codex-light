// Reading history never loads a session. Only work submitted by this bridge owns
// a subscription, and that subscription ends when its active turn finishes.
const fail=(message,code)=>Object.assign(new Error(message),{code,outcome:'notExecuted',status:409});
const workMethods=new Set(['turn/start','review/start','thread/compact/start']);
export class ThreadSessions {
 constructor(rpc,{onEvent=()=>{},closeTimeout=1000}={}){Object.assign(this,{rpc,onEvent,closeTimeout});this.entries=new Map();this.queues=new Map();this.closed=false;}
 serial(id,run){const previous=this.queues.get(id)||Promise.resolve();const current=previous.catch(()=>{}).then(run);this.queues.set(id,current);current.finally(()=>{if(this.queues.get(id)===current)this.queues.delete(id);}).catch(()=>{});return current;}
 changed(){this.onEvent({method:'bridge/threadSessions',params:this.snapshot()});}
 snapshot(){return {threads:[...this.entries].map(([threadId,e])=>({threadId,activeTurnId:e.activeTurnId||null,state:e.unknown?'unknown':e.activeTurnId?'active':'idle',releaseError:e.releaseError||null}))};}
 entry(id){let e=this.entries.get(id);if(!e){e={loaded:false,unpersisted:false,activeTurnId:null,completed:new Set()};this.entries.set(id,e);}return e;}
 async ensureLoaded(id){const e=this.entry(id);if(!e.loaded){try{await this.rpc.call('thread/resume',{threadId:id,excludeTurns:true});e.loaded=true;}catch(error){
  if(typeof error.code==='number'||error.outcome==='notExecuted'||['NOT_CONNECTED','INPUT_BACKPRESSURE','TOO_MANY_REQUESTS'].includes(error.code))this.entries.delete(id);
  else{e.loaded=true;e.unknown=true;this.changed();}
  // The work RPC has not been sent even if the resume outcome is uncertain.
  error.outcome='notExecuted';throw error;
 }}return e;}
 async release(id,{shutdown=false}={}){
  const e=this.entries.get(id);if(!e)return {status:'notSubscribed'};
  if(!shutdown&&(e.activeTurnId||e.unknown))return {status:'retained',activeTurnId:e.activeTurnId||null,state:e.unknown?'unknown':'active'};
  if(!e.loaded){this.entries.delete(id);this.changed();return {status:'notLoaded'};}
  try{const result=await this.rpc.call('thread/unsubscribe',{threadId:id});this.entries.delete(id);this.changed();return result;}
  catch(error){e.releaseError='会话订阅未释放，请检查连接状态；关闭 Light 会结束本应用的引擎进程。';this.changed();throw error;}
 }
 async call(method,params){
  if(this.closed)throw fail('Light 正在关闭，此请求未发送','CLIENT_CLOSING');
  const id=params.threadId;
  // Keep resume internal: legacy clients opening history cannot acquire locks.
  if(method==='thread/resume')return this.rpc.call('thread/read',{threadId:id,includeTurns:!params.excludeTurns});
  if(method==='thread/unsubscribe')return this.serial(id,()=>this.release(id));
  if(method==='turn/steer')return this.serial(id,async()=>{
   if(this.closed)throw fail('Light 正在关闭，此请求未发送','CLIENT_CLOSING');
   const e=this.entries.get(id);
   if(!e?.loaded||e.activeTurnId!==params.expectedTurnId)throw fail('运行任务已变化，请刷新后重新选择立即发送或排队','ACTIVE_TURN_MISMATCH');
   return this.rpc.call(method,params);
  });
  if(workMethods.has(method))return this.serial(id,async()=>{
   if(this.closed)throw fail('Light 正在关闭，此请求未发送','CLIENT_CLOSING');
   const e=await this.ensureLoaded(id);
   if(this.closed)throw fail('Light 正在关闭，此请求未发送','CLIENT_CLOSING');
   if(e.activeTurnId||e.unknown)throw fail('此对话已有运行任务或结果待核对，请使用立即发送或排队','TURN_ACTIVE');
   if(method==='thread/compact/start')e.unknown=true;
   try{
    const result=await this.rpc.call(method,params);
    const turn=result?.turn;
    if(turn?.id)e.unpersisted=false;
    if(turn?.id&&!e.completed.has(turn.id)&&(!turn.status||turn.status==='inProgress'))e.activeTurnId=turn.id;
    // Compaction has no turn in its response; the started/completed events own its lifetime.
    this.changed();
    if(!e.activeTurnId&&!e.unknown)await this.release(id).catch(()=>{});
    return result;
   }catch(error){
    if(error.outcome==='notExecuted'||['NOT_CONNECTED','INPUT_BACKPRESSURE','TOO_MANY_REQUESTS',-32600,-32601,-32602].includes(error.code)){
     e.unknown=false;
     // Native Codex cannot resume an empty thread whose first turn never began.
     // Keep it loaded for an explicit retry; switching away/closing may discard it.
     if(!e.unpersisted)await this.release(id).catch(()=>{});else this.changed();
    }
    else{e.unknown=true;this.changed();}
    throw error;
   }
  });
  const result=await this.rpc.call(method,params);
  if(['thread/start','thread/fork'].includes(method)&&result?.thread?.id){
   const created=this.entry(result.thread.id);created.loaded=true;created.unpersisted=method==='thread/start';this.changed();
   // A new empty thread has no rollout until its first turn. Unloading it here
   // makes that first send impossible to resume. Frontends create on first send.
   if(method==='thread/fork')await this.serial(result.thread.id,()=>this.release(result.thread.id)).catch(()=>{});
  }
  return result;
 }
 observe(message){
  const id=message.params?.threadId,e=this.entries.get(id);
  if(message.method==='bridge/status'&&message.params?.connected===false){this.entries.clear();this.changed();return;}
  if(!e)return;
  if(message.method==='thread/closed'){this.entries.delete(id);this.changed();return;}
  if(message.method==='turn/started'){e.activeTurnId=message.params?.turn?.id||message.params?.turnId||null;e.unpersisted=false;e.unknown=false;this.changed();}
  if(message.method==='turn/completed'){
   const turnId=message.params?.turn?.id||message.params?.turnId;if(!turnId)return;
   e.unpersisted=false;
   e.completed.add(turnId);if(e.completed.size>64)e.completed.delete(e.completed.values().next().value);
   if(e.activeTurnId&&e.activeTurnId!==turnId)return;
   e.activeTurnId=null;e.unknown=false;this.changed();
   this.serial(id,()=>this.release(id)).catch(()=>{});
  }
 }
 async close(){
  this.closed=true;
  // Bounded cleanup while stdio is still writable. The caller must then close
  // this app's child process, including when an unsubscribe response is lost.
  let timer;
  try{await Promise.race([Promise.allSettled([...this.entries.keys()].map(id=>this.release(id,{shutdown:true}))),new Promise(resolve=>{timer=setTimeout(resolve,this.closeTimeout);})]);}finally{clearTimeout(timer);}
 }
}
