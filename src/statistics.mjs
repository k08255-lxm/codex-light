import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {estimateTokenCost} from '../public/token-pricing.js';

export const STATISTICS_LIMIT=5000;
const MAX_BYTES=8*1024*1024;
const TOKEN_KEYS=['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
const METRICS=['firstTextLatencyMs','durationMs','textCharsPerSecond'];
const statuses=new Set(['inProgress','completed','failed','interrupted','unknown']);
const n=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const metric=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x20\x7f]/.test(value)?value:null;
const providerId=value=>typeof value==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(value)?value:null;
const iso=value=>typeof value==='string'&&value.length<64&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const emptyTokens=()=>Object.fromEntries(TOKEN_KEYS.map(key=>[key,null]));
const tokens=value=>Object.fromEntries(TOKEN_KEYS.map(key=>[key,n(value?.[key])]));
const emptyMetrics=()=>Object.fromEntries(METRICS.map(key=>[key,null]));
const keyFor=(thread,turn)=>JSON.stringify([thread,turn]);
const plus=(a,b)=>n(a)!==null&&n(b)!==null&&Number.isSafeInteger(a+b)?a+b:null;
const error=message=>Object.assign(new Error(message),{status:400,outcome:'notExecuted'});
const blankRow=(threadId,turnId,source)=>({id:keyFor(threadId,turnId),kind:'turn',threadId,turnId,source,timestamp:null,startedAt:null,completedAt:null,model:null,provider:null,status:'unknown',submissionCount:0,tokens:emptyTokens(),tokensComplete:false,outputTokensComplete:false,unknownTokenFields:[],performance:emptyMetrics()});

export function defaultStatisticsRoot(){const base=process.platform==='win32'?(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local')):(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share'));return path.join(base,'CodexLight','statistics');}
async function noLinks(target){for(let p=path.resolve(target);;p=path.dirname(p)){try{if((await fs.lstat(p)).isSymbolicLink())throw new Error('Statistics path is a link');}catch(e){if(e.code!=='ENOENT')throw e;}if(path.dirname(p)===p)return;}}
function cleanRow(raw){
 if(!raw||!id(raw.threadId)||!id(raw.turnId)||raw.source!=='light-events'||!statuses.has(raw.status))throw new Error('Invalid statistics record');
 const row=blankRow(raw.threadId,raw.turnId,'light-events');
 Object.assign(row,{timestamp:iso(raw.timestamp),startedAt:iso(raw.startedAt),completedAt:iso(raw.completedAt),model:id(raw.model),provider:providerId(raw.provider),status:raw.status,submissionCount:n(raw.submissionCount)??0,tokens:tokens(raw.tokens),tokensComplete:raw.tokensComplete===true,outputTokensComplete:raw.outputTokensComplete===true,unknownTokenFields:TOKEN_KEYS.filter(key=>raw.unknownTokenFields?.includes(key)),performance:Object.fromEntries(METRICS.map(key=>[key,metric(raw.performance?.[key])]))});
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
function cost(row,pricing){
 let estimate=null;
 if(row.provider&&row.model&&row.model.length<=200){try{estimate=estimateTokenCost({...row.tokens,model:row.model,provider:row.provider},pricing.get(row.model,row.provider));}catch{/* Exact model/provider or schema is unavailable; no price fallback. */}}
 return {kind:'reference-estimate',currency:'USD',usd:estimate?.complete?estimate.usd:null,complete:estimate?.complete===true&&row.tokensComplete===true,components:estimate?.components||[],reason:estimate?.reason||(!row.model||!row.provider?'模型或供应商未知':null)};
}
function aggregate(rows){
 const tokenTotals=Object.fromEntries(TOKEN_KEYS.map(key=>{const known=rows.map(row=>n(row.tokens[key])).filter(value=>value!==null);const sum=known.reduce((a,b)=>a+b,0);return [key,known.length&&Number.isSafeInteger(sum)?sum:null];}));
 const turns=rows.filter(row=>row.kind==='turn');
 const count=status=>turns.filter(row=>row.status===status).length;
 const completedCount=count('completed'),failedCount=count('failed'),interruptedCount=count('interrupted'),terminal=completedCount+failedCount+interruptedCount;
 const cacheRows=rows.filter(row=>n(row.tokens.inputTokens)!==null&&n(row.tokens.cachedInputTokens)!==null&&row.tokens.cachedInputTokens<=row.tokens.inputTokens);
 const input=cacheRows.reduce((a,row)=>a+row.tokens.inputTokens,0),cached=cacheRows.reduce((a,row)=>a+row.tokens.cachedInputTokens,0);
 const priced=rows.filter(row=>row.estimatedCost.usd!==null);
 const submissions=rows.map(row=>n(row.submissionCount)).filter(value=>value!==null);
 return {rowCount:rows.length,turnCount:turns.length,submissionCount:submissions.length?submissions.reduce((sum,value)=>sum+value,0):rows.length?null:0,requestCount:null,...tokenTotals,cacheHitRate:input>0?cached/input:null,
  completedCount,failedCount,interruptedCount,runningCount:count('inProgress'),unknownCount:count('unknown'),successRate:terminal?completedCount/terminal:null,errorRate:terminal?failedCount/terminal:null,interruptionRate:terminal?interruptedCount/terminal:null,
  estimatedCost:{kind:'reference-estimate',currency:'USD',usd:priced.length?priced.reduce((sum,row)=>sum+row.estimatedCost.usd,0):null,pricedRows:priced.length,unpricedRows:rows.length-priced.length,totalRows:rows.length,complete:rows.length>0&&rows.every(row=>row.estimatedCost.complete)},
  performance:{...Object.fromEntries(METRICS.map(key=>[key,percentiles(turns.map(row=>row.performance[key]))])),turnOutputTokensPerSecond:percentiles(turns.map(row=>row.performance.turnOutputTokensPerSecond)),ttftMs:null,outputTokensPerSecond:null}};
}

/** Stores bounded identity/timing/token metadata only. Never retains delta text. */
export class StatisticsService {
 constructor({pricing,root=null,now=Date.now,monotonic=()=>performance.now(),limit=STATISTICS_LIMIT}={}){
  if(root!==null&&(typeof root!=='string'||!path.isAbsolute(root)))throw new Error('Statistics root must be absolute');
  Object.assign(this,{pricing,root,now,monotonic,limit});this.rows=new Map();this.baselines=new Map();this.blockedTokenThreads=new Set();this.threads=new Map();this.active=new Map();this.localRows=[];this.localCoverage={partial:false,excludedOverlappingThreads:0,excludedAmbiguousSessions:0};this.queue=Promise.resolve();this.persistenceWarning=null;this.revision=0;this.truncated=false;this.snapshots=new Map();
 }
 async load(){
  if(!this.root)return;
  let handle;
  try{
   const file=path.join(this.root,'live.json');await noLinks(file);handle=await fs.open(file,'r');const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_BYTES)throw new Error('Statistics file too large');
   const buffer=Buffer.alloc(MAX_BYTES+1);let count=0;while(count<buffer.length){const read=await handle.read(buffer,count,buffer.length-count,null);if(!read.bytesRead)break;count+=read.bytesRead;}if(count>MAX_BYTES)throw new Error('Statistics file grew beyond limit');
   const data=JSON.parse(buffer.subarray(0,count).toString('utf8'));if(data.version!==1||!Array.isArray(data.rows)||data.rows.length>this.limit)throw new Error('Invalid statistics file');
   const loaded=data.rows.map(cleanRow);for(const row of loaded){if(row.status==='inProgress')row.status='unknown';this.rows.set(row.id,row);}this.truncated=data.truncated===true;
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
  const data=JSON.stringify({version:1,truncated:this.truncated,rows:[...this.rows.values()].map(cleanRow)});
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
 acknowledge(method,params,result){
  if(result?.thread){this.thread(result.thread,result);if(method==='thread/start'){this.rememberBaseline(result.thread.id,Object.fromEntries(TOKEN_KEYS.map(key=>[key,0])));this.blockedTokenThreads.delete(result.thread.id);}}
  if(!['turn/start','turn/steer','review/start','thread/compact/start'].includes(method))return;
  const turnId=id(result?.turn?.id)||id(result?.turnId)||[...this.rows.values()].find(row=>row.threadId===params.threadId&&row.status==='inProgress')?.turnId;if(!turnId)return;
  const key=keyFor(params.threadId,turnId);let row=this.rows.get(key);
  if(!row){row=blankRow(params.threadId,turnId,'light-events');row.timestamp=new Date(this.now()).toISOString();this.rows.set(key,row);}
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
  if(message.method==='thread/tokenUsage/updated'){
   const current=tokens(p.tokenUsage?.total),previous=this.baselines.get(threadId);this.rememberBaseline(threadId,current);
   const row=key?this.rows.get(key):null;if(!row)return;
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
   this.changed();return;
  }
  if(!key)return;
  if(message.method==='turn/started'){
   if(this.rows.get(key)?.startedAt)return;
   const info=this.threads.get(threadId)||{},row=this.rows.get(key)||blankRow(threadId,turnId,'light-events');row.status='inProgress';row.timestamp=row.startedAt=new Date(this.now()).toISOString();row.model=row.model||info.model||null;row.provider=row.provider||info.provider||null;row.tokensComplete=this.baselines.has(threadId);row.outputTokensComplete=n(this.baselines.get(threadId)?.outputTokens)!==null;
   this.rows.set(key,row);this.active.set(key,{turnId,start:this.monotonic(),streams:new Map(),streamChars:0,streamMs:0});this.changed();return;
  }
  const row=this.rows.get(key),active=this.active.get(key);if(!row)return;
  if(message.method==='item/agentMessage/delta'&&active&&typeof p.delta==='string'&&p.delta.length&&id(p.itemId)){
   const now=this.monotonic();if(row.performance.firstTextLatencyMs===null)row.performance.firstTextLatencyMs=Math.max(0,now-active.start);
   let stream=active.streams.get(p.itemId);if(!stream){if(active.streams.size>=200)return;stream={first:now,last:now,afterFirstChars:0,done:false};active.streams.set(p.itemId,stream);}else if(!stream.done){stream.last=now;let chars=0;for(const _ of p.delta)chars++;stream.afterFirstChars+=chars;}
   this.changed();return;
  }
  if(message.method==='item/completed'&&active&&p.item?.type==='agentMessage')this.finishStream(active,row,p.item.id);
  if(message.method==='turn/completed'){
   if(active){for(const itemId of active.streams.keys())this.finishStream(active,row,itemId);row.performance.durationMs=metric(p.turn?.durationMs)??Math.max(0,this.monotonic()-active.start);}
   else if(metric(p.turn?.durationMs)!==null)row.performance.durationMs=metric(p.turn.durationMs);
   row.completedAt=new Date(this.now()).toISOString();row.status=statuses.has(p.turn?.status)?p.turn.status:'unknown';this.active.delete(key);this.changed();
  }
 }
 finishStream(active,row,itemId){const stream=active.streams.get(itemId);if(!stream||stream.done)return;stream.done=true;const elapsed=stream.last-stream.first;if(elapsed>0&&stream.afterFirstChars>0){active.streamChars+=stream.afterFirstChars;active.streamMs+=elapsed;row.performance.textCharsPerSecond=active.streamChars/(active.streamMs/1000);}}
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
   if(entry.models.size>1||entry.providers.size>1||(row.model&&entry.models.size===1&&!entry.models.has(row.model))){ambiguousRows++;continue;}
   // Exact thread + turn context only. Never fill historical rows from current defaults or another turn.
   if(!row.model&&entry.models.size===1){row.model=[...entry.models][0];modelRows++;changed=true;}
   if(!row.provider&&entry.providers.size===1){row.provider=[...entry.providers][0];providerRows++;changed=true;}
   if(changed)updatedRows++;
  }
  if(updatedRows)this.changed();
  return {updatedRows,modelRows,providerRows,ambiguousRows};
 }
 importLocal(scan){
  const recovered=this.recoverLocalModels(scan);
  const overlap=new Set(scan.overlappingThreadIds||[]),out=new Map();let excluded=0;
  for(const session of scan.sessions||[]){
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
  this.localRows=[...out.values()].sort((a,b)=>(b.timestamp||'').localeCompare(a.timestamp||'')).slice(0,this.limit);this.localCoverage={partial:scan.partial||out.size>this.limit||excluded>0||overlap.size>0,excludedOverlappingThreads:overlap.size,excludedAmbiguousSessions:excluded};this.revision++;return {recovered};
 }
 query(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['scope','from','to','bucket','model','provider','cursor','limit'].includes(key)))throw error('统计查询参数无效');
  const {scope='light',bucket='day',limit=30}=input;if(!['light','local'].includes(scope)||!['hour','day'].includes(bucket)||!Number.isInteger(limit)||limit<1||limit>100)throw error('统计范围或分页参数无效');
  for(const field of ['model','provider'])if(input[field]!==undefined&&!id(input[field]))throw error('统计筛选参数无效');
  const from=input.from===undefined?null:iso(input.from),to=input.to===undefined?null:iso(input.to);if((input.from!==undefined&&!from)||(input.to!==undefined&&!to)||(from&&to&&from>=to))throw error('统计日期范围无效');
  const signature=createHash('sha256').update(JSON.stringify({scope,bucket,from,to,model:input.model||null,provider:input.provider||null,limit})).digest('hex');let snapshot,offset=0;
  if(input.cursor!==undefined){
   if(typeof input.cursor!=='string'||input.cursor.length>300)throw error('统计分页游标无效');let cursor;try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());}catch{throw error('统计分页游标无效');}
   if(!cursor||typeof cursor!=='object'||Array.isArray(cursor)||Object.keys(cursor).sort().join(',')!=='id,offset'||typeof cursor.id!=='string')throw error('统计分页游标无效');
   snapshot=this.snapshots.get(cursor.id);if(!snapshot||snapshot.signature!==signature||!Number.isSafeInteger(cursor.offset)||cursor.offset<0||cursor.offset>snapshot.rows.length||this.now()-snapshot.created>300000)throw error('统计分页已过期，请刷新统计');offset=cursor.offset;
  }else{
   const rows=(scope==='light'?[...this.rows.values()]:this.localRows).filter(row=>(!from||row.timestamp&&row.timestamp>=from)&&(!to||row.timestamp&&row.timestamp<to)&&(!input.model||row.model===input.model)&&(!input.provider||row.provider===input.provider)).map(row=>({...structuredClone(row),performance:{...row.performance,turnOutputTokensPerSecond:turnThroughput(row)},estimatedCost:cost(row,this.pricing)})).sort((a,b)=>(b.timestamp||'').localeCompare(a.timestamp||'')||a.id.localeCompare(b.id));
   const identity=randomBytes(12).toString('hex');snapshot={id:identity,signature,created:this.now(),rows,pricing:this.pricing.status()};this.snapshots.set(identity,snapshot);while(this.snapshots.size>8)this.snapshots.delete(this.snapshots.keys().next().value);
  }
  const rows=snapshot.rows,group=(field)=>{const groups=new Map();for(const row of rows){const key=row[field];if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}return [...groups].map(([key,items])=>({[field]:key,...aggregate(items)})).sort((a,b)=>b.rowCount-a.rowCount);};
  const buckets=new Map(),duration=bucket==='hour'?3600000:86400000;for(const row of rows){if(!row.timestamp)continue;const time=Math.floor(Date.parse(row.timestamp)/duration)*duration,start=new Date(time).toISOString();if(!buckets.has(start))buckets.set(start,[]);buckets.get(start).push(row);}
  const notes=['回合/提交数量不是上游模型API请求数。','Token仅累加有可验证基线的观察差分，首段缺失或重放不补猜。','回合平均输出为已完成回合的输出tokens/整轮秒数，包含思考、工具和等待，不是纯模型生成速度。','首次可见输出等待不是API TTFT；缺少对应推理耗时时不展示模型生成tok/s。','本地日志、本应用观测和官方账户统计不可相加。','费用仅为可匹配模型及provider的社区参考估算，不是账单。'];
  return {scope,generatedAt:new Date(this.now()).toISOString(),totals:aggregate(rows),trend:[...buckets].sort(([a],[b])=>a.localeCompare(b)).map(([start,items])=>({start,...aggregate(items)})),models:group('model'),providers:group('provider'),details:{data:rows.slice(offset,offset+limit),total:rows.length,nextCursor:offset+limit<rows.length?Buffer.from(JSON.stringify({id:snapshot.id,offset:offset+limit})).toString('base64url'):null},
   coverage:{source:scope==='light'?'light-events':'local-codex-jsonl',partial:(scope==='light'?this.truncated:this.localCoverage.partial)||rows.some(row=>!row.tokensComplete),knownModelRows:rows.filter(row=>row.model!==null).length,unknownModelRows:rows.filter(row=>row.model===null).length,excludedOverlappingThreads:scope==='local'?this.localCoverage.excludedOverlappingThreads:0,excludedAmbiguousSessions:scope==='local'?this.localCoverage.excludedAmbiguousSessions:0,tokenRows:Object.fromEntries(TOKEN_KEYS.map(key=>[key,rows.filter(row=>row.tokens[key]!==null).length])),completeTokenRows:rows.filter(row=>row.tokensComplete).length,cacheHitRows:rows.filter(row=>row.tokens.inputTokens!==null&&row.tokens.cachedInputTokens!==null&&row.tokens.cachedInputTokens<=row.tokens.inputTokens).length,observedTurns:rows.filter(row=>row.kind==='turn').length,usageObservations:rows.filter(row=>row.kind==='usage-observation').length,retainedLimit:this.limit,persistenceWarning:this.persistenceWarning,notes},pricing:snapshot.pricing,dsh:{available:false,reason:'公开任务事件尚无已核实的用量和生成性能口径；不读取私有供应商账户或猜测费用。'}};
 }
 async close(){for(const [key] of this.active){const row=this.rows.get(key);if(row?.status==='inProgress')row.status='unknown';}this.active.clear();await this.flush();}
}
