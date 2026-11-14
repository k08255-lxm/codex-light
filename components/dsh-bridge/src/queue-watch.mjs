import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,openSync,closeSync,watch,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {bridgeClient} from './bridge-client.mjs';
const completionOutput=(result,resultPath)=>{const out={result_path:resultPath};for(const key of ['agent_id','status','finish_reason','answer','error','wait_outcome'])if(result[key]!==undefined)out[key]=typeof result[key]==='string'?result[key].slice(0,8000):result[key];return out;};
async function saveNotificationFile(file,value){writeFileSync(file+'.pending',JSON.stringify(value),{mode:0o600});renameSync(file+'.pending',file);}
import {readQueueDescriptor,queueCallbackEvent} from './callback-queue.mjs';
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
export function validateQueueParent(record,threadId){
 if(!id(threadId)||!id(record?.id)||!id(record?.callback_generation)||record.external||record.parent_thread_id!==threadId)throw Error('Automatic completion requires the exact owning Codex thread and current task generation');
 return {agent:record.id,thread:threadId,generation:record.callback_generation};
}
export function queueWatchKey(binding,args){return createHash('sha256').update(JSON.stringify([binding,args.thread,args.agent,args.generation])).digest('hex');}
function unpack(reply){if(reply?.isError)throw Error('DSH status unavailable');const text=reply?.content?.find(x=>x.type==='text')?.text;if(typeof text!=='string'||text.length>1024*1024)throw Error('Invalid DSH result');return JSON.parse(text);}
export async function waitQueueCompletion(args,{connect=bridgeClient,enqueue=queueCallbackEvent,pause=delay,attempts=12,onWatching=()=>{},cancelled=()=>false}={}){
 let client;
 for(let attempt=0;attempt<attempts;attempt++){
  if(cancelled())return {status:'cancelled'};
  try{
   client=await connect(args.state);
   const state=unpack(await client.request('tools/call',{name:'dsh_status',arguments:{agent_id:args.agent,legacy:true}}));
   validateQueueParent({...state,id:state.id||state.agent_id},args.thread);
   if(state.callback_generation!==args.generation)return {status:'superseded'};
   onWatching(client);
   const result=unpack(await client.request('tools/call',{name:'dsh_wait',arguments:{agent_id:args.agent,legacy:true}}));
   if(cancelled())return {status:'cancelled'};
   if(result.callback_generation!==args.generation||result.parent_thread_id!==args.thread)return {status:'superseded'};
   if(result.wait_outcome!=='settled')throw Error('Unsettled result');
   if(['closed','interrupted'].includes(result.status))return {status:'stopped',result};
   // Writer is deterministic and exclusive. No turn/start is performed here.
   const queued=await enqueue(args.queue,{eventType:'completion',threadId:args.thread,taskId:args.agent,generationId:args.generation,output:completionOutput(result,join(args.directory,'result.json'))});
   return {status:'queued',result,queue_receipt:queued};
  }catch(error){if(cancelled())return {status:'cancelled'};if(attempt===attempts-1)return {status:'reconnect_required',error:'DSH completion listener disconnected; result retained. Register dsh_watch again to reconnect.'};await pause(Math.min(1000*(attempt+1),5000));}
  finally{client?.close();client=null;}
 }
}
const processAlive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return null;try{process.kill(pid,0);return true;}catch(error){return error.code==='ESRCH'?false:null;}};
// Append-only claims avoid unlinking another starter's newly acquired lock.
// A crashed owner can be followed only after its PID is proven absent.
export function acquireQueueStart(directory,{alive=processAlive}={}){
 let name='start.claim';
 for(let i=0;i<32;i++){
  const file=join(directory,name),owner={pid:process.pid,token:randomUUID(),finished:false};
  try{const fd=openSync(file,'wx',0o600);try{writeFileSync(fd,JSON.stringify(owner));}finally{closeSync(fd);}return watcherPid=>{writeFileSync(file,JSON.stringify({...owner,finished:true,...(watcherPid?{watcherPid}:{})}),{mode:0o600});};}
  catch(error){if(error.code!=='EEXIST')throw error;}
  let previous;try{previous=JSON.parse(readFileSync(file,'utf8'));}catch{return null;}
  if(!id(previous.token)||(!previous.finished&&alive(previous.pid)!==false)||(previous.watcherPid&&alive(previous.watcherPid)!==false))return null;
  name='start-'+previous.token+'.claim';
 }
 return null;
}
export async function registerQueueWatch(record,extra,{state,spawn=fork,alive=processAlive}={}){
 const args=validateQueueParent(record,extra?._meta?.threadId);args.queue=extra?._meta?.dshQueue;
 const descriptor=readQueueDescriptor(args.queue);args.state=state;
 const base=join(state,'callbacks');mkdirSync(base,{recursive:true,mode:0o700});
 args.directory=resolve(base,queueWatchKey(descriptor.bindingId,args));mkdirSync(args.directory,{recursive:true,mode:0o700});
 const receiptPath=join(args.directory,'callback.json');
 const receipt={agent_id:args.agent,thread_id:args.thread,parent_thread_id:args.thread,generationId:args.generation,callback_generation:args.generation,status:'reconnect_required',result_path:join(args.directory,'result.json')};
 let old;try{old=JSON.parse(readFileSync(receiptPath,'utf8'));}catch{}
 if(old&&['queued','cancelled','stopped','superseded'].includes(old.status))return old;
 if(old?.pid&&alive(old.pid)!==false)return {...old,status:old.status==='watching'?'watching':'reconnect_required'};
 const release=acquireQueueStart(args.directory,{alive});
 if(!release)return {...receipt,error:'Another listener may be initializing; no duplicate was started. Retry after its state is known.'};
 let child;
 try{
  receipt.queue_receipt=queueCallbackEvent(args.queue,{eventType:'watch',threadId:args.thread,taskId:args.agent,generationId:args.generation});receipt.status='starting';
  await saveNotificationFile(receiptPath,receipt);
  child=spawn(fileURLToPath(import.meta.url),[JSON.stringify(args)],{detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  receipt.pid=child.pid;await saveNotificationFile(receiptPath,receipt);
  const result=await new Promise((resolve,reject)=>{const t=setTimeout(()=>{child.kill();reject(Error('Completion listener initialization timed out'));},15000);child.once('message',r=>{clearTimeout(t);resolve(r);});child.once('error',e=>{clearTimeout(t);reject(e);});child.once('exit',()=>{clearTimeout(t);reject(Error('Completion listener exited during startup'));});});child.unref();return result;
 }catch(error){receipt.status='reconnect_required';receipt.error='Completion listener could not start; retry dsh_watch. No task or completion was replayed.';if(!child?.pid)delete receipt.pid;await saveNotificationFile(receiptPath,receipt);return receipt;}
 finally{release(child?.pid);}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=JSON.parse(process.argv[2]);let cancelled=false,client,announced=false;
 const receipt={agent_id:args.agent,thread_id:args.thread,parent_thread_id:args.thread,generationId:args.generation,callback_generation:args.generation,pid:process.pid,result_path:join(args.directory,'result.json'),status:'watching',next_action:'do_independent_work_or_end_response'};
 const announce=()=>{if(!announced){announced=true;process.send?.(receipt);process.disconnect?.();}};
 const cancel=()=>{cancelled=true;client?.close();};
 const observer=watch(args.directory,()=>{if(existsSync(join(args.directory,'cancel')))cancel();});process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
 try{const result=await waitQueueCompletion(args,{cancelled:()=>cancelled||existsSync(join(args.directory,'cancel')),onWatching:c=>{client=c;announce();}});if(result.result)await saveNotificationFile(receipt.result_path,result.result);Object.assign(receipt,result);delete receipt.result;await saveNotificationFile(join(args.directory,'callback.json'),receipt);announce();}
 finally{observer.close();}
}
