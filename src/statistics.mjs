import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {estimateTokenCost} from '../public/token-pricing.js';
import {requestKey,requestReceipt} from './request-usage.mjs';

export const STATISTICS_LIMIT=5000;
const MAX_BYTES=8*1024*1024;
const TOKEN_KEYS=['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
const METRICS=['firstTextLatencyMs','durationMs','textCharsPerSecond'];
const SPEED_FIELDS=['replyMs','toolMs','decodeMs','decodeTokens'];
const toolItems=new Set(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabAgentToolCall','webSearch','imageView','imageGeneration']);
const statuses=new Set(['inProgress','completed','failed','interrupted','unknown']);
const n=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const metric=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x20\x7f]/.test(value)?value:null;
const providerId=value=>typeof value==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(value)?value:null;
export function publicAccountIdentity(raw){
 const value=raw?.account??raw;if(!value||!['chatgpt','apiKey'].includes(value.type))return null;
 const text=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value)?value:null;
 const email=value.type==='chatgpt'?text(value.email):null;
 // API-key auth exposes no public account identity. Never read or hash a key.
 return {type:value.type,email,planType:text(value.planType),id:email?createHash('sha256').update(JSON.stringify([value.type,email])).digest('hex'):null,label:email||(value.type==='apiKey'?'API Key 登录（账户未知）':'ChatGPT 登录（账户未知）')};
}
const iso=value=>typeof value==='string'&&value.length<64&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const emptyTokens=()=>Object.fromEntries(TOKEN_KEYS.map(key=>[key,null]));
const tokens=value=>Object.fromEntries(TOKEN_KEYS.map(key=>[key,n(value?.[key])]));
const emptyMetrics=()=>Object.fromEntries(METRICS.map(key=>[key,null]));
const keyFor=(thread,turn)=>JSON.stringify([thread,turn]);
const plus=(a,b)=>n(a)!==null&&n(b)!==null&&Number.isSafeInteger(a+b)?a+b:null;
const error=message=>Object.assign(new Error(message),{status:400,outcome:'notExecuted'});
const blankRow=(threadId,turnId,source)=>({id:keyFor(threadId,turnId),kind:'turn',threadId,turnId,source,timestamp:null,startedAt:null,completedAt:null,model:null,provider:null,account:null,status:'unknown',submissionCount:0,tokens:emptyTokens(),tokensComplete:false,outputTokensComplete:false,unknownTokenFields:[],performance:emptyMetrics()});

export function defaultStatisticsRoot(){const base=process.platform==='win32'?(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local')):(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share'));return path.join(base,'CodexLight','statistics');}
async function noLinks(target){for(let p=path.resolve(target);;p=path.dirname(p)){try{if((await fs.lstat(p)).isSymbolicLink())throw new Error('Statistics path is a link');}catch(e){if(e.code!=='ENOENT')throw e;}if(path.dirname(p)===p)return;}}
function cleanRow(raw){
 if(!raw||!id(raw.threadId)||!id(raw.turnId)||raw.source!=='light-events'||!statuses.has(raw.status))throw new Error('Invalid statistics record');
 const row=blankRow(raw.threadId,raw.turnId,'light-events');
 Object.assign(row,{timestamp:iso(raw.timestamp),startedAt:iso(raw.startedAt),completedAt:iso(raw.completedAt),model:id(raw.model),provider:providerId(raw.provider),status:raw.status,submissionCount:n(raw.submissionCount)??0,tokens:tokens(raw.tokens),tokensComplete:raw.tokensComplete===true,outputTokensComplete:raw.outputTokensComplete===true,unknownTokenFields:TOKEN_KEYS.filter(key=>raw.unknownTokenFields?.includes(key)),performance:Object.fromEntries(METRICS.map(key=>[key,metric(raw.performance?.[key])]))});
 row.account=publicAccountIdentity(raw.account);if(raw.tokenSource==='verified-local-turn')row.tokenSource='verified-local-turn';
 if(raw.speed)row.speed=Object.fromEntries(SPEED_FIELDS.filter(key=>metric(raw.speed[key])!==null).map(key=>[key,raw.speed[key]]));
 if(n(raw.context?.used)!==null&&n(raw.context?.window)>0)row.context={used:raw.context.used,window:raw.context.window};
 return row;
}
function addUsage(row,delta){for(const key of TOKEN_KEYS){const value=n(delta[key]);if(value===null){row.tokens[key]=null;if(!row.unknownTokenFields.includes(key))row.unknownTokenFields.push(key);row.tokensComplete=false;}else if(!row.unknownTokenFields.includes(key)){row.tokens[key]=row.tokens[key]===null?value:plus(row.tokens[key],value);if(row.tokens[key]===null){row.unknownTokenFields.push(key);row.tokensComplete=false;}}}}
function percentiles(values){
 const sorted=values.filter(value=>metric(value)!==null).sort((a,b)=>a-b);
 if(!sorted.length)return {count:0,p50:null,p95:null,mean:null};
 return {count:sorted.length,p50:sorted[Math.max(0,Math.ceil(sorted.length*.5)-1)],p95:sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)],mean:sorted.reduce((a,b)=>a+b,0)/sorted.length};
}
// End-to-end turn throughput, not model generation speed. Output coverage is
// tracked independently: native token schemas need not report cache-write usage.
function turnThroughput(row){
 const duration=row.performance.durationMs,output=n(row.tokens.outputTokens);
 return row.kind==='turn'&&row.status==='completed'&&row.outputTokensComplete===true&&output!==null&&metric(duration)!==null&&duration>0?output/(duration/1000):null;
}
function cost(row,pricing,references){
 let estimate=null,reference=null;
 if(row.model&&row.model.length<=200){try{
  const key=JSON.stringify([row.provider,row.model]);
  if(!references.has(key))references.set(key,pricing.get(row.model,row.provider));
  reference=references.get(key);estimate=estimateTokenCost({...row.tokens,model:row.model,provider:row.provider},reference);
 }catch{/* Invalid model/provider or schema cannot be priced. */}}
 // Output coverage requires an uninterrupted baseline from turn start. If a
 // breakdown is missing, the tariff may still price all observed tokens exactly.
 const usageComplete=row.tokensComplete===true||row.outputTokensComplete===true&&n(row.tokens.totalTokens)!==null&&estimate?.complete===true;
 const noUsage=TOKEN_KEYS.every(key=>n(row.tokens[key])===null);
 return {kind:'reference-estimate',currency:'USD',usd:estimate?.complete?estimate.usd:estimate?.knownUsd??null,complete:estimate?.complete===true&&usageComplete,tokenSource:row.tokenSource||'observed',components:estimate?.components||[],pricingComplete:estimate?.complete===true,usageComplete,reason:noUsage?'引擎未返回本轮用量':estimate?.reason||(estimate?.complete&&!usageComplete?'计价分项已齐全，但观察记录未确认覆盖整个回合':null)||(!row.model?'模型未知':null),reference:reference?{source:reference.source,scope:reference.scope??null,catalogProvider:reference.catalogProvider||null,catalogModel:reference.catalogModel||null,matchedBy:reference.matchedBy,referenceTier:reference.referenceTier||null,fetchedAt:reference.fetchedAt||null}:null};
}
function aggregate(rows){
 const turns=rows.filter(row=>row.kind==='turn');
 rows=rows.filter(row=>!row.metricsOnly);
 const tokenTotals=Object.fromEntries(TOKEN_KEYS.map(key=>{const known=rows.map(row=>n(row.tokens[key])).filter(value=>value!==null);const sum=known.reduce((a,b)=>a+b,0);return [key,known.length&&Number.isSafeInteger(sum)?sum:null];}));
 const count=status=>turns.filter(row=>row.status===status).length;
 const completedCount=count('completed'),failedCount=count('failed'),interruptedCount=count('interrupted'),terminal=completedCount+failedCount+interruptedCount;
 const cacheRows=rows.filter(row=>n(row.tokens.inputTokens)!==null&&n(row.tokens.cachedInputTokens)!==null&&row.tokens.cachedInputTokens<=row.tokens.inputTokens);
 const input=cacheRows.reduce((a,row)=>a+row.tokens.inputTokens,0),cached=cacheRows.reduce((a,row)=>a+row.tokens.cachedInputTokens,0);
 const priced=rows.filter(row=>row.estimatedCost.usd!==null);
 const submissions=turns.map(row=>n(row.submissionCount)).filter(value=>value!==null);
 return {rowCount:rows.length,turnCount:turns.length,submissionCount:submissions.length?submissions.reduce((sum,value)=>sum+value,0):rows.length?null:0,requestCount:null,...tokenTotals,cacheHitRate:input>0?cached/input:null,
  completedCount,failedCount,interruptedCount,runningCount:count('inProgress'),unknownCount:count('unknown'),successRate:terminal?completedCount/terminal:null,errorRate:terminal?failedCount/terminal:null,interruptionRate:terminal?interruptedCount/terminal:null,
  estimatedCost:{kind:'reference-estimate',currency:'USD',usd:priced.length?priced.reduce((sum,row)=>sum+row.estimatedCost.usd,0):null,pricedRows:priced.length,partialRows:priced.filter(row=>!row.estimatedCost.complete).length,unpricedRows:rows.length-priced.length,totalRows:rows.length,complete:rows.length>0&&rows.every(row=>row.estimatedCost.complete)},
  performance:{...Object.fromEntries(METRICS.map(key=>[key,percentiles(turns.map(row=>row.performance[key]))])),turnOutputTokensPerSecond:percentiles(turns.map(row=>row.performance.turnOutputTokensPerSecond)),ttftMs:null,outputTokensPerSecond:null}};
}

/** Stores bounded identity/timing/token metadata only. Never retains delta text. */
export class StatisticsService {
 constructor({pricing,root=null,now=Date.now,monotonic=()=>performance.now(),limit=STATISTICS_LIMIT}={}){
  if(root!==null&&(typeof root!=='string'||!path.isAbsolute(root)))throw new Error('Statistics root must be absolute');
  Object.assign(this,{pricing,root,now,monotonic,limit});this.rows=new Map();this.baselines=new Map();this.blockedTokenThreads=new Set();this.threads=new Map();this.active=new Map();this.localRows=[];this.localCoverage={partial:false,excludedOverlappingThreads:0,excludedAmbiguousSessions:0};this.queue=Promise.resolve();this.persistenceWarning=null;this.revision=0;this.truncated=false;this.snapshots=new Map();
  this.currentAccount=null;
  this.requests=new Map();this.localRequests=[];
 }
 async load(){
  if(!this.root)return;
  let handle;
  try{
   const file=path.join(this.root,'live.json');await noLinks(file);handle=await fs.open(file,'r');const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_BYTES)throw new Error('Statistics file too large');
   const buffer=Buffer.alloc(MAX_BYTES+1);let count=0;while(count<buffer.length){const read=await handle.read(buffer,count,buffer.length-count,null);if(!read.bytesRead)break;count+=read.bytesRead;}if(count>MAX_BYTES)throw new Error('Statistics file grew beyond limit');
   const data=JSON.parse(buffer.subarray(0,count).toString('utf8'));if(data.version!==1||!Array.isArray(data.rows)||data.rows.length>this.limit)throw new Error('Invalid statistics file');
   const loaded=data.rows.map(cleanRow);for(const row of loaded){if(row.status==='inProgress')row.status='unknown';this.rows.set(row.id,row);}this.truncated=data.truncated===true;
   for(const raw of (Array.isArray(data.requests)?data.requests:[]).slice(-this.limit)){
    const receipt=requestReceipt({...raw,tokens:tokens(raw.tokens),model:id(raw.model),provider:providerId(raw.provider)});
    if(receipt)this.requests.set(requestKey(receipt),receipt);
   }
  }catch(e){if(e.code!=='ENOENT'){this.persistenceWarning='统计记录无法安全读取；保留原文件，本次仅收集内存数据。';this.writeBlocked=true;}}
  finally{await handle?.close();}
 }
 changed(){
  this.revision++;
  while(this.rows.size>this.limit){const candidate=[...this.rows].find(([,row])=>row.status!=='inProgress')||this.rows.entries().next().value;this.rows.delete(candidate[0]);this.active.delete(candidate[0]);this.truncated=true;}
  if(!this.root||this.writeBlocked||this.saveTimer)return;
  this.saveTimer=setTimeout(()=>{this.saveTimer=null;this.flush();},500);this.saveTimer.unref?.();
 }
 flush(){
  clearTimeout(this.saveTimer);this.saveTimer=null;if(!this.root||this.writeBlocked)return this.queue;
  const body={version:1,truncated:this.truncated,rows:[...this.rows.values()].map(cleanRow),requests:[...this.requests.values()]};
  let data=JSON.stringify(body);
  while(body.requests.length&&Buffer.byteLength(data)>MAX_BYTES){
   body.requests.splice(0,Math.max(1,Math.ceil(body.requests.length/4)));body.truncated=true;data=JSON.stringify(body);
  }
  if(Buffer.byteLength(data)>MAX_BYTES){this.persistenceWarning='统计元数据达到大小上限；部分新数据仅在内存中。';return this.queue;}
  this.queue=this.queue.then(async()=>{
   let temporary;
   try{await noLinks(this.root);await fs.mkdir(this.root,{recursive:true,mode:0o700});await noLinks(path.join(this.root,'live.json'));temporary=path.join(this.root,'.live-'+randomBytes(12).toString('hex')+'.tmp');const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}await fs.rename(temporary,path.join(this.root,'live.json'));temporary=null;}
   catch{this.persistenceWarning='统计元数据保存失败，当前页面仍保留内存数据。';}
   finally{if(temporary)await fs.unlink(temporary).catch(()=>{});}
  });return this.queue;
 }
 thread(thread,result={}){
  if(!id(thread?.id))return;
  const prior=this.threads.get(thread.id)||{};const info={model:id(result.model)||id(thread.model)||prior.model||null,provider:providerId(result.modelProvider)||providerId(thread.modelProvider)||prior.provider||null};
  this.threads.set(thread.id,info);if(this.threads.size>1000)this.threads.delete(this.threads.keys().next().value);
 }
 rememberBaseline(threadId,value){this.baselines.set(threadId,value);while(this.baselines.size>1000){const oldest=this.baselines.keys().next().value;this.baselines.delete(oldest);this.blockedTokenThreads.delete(oldest);}}
 rememberRequest(receipt){
  if(!receipt||this.requests.has(requestKey(receipt)))return false;
  this.requests.set(requestKey(receipt),receipt);
  if(this.requests.size>this.limit){this.requests.delete(this.requests.keys().next().value);this.truncated=true;}
  return true;
 }
 acknowledge(method,params,result){
  if(method==='account/read'){this.setAccount(result);return;}
  if(result?.thread){this.thread(result.thread,result);if(method==='thread/start'){this.rememberBaseline(result.thread.id,Object.fromEntries(TOKEN_KEYS.map(key=>[key,0])));this.blockedTokenThreads.delete(result.thread.id);}}
  if(!['turn/start','turn/steer','review/start','thread/compact/start'].includes(method))return;
  const turnId=id(result?.turn?.id)||id(result?.turnId)||[...this.rows.values()].find(row=>row.threadId===params.threadId&&row.status==='inProgress')?.turnId;if(!turnId)return;
  const key=keyFor(params.threadId,turnId);let row=this.rows.get(key);
  if(!row){row=blankRow(params.threadId,turnId,'light-events');row.account=this.currentAccount?{...this.currentAccount}:null;row.timestamp=new Date(this.now()).toISOString();this.rows.set(key,row);}
  row.submissionCount++;const info=this.threads.get(params.threadId)||{};row.model=id(params.model)||row.model||info.model||null;row.provider=row.provider||info.provider||null;
  // An accepted explicit override becomes the thread's effective model for subsequent turns.
  if(method==='turn/start'&&id(params.model))this.threads.set(params.threadId,{...info,model:id(params.model)});
  this.changed();
 }
 observe(message){
  const p=message.params||{},threadId=id(p.threadId),turnId=id(p.turn?.id)||id(p.turnId),key=threadId&&turnId?keyFor(threadId,turnId):null;
  if(message.method==='bridge/status'&&p.connected===false){for(const [k,a] of this.active){const row=this.rows.get(k);if(row?.status==='inProgress')row.status='unknown';}this.active.clear();this.threads.clear();this.baselines.clear();this.blockedTokenThreads.clear();this.changed();return;}
  if(message.method==='thread/started'){this.thread(p.thread);return;}
  if(!threadId)return;
  if(['item/started','item/completed'].includes(message.method)&&p.item?.type==='subAgentActivity'&&p.item.kind==='started'){
   // Unlike a spawn request, this native event carries the model resolved for the child.
   const child=id(p.item.agentThreadId),model=id(p.item.model);
   if(child&&model&&!this.threads.get(child)?.model)this.thread({id:child,model});
  }
  if(message.method==='thread/settings/updated'){
   if(p.threadSettings)this.thread({id:threadId},p.threadSettings);return;
  }
  if(message.method==='thread/tokenUsage/updated'){
   const current=tokens(p.tokenUsage?.total),previous=this.baselines.get(threadId);this.rememberBaseline(threadId,current);
   const row=key?this.rows.get(key):null;if(!row)return;
   const used=n(p.tokenUsage?.last?.totalTokens),window=n(p.tokenUsage?.modelContextWindow);
   if(used!==null&&window>0)row.context={used,window};
   if(this.blockedTokenThreads.has(threadId))return;
   if(previous&&TOKEN_KEYS.some(field=>current[field]!==null&&previous[field]!==null&&current[field]<previous[field])){
    this.blockedTokenThreads.add(threadId);row.tokens=emptyTokens();row.tokensComplete=false;row.outputTokensComplete=false;this.changed();return;
   }
   if(previous&&TOKEN_KEYS.every(field=>current[field]===null||previous[field]===null||current[field]>=previous[field])){
    const delta=Object.fromEntries(TOKEN_KEYS.map(field=>[field,current[field]!==null&&previous[field]!==null?current[field]-previous[field]:null]));
    if(delta.totalTokens!==null&&((delta.outputTokens!==null&&delta.outputTokens>delta.totalTokens)||(delta.totalTokens===0&&TOKEN_KEYS.some(field=>delta[field]>0)))){
     this.blockedTokenThreads.add(threadId);row.tokens=emptyTokens();row.tokensComplete=false;row.outputTokensComplete=false;this.changed();return;
    }
    if(delta.outputTokens===null||delta.totalTokens===null)row.outputTokensComplete=false;
    if(delta.totalTokens>0){addUsage(row,delta);if(row.tokensComplete!==false)row.tokensComplete=TOKEN_KEYS.every(field=>delta[field]!==null);}
   }else{row.tokensComplete=false;row.outputTokensComplete=false;}
   const last=tokens(p.tokenUsage?.last);
   if(!this.blockedTokenThreads.has(threadId)&&(!previous||previous.totalTokens===null||last.totalTokens<=current.totalTokens-previous.totalTokens)){
    this.rememberRequest(requestReceipt({threadId,turnId,endTokens:current.totalTokens,timestamp:new Date(this.now()).toISOString(),
      tokens:last,model:row.model,provider:row.provider}));
   }
   this.changed();return;
  }
  if(!key)return;
  if(message.method==='turn/started'){
   if(this.rows.get(key)?.startedAt)return;
   const info=this.threads.get(threadId)||{},existing=this.rows.get(key),row=existing||blankRow(threadId,turnId,'light-events');if(!existing)row.account=this.currentAccount?{...this.currentAccount}:null;row.status='inProgress';row.timestamp=row.startedAt=new Date(this.now()).toISOString();row.model=row.model||info.model||null;row.provider=row.provider||info.provider||null;row.tokensComplete=this.baselines.has(threadId);row.outputTokensComplete=n(this.baselines.get(threadId)?.outputTokens)!==null;
   this.rows.set(key,row);this.active.set(key,{turnId,start:this.monotonic(),streams:new Map(),speedItems:new Map(),streamChars:0,streamMs:0});this.changed();return;
  }
  const row=this.rows.get(key),active=this.active.get(key);if(!row)return;
  if(active&&(message.method==='item/started'||message.method==='item/completed')&&id(p.item?.id)&&
     (p.item.type==='agentMessage'||toolItems.has(p.item.type))){
   let sample=active.speedItems.get(p.item.id);
   if(!sample&&active.speedItems.size<2048){sample={};active.speedItems.set(p.item.id,sample);}
   if(sample&&!sample.done){
    if(message.method==='item/started'){
     sample.start??=this.monotonic();sample.nativeStart??=n(p.startedAtMs)??n(p.item.startedAtMs);
    }else{
     sample.done=true;
     const now=this.monotonic(),start=n(p.item.startedAtMs)??sample.nativeStart,end=n(p.completedAtMs)??n(p.item.completedAtMs);
     const duration=metric(p.item.durationMs)??(start!=null&&end!==null&&end>=start?end-start:sample.start!=null?metric(now-sample.start):null);
     const speed=row.speed??={};
     const field=p.item.type==='agentMessage'?'replyMs':'toolMs';
     if(duration!==null)speed[field]=(speed[field]??0)+duration;
     const stream=active.streams.get(p.item.id),count=n(p.contentTokenCount);
     // Content tokens and the observed decode interval must belong to the same message.
     if(field==='replyMs'&&stream&&!stream.done&&sample.start!=null&&count!==null&&now>stream.first){
      speed.decodeTokens=(speed.decodeTokens??0)+count;speed.decodeMs=(speed.decodeMs??0)+now-stream.first;
     }
     this.changed();
    }
   }
  }
  if(message.method==='item/agentMessage/delta'&&active&&typeof p.delta==='string'&&p.delta.length&&id(p.itemId)){
   const now=this.monotonic();
   if(row.performance.firstTextLatencyMs===null){row.performance.firstTextLatencyMs=Math.max(0,now-active.start);this.changed();}
   let stream=active.streams.get(p.itemId);if(!stream){if(active.streams.size>=200)return;stream={first:now,last:now,afterFirstChars:0,done:false};active.streams.set(p.itemId,stream);}else if(!stream.done){stream.last=now;let chars=0;for(const _ of p.delta)chars++;stream.afterFirstChars+=chars;}
   return;
  }
  if(message.method==='item/completed'&&active&&p.item?.type==='agentMessage'&&this.finishStream(active,row,p.item.id))this.changed();
  if(message.method==='turn/completed'){
   if(active){for(const itemId of active.streams.keys())this.finishStream(active,row,itemId);row.performance.durationMs=metric(p.turn?.durationMs)??Math.max(0,this.monotonic()-active.start);}
   else if(metric(p.turn?.durationMs)!==null)row.performance.durationMs=metric(p.turn.durationMs);
   row.completedAt=new Date(this.now()).toISOString();row.status=statuses.has(p.turn?.status)?p.turn.status:'unknown';this.active.delete(key);this.changed();
  }
 }
 finishStream(active,row,itemId){const stream=active.streams.get(itemId);if(!stream||stream.done)return false;stream.done=true;const elapsed=stream.last-stream.first;if(elapsed<=0||!stream.afterFirstChars)return false;active.streamChars+=stream.afterFirstChars;active.streamMs+=elapsed;row.performance.textCharsPerSecond=active.streamChars/(active.streamMs/1000);return true;}
 recoveryThreads(){
  const priorities=new Map();
  const detailed=new Set([...this.requests.values()].map(r=>keyFor(r.threadId,r.turnId)));
  for(const row of this.rows.values()){
   const rank=!row.model?3:!row.provider?2:(!row.tokensComplete||!detailed.has(row.id))&&n(row.tokens.totalTokens)!==null?1:0;
   if(rank>0)priorities.set(row.threadId,Math.max(rank,priorities.get(row.threadId)||0));
  }
  return priorities;
 }
 recoverLocalModels(scan){
  const evidence=new Map();
  for(const session of scan.sessions||[]){
   if(session.turnAttribution==='deferred')continue;
   for(const turn of session.turns||[]){
    if(!id(session.threadId)||!id(turn.turnId))continue;
    const key=keyFor(session.threadId,turn.turnId);let entry=evidence.get(key);if(!entry){entry={models:new Set(),providers:new Set()};evidence.set(key,entry);}
    if(id(turn.model))entry.models.add(turn.model);if(providerId(turn.provider))entry.providers.add(turn.provider);
   }
  }
  let updatedRows=0,modelRows=0,providerRows=0,ambiguousRows=0;
  for(const row of this.rows.values()){
   const entry=evidence.get(row.id);if(!entry)continue;let changed=false;
   if(entry.models.size>1||entry.providers.size>1||(row.model&&entry.models.size===1&&!entry.models.has(row.model))||(row.provider&&entry.providers.size===1&&!entry.providers.has(row.provider))){ambiguousRows++;continue;}
   // Exact thread + turn context only. Never fill historical rows from current defaults or another turn.
   if(!row.model&&entry.models.size===1){row.model=[...entry.models][0];modelRows++;changed=true;}
   if(!row.provider&&entry.providers.size===1){row.provider=[...entry.providers][0];providerRows++;changed=true;}
   if(changed)updatedRows++;
  }
  if(updatedRows)this.changed();
  return {updatedRows,modelRows,providerRows,ambiguousRows};
 }
 importLocal(scan,{publishLocal=true}={}){
  const recovered=this.recoverLocalModels(scan);
  const requestRows=[];
  const overlap=new Set(scan.overlappingThreadIds||[]),out=new Map();let excluded=0;
  for(const session of scan.sessions||[]){
   if(!overlap.has(session.threadId)&&session.attribution==='observed-differences-only'){
    for(const request of session.requests||[])requestRows.push(request);
   }
   if(session.attribution!=='observed-differences-only')excluded++;
   for(const t of session.turns||[]){const row=out.get(keyFor(session.threadId,t.turnId))||blankRow(session.threadId,t.turnId,'local-codex-jsonl');Object.assign(row,{submissionCount:null,model:row.model||id(t.model),provider:row.provider||providerId(t.provider),startedAt:row.startedAt||iso(t.startedAt),completedAt:row.completedAt||iso(t.completedAt),status:statuses.has(t.status)&&!['inProgress','unknown'].includes(t.status)?t.status:row.status});row.timestamp=row.startedAt||row.completedAt;if(row.startedAt&&row.completedAt){const duration=Date.parse(row.completedAt)-Date.parse(row.startedAt);row.performance.durationMs=duration>=0?duration:null;}out.set(row.id,row);}
   for(const inc of !overlap.has(session.threadId)&&session.attribution==='observed-differences-only'?session.increments||[]:[]){
    const turn=id(inc.turnId),key=turn?keyFor(session.threadId,turn):'usage:'+createHash('sha256').update(JSON.stringify([session.threadId,session.sourceId,inc.record])).digest('hex');let row=out.get(key);
    if(!row){row=blankRow(session.threadId,turn,'local-codex-jsonl');row.submissionCount=null;row.id=key;row.kind=turn?'turn':'usage-observation';row.timestamp=iso(inc.timestamp);row.model=id(inc.model);row.provider=providerId(inc.provider);out.set(key,row);}
    if(!row.timestamp)row.timestamp=iso(inc.timestamp);
    addUsage(row,tokens(inc.tokens));
   }
  }
  for(const row of out.values())row.unknownTokenFields=TOKEN_KEYS.filter(key=>row.tokens[key]===null);
  // Recover only a uniquely identified, fully covered native turn; never add local totals to live totals.
  const proofs=new Map();for(const session of scan.sessions||[]){if(overlap.has(session.threadId)||session.attribution!=='observed-differences-only')continue;for(const turn of session.turns||[]){if(turn.coverageComplete!==true)continue;const key=keyFor(session.threadId,turn.turnId);proofs.set(key,(proofs.get(key)||0)+1);}}
  let tokenRows=0;for(const row of out.values()){if(proofs.get(row.id)!==1||row.unknownTokenFields.length||row.kind!=='turn')continue;row.tokensComplete=true;row.outputTokensComplete=true;row.tokenSource='verified-local-turn';const live=this.rows.get(row.id);if(!live||live.tokensComplete||live.status==='inProgress'||live.model!==row.model||live.provider!==row.provider)continue;if(TOKEN_KEYS.some(k=>n(live.tokens[k])!==null&&live.tokens[k]>row.tokens[k]))continue;live.tokens={...row.tokens};live.tokensComplete=true;live.outputTokensComplete=true;live.unknownTokenFields=[];live.tokenSource='verified-local-turn';tokenRows++;}if(tokenRows)this.changed();recovered.tokenRows=tokenRows;

  let added=0;
  for(const request of requestRows.filter(r=>this.rows.has(keyFor(r.threadId,r.turnId))).sort((a,b)=>a.timestamp.localeCompare(b.timestamp)).slice(-this.limit)){
   const oldest=this.requests.values().next().value;
   if(this.requests.size>=this.limit&&oldest&&request.timestamp<=oldest.timestamp)continue;
   if(this.rememberRequest(request))added++;
  }
  recovered.requestRows=added;if(added)this.changed();
  if(publishLocal){
   this.localRequests=requestRows.sort((a,b)=>b.timestamp.localeCompare(a.timestamp)).slice(0,this.limit);
   this.localRows=[...out.values()].sort((a,b)=>(b.timestamp||'').localeCompare(a.timestamp||'')).slice(0,this.limit);this.localCoverage={partial:scan.partial||out.size>this.limit||excluded>0||overlap.size>0,excludedOverlappingThreads:overlap.size,excludedAmbiguousSessions:excluded};this.revision++;
  }
  return {recovered};
 }
 sessionSpeed(threadId,history){
  if(!id(threadId))throw error('对话标识无效');
  let replyMs=null,toolMs=null,decodeMs=0,decodeTokens=0,turnMs=0,turnTokens=0;
  const counted=new Set();
  for(const rows of [this.rows.values(),this.localRows])for(const row of rows){
   if(row.threadId!==threadId||row.kind!=='turn')continue;
   const s=row.speed;
   if(s&&row.source==='light-events'){
    if(metric(s.replyMs)!==null)replyMs=(replyMs??0)+s.replyMs;
    if(metric(s.toolMs)!==null)toolMs=(toolMs??0)+s.toolMs;
    if(s.decodeMs>0&&n(s.decodeTokens)!==null){decodeMs+=s.decodeMs;decodeTokens+=s.decodeTokens;}
   }
   if(!counted.has(row.turnId)&&turnThroughput(row)!==null){
    counted.add(row.turnId);turnMs+=row.performance.durationMs;turnTokens+=row.tokens.outputTokens;
   }
  }
  return {replyMs,toolMs,ttftMs:history?.ttftMs??null,partialHistory:history?.partial===true,
   tps:decodeMs>0?1000*decodeTokens/decodeMs:null,turnTps:turnMs>0?1000*turnTokens/turnMs:null};
 }
 sessionCost(threadId, historyGroups = [], throughTokens = null) {
  if(!id(threadId))throw error('对话标识无效');
  const references=new Map();
  const ids=new Set();
  for(const records of [this.rows.values(),this.localRows])for(const row of records)if(row.threadId===threadId&&row.kind==='turn')ids.add(row.turnId);
  const rows=this.usageRows(threadId,ids);
  const summarize=records=>{
   let usd=null, coveredTokens=0, partial=false, reason=null;
   for(const row of records){
    const estimate=cost(row,this.pricing,references);
    if(estimate.usd!==null)usd=(usd??0)+estimate.usd;
    if(estimate.complete)coveredTokens+=row.tokens.totalTokens??0;
    else{partial=true;reason??=estimate.reason;}
   }
   return {usd,coveredTokens,partial,reason};
  };
  const observed=summarize(rows);
  const receipts=[...this.requests.values()].filter(r=>r.threadId===threadId);
  const records=historyGroups.map(group=>({...group,tokensComplete:true}));
  if(n(throughTokens)!==null)for(const receipt of receipts){
   if(receipt.endTokens-receipt.tokens.totalTokens>=throughTokens)records.push({...receipt,tokensComplete:true});
  }
  const history=summarize(records);
  const perRequest=summarize(receipts.map(receipt=>({...receipt,tokensComplete:true})));
  if(perRequest.usd!==null && perRequest.coveredTokens>=Math.max(history.coveredTokens,observed.coveredTokens) && perRequest.coveredTokens>0)return perRequest;
  // A recovered log and live observations may describe the same requests.
  if(history.coveredTokens>observed.coveredTokens || observed.usd===null && history.usd!==null)return history;
  if(!ids.size && historyGroups.length)return history;
  return observed;
 }
 *usageRows(threadId, requested){
  const local=new Map(this.localRows.filter(row=>row.kind==='turn'&&row.threadId===threadId&&requested.has(row.turnId)).map(row=>[row.turnId,row]));
  for(const turnId of requested){
   const live=this.rows.get(keyFor(threadId,turnId)),history=local.get(turnId);
   const compatible=history&&(!live?.model||!history.model||live.model===history.model)&&(!live?.provider||!history.provider||live.provider===history.provider);
   const preferHistory=compatible&&live?.status!=='inProgress'&&!live?.tokensComplete&&(history.tokensComplete||!live||Object.values(live.tokens).every(value=>value===null));
   const row=preferHistory?history:live||history;
   if(row)yield row;
  }
 }
 turnUsage(input){
  if(!input||Object.keys(input).sort().join(',')!=='threadId,turnIds'||!id(input.threadId)||!Array.isArray(input.turnIds)||input.turnIds.length>100||input.turnIds.some(value=>!id(value)))throw error('回合用量查询参数无效');
  const references=new Map(),turns=[];
  for(const row of this.usageRows(input.threadId,new Set(input.turnIds))){
   turns.push({turnId:row.turnId,model:row.model,provider:row.provider,tokens:{...row.tokens},tokensComplete:row.tokensComplete,estimatedCost:cost(row,this.pricing,references),context:this.rows.get(keyFor(input.threadId,row.turnId))?.context??null});
  }
  return {turns};
 }
 requestDetails(parents,receipts){
  const groupKey=r=>JSON.stringify([r.threadId,r.turnId,r.turnId?null:r.timestamp]);
  const parentsByKey=new Map(parents.map(row=>[groupKey(row),row])),byTurn=new Map(),out=[];
  for(const receipt of receipts){
   const key=groupKey(receipt),parent=parentsByKey.get(key);
   const row={...receipt,id:requestKey(receipt),kind:'request',account:parent?.account??null,
    model:receipt.model??parent?.model??null,provider:receipt.provider??parent?.provider??null,
    tokensComplete:true,outputTokensComplete:true,performance:{},status:'metered'};
   out.push(row);
   let used=byTurn.get(key);if(!used){used=Object.fromEntries(TOKEN_KEYS.map(k=>[k,0]));byTurn.set(key,used);}
   for(const field of TOKEN_KEYS)used[field]=plus(used[field],receipt.tokens[field]);
  }
  for(const parent of parents){
   const used=byTurn.get(groupKey(parent));
   if(!used){out.push(parent);continue;}
   if(parent.kind==='turn')out.push({...parent,metricsOnly:true});
   if(parent.tokens.totalTokens>used.totalTokens){
    const remaining=Object.fromEntries(TOKEN_KEYS.map(k=>[k,parent.tokens[k]!=null&&used[k]!=null&&parent.tokens[k]>=used[k]?parent.tokens[k]-used[k]:null]));
    out.push({...parent,id:'remainder:'+parent.id,kind:'remainder',tokens:remaining,performance:{},submissionCount:null});
   }
  }
  return out;
 }
 quotaEstimate(account,limits,at=this.now()){
  const identity=publicAccountIdentity(account);
  if(identity?.type!=='chatgpt'||!identity.id)return {windows:[],reason:'需要可识别的 ChatGPT 订阅账户。'};
  const buckets=limits?.rateLimitsByLimitId;
  const quota=buckets&&Object.keys(buckets).length?buckets.codex:limits?.rateLimits;
  if(!quota||quota.limitId&&quota.limitId!=='codex'||quota.planType&&identity.planType&&quota.planType!==identity.planType)return {windows:[],reason:'当前账户没有可匹配的 Codex 额度窗口。'};
  const windows=[],references=new Map();
  for(const slot of ['primary','secondary']){
   const window=quota[slot];
   if(!window)continue;
   const {usedPercent,windowDurationMins,resetsAt}=window, end=resetsAt*1000,start=end-windowDurationMins*60000;
   if(!Number.isSafeInteger(windowDurationMins)||windowDurationMins<=0||!Number.isSafeInteger(resetsAt)||!(start<=at&&at<end)||!Number.isFinite(usedPercent)||usedPercent<0||usedPercent>100)continue;
   let spentUsd=0,count=0,unpriced=0,customProvider=false;
   for(const receipt of this.requests.values()){
    const parent=this.rows.get(keyFor(receipt.threadId,receipt.turnId)),time=Date.parse(receipt.timestamp);
    if(time<start||time>at||parent?.account?.id!==identity.id||parent.account.planType!==identity.planType)continue;
    const provider=receipt.provider??parent.provider;
    customProvider ||= provider!==null && provider!=='openai';
    const priced=cost({...receipt,model:receipt.model??parent.model,provider,tokensComplete:true},this.pricing,references);
    count++;if(priced.complete)spentUsd+=priced.usd;else unpriced++;
   }
   const estimate=count&&!unpriced&&usedPercent>0?spentUsd/(usedPercent/100):null;
   const estimatedTotalUsd=Number.isFinite(estimate)?estimate:null;
   // Older open clients still read the remaining amount from this response.
   const remainingUsd=usedPercent===100?0:estimatedTotalUsd===null?null:estimatedTotalUsd-spentUsd;
   windows.push({slot,windowDurationMins,startsAt:start/1000,resetsAt,usedPercent,spentUsd:count>unpriced?spentUsd:null,count,unpriced,customProvider,estimatedTotalUsd,remainingUsd});
  }
  return {windows,asOf:at,reason:windows.length?null:'尚无当前重置周期的额度数据。'};
 }
 query(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['scope','from','to','bucket','model','provider','account','cursor','limit','detailLevel'].includes(key))||input.detailLevel!==undefined&&input.detailLevel!=='request')throw error('统计查询参数无效');
  const {scope='light',bucket='day',limit=30}=input;if(!['light','local'].includes(scope)||!['hour','day'].includes(bucket)||!Number.isInteger(limit)||limit<1||limit>100)throw error('统计范围或分页参数无效');
  for(const field of ['model','provider','account'])if(input[field]!==undefined&&!id(input[field]))throw error('统计筛选参数无效');
  const from=input.from===undefined?null:iso(input.from),to=input.to===undefined?null:iso(input.to);if((input.from!==undefined&&!from)||(input.to!==undefined&&!to)||(from&&to&&from>=to))throw error('统计日期范围无效');
  const signature=createHash('sha256').update(JSON.stringify({scope,bucket,from,to,model:input.model||null,provider:input.provider||null,account:input.account||null,limit,detailLevel:input.detailLevel})).digest('hex');let snapshot,offset=0;
  if(input.cursor!==undefined){
   if(typeof input.cursor!=='string'||input.cursor.length>300)throw error('统计分页游标无效');let cursor;try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());}catch{throw error('统计分页游标无效');}
   if(!cursor||typeof cursor!=='object'||Array.isArray(cursor)||Object.keys(cursor).sort().join(',')!=='id,offset'||typeof cursor.id!=='string')throw error('统计分页游标无效');
   snapshot=this.snapshots.get(cursor.id);if(!snapshot||snapshot.signature!==signature||!Number.isSafeInteger(cursor.offset)||cursor.offset<0||cursor.offset>snapshot.rows.length||this.now()-snapshot.created>300000)throw error('统计分页已过期，请刷新统计');offset=cursor.offset;
  }else{
   const references=new Map();
   const parents=scope==='light'?[...this.rows.values()]:this.localRows;
   const records=input.detailLevel?this.requestDetails(parents,scope==='light'?this.requests.values():this.localRequests):parents;
   const rows=records.filter(row=>(!from||row.timestamp&&row.timestamp>=from)&&(!to||row.timestamp&&row.timestamp<to)&&(!input.model||row.model===input.model)&&(!input.provider||row.provider===input.provider)&&(!input.account||(row.account?.id||'unknown')===input.account)).map(row=>({...structuredClone(row),performance:{...row.performance,turnOutputTokensPerSecond:turnThroughput(row)},estimatedCost:cost(row,this.pricing,references)})).sort((a,b)=>(b.timestamp||'').localeCompare(a.timestamp||'')||a.id.localeCompare(b.id));
   const identity=randomBytes(12).toString('hex');snapshot={id:identity,signature,created:this.now(),rows,pricing:this.pricing.status()};this.snapshots.set(identity,snapshot);while(this.snapshots.size>8)this.snapshots.delete(this.snapshots.keys().next().value);
  }
  const rows=snapshot.rows,group=(field)=>{const groups=new Map();for(const row of rows){const key=row[field];if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}return [...groups].map(([key,items])=>({[field]:key,...aggregate(items)})).sort((a,b)=>b.rowCount-a.rowCount);};
  const buckets=new Map(),duration=bucket==='hour'?3600000:86400000;for(const row of rows){if(!row.timestamp)continue;const time=Math.floor(Date.parse(row.timestamp)/duration)*duration,start=new Date(time).toISOString();if(!buckets.has(start))buckets.set(start,[]);buckets.get(start).push(row);}
  const notes=['回合/提交数量不是上游模型API请求数。','Token仅累加有可验证基线的观察差分，首段缺失或重放不补猜。','回合平均输出为已完成回合的输出tokens/整轮秒数，包含思考、工具和等待，不是纯模型生成速度。','首次可见输出等待不是API TTFT；缺少对应推理耗时时不展示模型生成tok/s。','本地日志、本应用观测和官方账户统计不可相加。','费用仅为可匹配模型及provider的社区参考估算，不是账单。'];
  const accounts=new Map();for(const row of rows){const key=row.account?.id||'unknown';if(!accounts.has(key))accounts.set(key,{account:key,label:row.account?.label||'历史账户未知',rows:[]});accounts.get(key).rows.push(row);}
  const details=rows.filter(row=>!row.metricsOnly);
  const totals=aggregate(rows);
  if(input.detailLevel)totals.requestCount=details.filter(row=>row.kind==='request').length;
  return {scope,currentAccount:this.currentAccount,accounts:[...accounts.values()].map(({rows,...entry})=>({...entry,...aggregate(rows)})),generatedAt:new Date(this.now()).toISOString(),totals,trend:[...buckets].sort(([a],[b])=>a.localeCompare(b)).map(([start,items])=>({start,...aggregate(items)})),models:group('model'),providers:group('provider'),details:{data:details.slice(offset,offset+limit),total:details.length,nextCursor:offset+limit<details.length?Buffer.from(JSON.stringify({id:snapshot.id,offset:offset+limit})).toString('base64url'):null},
   coverage:{source:scope==='light'?'light-events':'local-codex-jsonl',partial:(scope==='light'?this.truncated:this.localCoverage.partial)||rows.some(row=>!row.tokensComplete),knownModelRows:rows.filter(row=>row.model!==null).length,unknownModelRows:rows.filter(row=>row.model===null).length,excludedOverlappingThreads:scope==='local'?this.localCoverage.excludedOverlappingThreads:0,excludedAmbiguousSessions:scope==='local'?this.localCoverage.excludedAmbiguousSessions:0,tokenRows:Object.fromEntries(TOKEN_KEYS.map(key=>[key,rows.filter(row=>row.tokens[key]!==null).length])),completeTokenRows:rows.filter(row=>row.tokensComplete).length,cacheHitRows:rows.filter(row=>row.tokens.inputTokens!==null&&row.tokens.cachedInputTokens!==null&&row.tokens.cachedInputTokens<=row.tokens.inputTokens).length,observedTurns:rows.filter(row=>row.kind==='turn').length,usageObservations:rows.filter(row=>row.kind==='usage-observation').length,retainedLimit:this.limit,persistenceWarning:this.persistenceWarning,notes},pricing:snapshot.pricing,dsh:{available:false,reason:'公开任务事件尚无已核实的用量和生成性能口径；不读取私有供应商账户或猜测费用。'}};
 }
 setAccount(raw){this.currentAccount=publicAccountIdentity(raw);}
 async close(){for(const [key] of this.active){const row=this.rows.get(key);if(row?.status==='inProgress')row.status='unknown';}this.active.clear();await this.flush();}
}
