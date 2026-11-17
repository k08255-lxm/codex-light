import {performance} from 'node:perf_hooks';
const aborted=()=>Object.assign(new Error('对话搜索已取消'),{name:'AbortError',code:'SEARCH_ABORTED',status:499,outcome:'notExecuted'});
const keyFor=params=>JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a],[b])=>a.localeCompare(b))));

// Share only overlapping, identical reads, never completed pages. External Codex
// clients can edit/delete history without notifying this bridge: a TTL result
// cache would change search correctness. Cursors and all filters stay opaque.
export class ThreadListService {
 constructor(rpc){this.rpc=rpc;this.inflight=new Map();}
 invalidate(){this.inflight.clear();}
 async mutate(run){this.invalidate();try{return await run();}finally{this.invalidate();}}
 observe({method}){if(method?.startsWith('thread/')||method?.startsWith('turn/')||['account/updated','bridge/status'].includes(method))this.invalidate();}
 async list(params,{signal}={}){
  if(signal?.aborted)throw aborted();
  const key=keyFor(params);let entry=this.inflight.get(key);
  if(!entry){
   const controller=new AbortController();entry={controller,users:0};
   entry.promise=Promise.resolve().then(()=>this.rpc.call('thread/list',params,{signal:controller.signal}));
   this.inflight.set(key,entry);
   entry.promise.finally(()=>{if(this.inflight.get(key)===entry)this.inflight.delete(key);}).catch(()=>{});
  }
  entry.users++;
  let onAbort;
  try{
   return await (signal?Promise.race([entry.promise,new Promise((_,reject)=>{onAbort=()=>reject(aborted());signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();})]):entry.promise);
  }finally{
   if(onAbort)signal.removeEventListener('abort',onAbort);
   if(--entry.users===0){if(this.inflight.get(key)===entry)this.inflight.delete(key);entry.controller.abort();}
  }
 }
 async http(req,res,params){
  const controller=new AbortController(),started=performance.now();
  const disconnect=()=>controller.abort();res.once('close',disconnect);
  try{
   if(req.aborted||res.destroyed)controller.abort();
   const result=await this.list(params,{signal:controller.signal});
   if(!res.destroyed)res.setHeader('Server-Timing',`thread_list;dur=${(performance.now()-started).toFixed(2)}`);
   return result;
  }finally{res.removeListener('close',disconnect);}
 }
}
