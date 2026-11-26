// Reading history never loads a session. Only work submitted by this bridge owns
// a subscription, and that subscription ends when its active turn finishes.
const fail=(message,code)=>Object.assign(new Error(message),{code,outcome:'notExecuted',status:409});
const workMethods=new Set(['turn/start','review/start','thread/compact/start']);
export class ThreadSessions {
 constructor(rpc,{onEvent=()=>{},onThreadLoaded=()=>{},contextWindows=null,closeTimeout=1000}={}){Object.assign(this,{rpc,onEvent,onThreadLoaded,contextWindows,closeTimeout});this.entries=new Map();this.queues=new Map();this.closed=false;}
 serial(id,run){const previous=this.queues.get(id)||Promise.resolve();const current=previous.catch(()=>{}).then(run);this.queues.set(id,current);current.finally(()=>{if(this.queues.get(id)===current)this.queues.delete(id);}).catch(()=>{});return current;}
 runIdle(id,run){return this.serial(id,async()=>{
  if(this.closed)throw fail('Light 正在关闭，此请求未发送','CLIENT_CLOSING');
  const check=()=>{const entry=this.entries.get(id);if(entry?.activeTurnId||entry?.unknown)throw fail('对话正在运行或等待引擎确认，请稍后再试','TURN_ACTIVE');};
  check();
  let current;
  try{current=await this.rpc.call('thread/read',{threadId:id,includeTurns:false});}
  catch(error){error.outcome='notExecuted';throw error;}
  if(current?.thread?.id!==id)throw fail('未能确认目标对话，请刷新列表后重试','THREAD_NOT_CONFIRMED');
  if(current.thread.status?.type==='active')throw fail('对话正在运行，请稍后再试','TURN_ACTIVE');
  check();
  return run(current.thread);
 });}
 changed(){this.onEvent({method:'bridge/threadSessions',params:this.snapshot()});}
 snapshot(){return {threads:[...this.entries].map(([threadId,e])=>({threadId,activeTurnId:e.activeTurnId||null,state:e.unknown?'unknown':e.activeTurnId?'active':'idle',releaseError:e.releaseError||null}))};}
 entry(id){let e=this.entries.get(id);if(!e){e={loaded:false,unpersisted:false,activeTurnId:null,completed:new Set()};this.entries.set(id,e);}return e;}
 async resume(params){
  // The engine can acknowledge unsubscribe before the previous session finishes closing.
  for(let attempt=0;;attempt++){
   if(this.closed)throw fail('Light 正在关闭，此请求未发送','CLIENT_CLOSING');
   try{return await this.rpc.call('thread/resume',params);}
   catch(error){
    if(error.code!==-32600||!error.message.includes('is closing; retry thread/resume')||attempt>=5)throw error;
    await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));
   }
  }
 }
 async ensureLoaded(id,work){const e=this.entry(id);if(!e.loaded){try{
  const base={threadId:id,excludeTurns:true};
  const params=this.contextWindows?await this.contextWindows.sessionParams(this.rpc,base,work):base;
  const result=await this.resume(params);
  this.entries.set(id,e);
  e.loaded=true;e.contextWindow=params.config?.model_context_window;e.model=result.model||params.model;this.onThreadLoaded(result);
 }catch(error){
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
 async call(method,params,{beforeSend}={}){
  if(this.closed)throw fail('Light 正在关闭，此请求未发送','CLIENT_CLOSING');
  const id=params.threadId;
  // Keep resume internal: legacy clients opening history cannot acquire locks.
  if(method==='thread/resume')return this.rpc.call('thread/read',{threadId:id,includeTurns:!params.excludeTurns});
  if(method==='thread/unsubscribe')return this.serial(id,()=>this.release(id));
  if(method==='turn/settings/update')return this.serial(id,async()=>{
   if(this.closed)throw fail('Light 正在关闭，此请求未发送','CLIENT_CLOSING');
   const entry=this.entries.get(id);
   if(!entry?.loaded||entry.unknown||!entry.activeTurnId||entry.activeTurnId!==params.turnId)return {status:'targetUnavailable'};
   if(params.model && params.model!==entry.model && this.contextWindows?.sizes.get(params.model)!==entry.contextWindow)
    throw fail('两个模型的上下文窗口设置不同，可在本轮结束后切换。','CONTEXT_WINDOW_ACTIVE');
   let result;
   try{result=await this.rpc.call(method,params);}
   catch(error){
    if(error.code===-32601)throw fail('当前 Codex 版本不支持修改运行中任务的设置',-32601);
    if(error.code===-32600&&error.message?.includes('step_model_switching'))throw fail('当前 Codex 未启用运行中调整模型的功能','TURN_SETTINGS_DISABLED');
    throw error;
   }
   if(!['applied','targetUnavailable'].includes(result?.status))throw Object.assign(new Error('Codex 未确认本次运行设置的结果'),{code:'UNCONFIRMED_TURN_SETTINGS',outcome:'unknown'});
   if(result.status==='applied'&&params.model)entry.model=params.model;
   return result;
  });
  if(method==='turn/steer')return this.serial(id,async()=>{
   if(this.closed)throw fail('Light 正在关闭，此请求未发送','CLIENT_CLOSING');
   const e=this.entries.get(id);
   if(!e?.loaded||e.activeTurnId!==params.expectedTurnId)throw fail('运行任务已变化，请刷新后重新选择立即发送或排队','ACTIVE_TURN_MISMATCH');
   return this.rpc.call(method,params);
  });
  if(workMethods.has(method))return this.serial(id,async()=>{
   if(this.closed)throw fail('Light 正在关闭，此请求未发送','CLIENT_CLOSING');
   const e=await this.ensureLoaded(id,params);
   if(this.closed)throw fail('Light 正在关闭，此请求未发送','CLIENT_CLOSING');
   if(e.activeTurnId||e.unknown)throw fail('上一轮仍在运行或等待引擎确认。可以立即发送或排队','TURN_ACTIVE');
   if(params.model && this.contextWindows?.sizes.get(params.model)!==e.contextWindow)
    throw fail('模型的上下文配置已变化，请重新打开对话后发送。','CONTEXT_WINDOW_CHANGED');
   if(method==='thread/compact/start')e.unknown=true;
   try{
    beforeSend?.();
    const result=await this.rpc.call(method,params,beforeSend?{beforeSend}:{});
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
  if(method==='thread/start'&&this.contextWindows)params=await this.contextWindows.sessionParams(this.rpc,params);
  const result=await this.rpc.call(method,params);
  if(['thread/start','thread/fork'].includes(method)&&result?.thread?.id){
   const created=this.entry(result.thread.id);created.loaded=true;created.unpersisted=method==='thread/start';created.contextWindow=params.config?.model_context_window;created.model=result.model||params.model;this.changed();
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
  if(['thread/closed','thread/archived','thread/deleted'].includes(message.method)){this.entries.delete(id);this.changed();return;}
  if(message.method==='turn/started'){
   const turnId=message.params?.turn?.id||message.params?.turnId;
   if(!turnId||e.completed.has(turnId))return;
   e.activeTurnId=turnId;e.unpersisted=false;e.unknown=false;this.changed();
  }
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
