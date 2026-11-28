import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {contextFields,contextSnapshot} from '../public/context-usage.js';
import {parseLocalCodexUsage,MAX_RECOVERY_LOG_BYTES} from './local-usage.mjs';
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
export const defaultRolloutRoots=()=>['sessions','archived_sessions'].map(p=>path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),p));
const within=(root,file)=>{const r=path.relative(root,file);return r&&!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep);};
// Codex on Windows can report the same file as C:\... or \\?\C:\....
function rolloutPath(value){
 if(process.platform!=='win32'||typeof value!=='string')return value;
 if(/^\\\\\?\\[a-z]:\\/i.test(value))return value.slice(4);
 if(/^\\\\\?\\UNC\\/i.test(value))return '\\\\'+value.slice(8);
 return value;
}
async function openThreadRollout({rollout,threadId,roots=defaultRolloutRoots(),caseSensitive=false}){
 rollout=rolloutPath(rollout);
 roots=roots.map(rolloutPath);
 const samePath=caseSensitive?((a,b)=>a===b):same;
 if(typeof rollout!=='string'||!path.isAbsolute(rollout)||!roots.some(r=>within(path.resolve(r),rollout)&&(!caseSensitive||rollout.startsWith(path.resolve(r)+path.sep)))||!path.basename(rollout).endsWith('-'+threadId+'.jsonl'))return null;
 for(let p=rollout;;p=path.dirname(p)){const s=await fs.lstat(p);if(s.isSymbolicLink())throw Error('History link refused');if(path.dirname(p)===p)break;}
 if(!samePath(await fs.realpath(rollout),path.resolve(rollout)))throw Error('History path changed');
 const before=await fs.lstat(rollout);
 const handle=await fs.open(rollout,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const info=await handle.stat();
  if(!info.isFile()||info.nlink!==1||before.isSymbolicLink()||info.dev!==before.dev||info.ino!==before.ino||
   !samePath(await fs.realpath(rollout),path.resolve(rollout)))throw Error('History file changed');
  return {handle,info};
 }catch(error){await handle.close();throw error;}
}

export async function readInlineHistoryImage({rollout,threadId,imagePath,roots,caseSensitive=false}){
 const samePath=caseSensitive?((a,b)=>a===b):same;
 const opened=await openThreadRollout({rollout,threadId,roots,caseSensitive});
 if(!opened)return null;
 const {handle:h,info}=opened;
 try{
  if(info.size>256*1024*1024)return null;
  let buffer=Buffer.alloc(0),skip=false,verified=false,total=0;const start=Date.now();
  for await(const chunk of h.createReadStream({autoClose:false,highWaterMark:64*1024})){
   total+=chunk.length;if(total>256*1024*1024||Date.now()-start>8000)return null;
   buffer=Buffer.concat([buffer,chunk]);let end;
   while((end=buffer.indexOf(10))>=0){
    const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);if(skip){skip=false;continue;}
    let row;try{row=JSON.parse(line.toString('utf8'));}catch{continue;}
    if(row.type==='session_meta'){if(row.payload?.id!==threadId)return null;verified=true;continue;}
    if(!verified||row.type!=='response_item'||row.payload?.type!=='message'||row.payload?.role!=='user'||!Array.isArray(row.payload.content))continue;
    const items=row.payload.content;
    for(let i=0;i+1<items.length;i++){
     if(items[i]?.type!=='input_text'||typeof items[i].text!=='string')continue;
     const match=/^<image name=\[Image #\d+\] path="([^"\r\n]+)">\r?\n?$/.exec(items[i].text);
     if(!match||!samePath(match[1],imagePath)||items[i+1]?.type!=='input_image')continue;
     const uri=items[i+1].image_url;if(typeof uri!=='string'||uri.length>14*1024*1024)return null;
     const data=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);if(!data)return null;
     const bytes=Buffer.from(data[2],'base64');if(bytes.length>10*1024*1024||bytes.toString('base64')!==data[2])return null;
     return {bytes,mime:data[1]};
    }
   }
   if(buffer.length>32*1024*1024){buffer=Buffer.alloc(0);skip=true;}
  }
  return null;
 }finally{await h.close();}
}

const HISTORY_CONTEXT_HEAD=256*1024;
const HISTORY_CONTEXT_TAIL=4*1024*1024;
const fromLog = values => Object.fromEntries(contextFields.map(([key])=>[
 key,values?.[key.replace(/[A-Z]/g,letter=>'_'+letter.toLowerCase())],
]));

// Price only attributable counter differences, grouped by their recorded model and provider.
function historyCostGroups(bytes) {
 const usage=parseLocalCodexUsage(bytes,{sourceId:'thread-history'});
 if(usage.attribution!=='observed-differences-only')return [];
 const groups=new Map();
 for(const {model,provider,tokens} of usage.increments){
  const key=JSON.stringify([model,provider]),group=groups.get(key);
  if(!group){groups.set(key,{model,provider,tokens:{...tokens}});continue;}
  for(const field of Object.keys(tokens))group.tokens[field]=group.tokens[field]===null||tokens[field]===null?null:group.tokens[field]+tokens[field];
 }
 return [...groups.values()];
}

/** Recover only the verified thread's latest recorded token counters. */
export async function readInlineHistoryContext({rollout,threadId,roots,caseSensitive=false,onTimings,includeCost=false}){
 const opened=await openThreadRollout({rollout,threadId,roots,caseSensitive});
 if(!opened)return null;
 const {handle,info}=opened;
 try{
  async function read(position,length,asBytes=false){
   const bytes=Buffer.alloc(length);let offset=0;
   while(offset<length){
    const {bytesRead}=await handle.read(bytes,offset,length-offset,position+offset);
    if(!bytesRead)return null;
    offset+=bytesRead;
   }
   return asBytes ? bytes : bytes.toString('utf8');
  }
  const prefix=await read(0,Math.min(info.size,HISTORY_CONTEXT_HEAD));
  const firstEnd=prefix?.indexOf('\n')??-1;
  if(firstEnd<0)return null;
  const header=JSON.parse(prefix.slice(0,firstEnd));
  if(header.type!=='session_meta'||header.payload?.id!==threadId)return null;
  const offset=Math.max(0,info.size-HISTORY_CONTEXT_TAIL);
  const tail=await read(offset,info.size-offset);
  if(tail===null)return null;
  const lines=tail.split('\n');
  let snapshot=null;
  const ttfts=new Map(),meta=header.payload;
  const needsOwner=Boolean(meta.parent_thread_id||meta.forked_from_id||meta.history_base||meta.source?.subagent);
  // Copied parent events can precede the child's first explicit settings event.
  const ownerMarker=line=>{
   if(!line.includes('"thread_settings_applied"'))return false;
   try{const row=JSON.parse(line);return row.type==='event_msg'&&row.payload?.type==='thread_settings_applied'&&row.payload.thread_id===threadId;}catch{return false;}
  };
  const beforeTail=offset>0&&needsOwner ? (offset>=HISTORY_CONTEXT_HEAD?prefix:await read(0,offset)) : '';
  let owns=!needsOwner||beforeTail?.split('\n').slice(1,-1).some(ownerMarker);
  // Line zero is the header, or an incomplete record at the start of the tail.
  for(const line of lines.slice(1)){
   if(!owns&&ownerMarker(line)){owns=true;continue;}
   if(!line.includes('"session_meta"')&&(!owns||!line.includes('"token_count"')&&!(onTimings&&line.includes('"time_to_first_token_ms"'))))continue;
   let row;try{row=JSON.parse(line);}catch{continue;}
   if(row.type==='session_meta'){
    if(!needsOwner)return null;
    owns=false;snapshot=null;ttfts.clear();continue;
   }
   if(!owns||row.type!=='event_msg')continue;
   const event=row.payload;
   if(onTimings&&(event?.type==='task_complete'||event?.type==='turn_complete')){
    const {turn_id:id,time_to_first_token_ms:value,duration_ms:duration}=event;
    if(typeof id==='string'&&id.length<=256&&id.length&&Number.isSafeInteger(value)&&value>=0&&
       (!Number.isFinite(duration)||value<=duration))ttfts.set(id,value);
   }
   const usage=event?.type==='token_count'?event.info:null;
   if(!usage||typeof usage!=='object')continue;
   const candidate=contextSnapshot({threadId,turnId:event.turn_id,tokenUsage:{
    last:fromLog(usage.last_token_usage),total:fromLog(usage.total_token_usage),modelContextWindow:usage.model_context_window,
   }});
   if(candidate&&(candidate.window!==null||[...Object.values(candidate.last),...Object.values(candidate.total)].some(value=>value!==null)))snapshot=candidate;
  }
  let costGroups;
  if(includeCost){
   // Read the complete verified rollout on demand within the recovery parser's budget.
   // For larger logs the first complete tail counter establishes a fresh baseline.
   const bytes=offset===0 ? Buffer.from(tail) : info.size<=MAX_RECOVERY_LOG_BYTES
    ? await read(0,info.size,true) : Buffer.from(prefix.slice(0,firstEnd+1)+lines.slice(1).join('\n'));
   costGroups=bytes ? historyCostGroups(bytes) : [];
  }
  const after=await handle.stat();
  if(after.size<info.size||after.nlink!==1)return null;
  if(onTimings)onTimings({ttftMs:ttfts.size?[...ttfts.values()].reduce((a,b)=>a+b,0)/ttfts.size:null,partial:offset>0||!owns,...(costGroups?{costGroups,costThroughTokens:snapshot?.total?.totalTokens??null}:{})});
  return snapshot?{...snapshot,source:'history'}:null;
 }finally{await handle.close();}
}
