import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {parseLocalCodexUsage,mergeLocalCodexUsage} from './local-usage.mjs';

export const LOCAL_SCAN_LIMITS = Object.freeze({files:1000,fileBytes:8*1024*1024,totalBytes:128*1024*1024,depth:8});
const within = (root,candidate) => {const relative=path.relative(root,candidate);return relative==='' || (!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));};
const relativeId=(root,name)=>path.relative(root,name).split(path.sep).join('/');
/** Explicit, read-only scan. Never chooses a default directory or changes permissions. */
export async function scanLocalCodexUsage(directory, {signal} = {}) {
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw new TypeError('Explicit absolute directory required');
 const diagnostics=[],counts={},results=[];
 let partial=false,filesRead=0,bytesRead=0,candidates=0,entriesVisited=0,stop=false;
 const issue=(code,sourceId=null)=>{partial=true;counts[code]=(counts[code]??0)+1;if(diagnostics.length<200)diagnostics.push({code,...(sourceId?{sourceId}:{} )});};
 const fail=(error,id)=>issue(error?.code==='EACCES'||error?.code==='EPERM'?'access-denied':error?.code==='ELOOP'?'symlink-refused':'read-failed',id);
 let root;
 try {
  // Reject symlink components too, including a symlink root or ancestor.
  const absolute=path.resolve(directory),parsed=path.parse(absolute);let current=parsed.root;
  for(const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
   current=path.join(current,segment);const stat=await fs.lstat(current);if(stat.isSymbolicLink()){issue('symlink-root-refused');return finish();}
  }
  root=await fs.realpath(absolute);if(!(await fs.lstat(root)).isDirectory()){issue('not-directory');return finish();}
 }catch(error){fail(error);return finish();}
 function finish(){return {source:'local-codex-jsonl-scan',...mergeLocalCodexUsage(results),scanSource:'explicit-directory',partial,diagnostics,diagnosticCounts:counts,filesRead,bytesRead,candidates,
  limits:LOCAL_SCAN_LIMITS,coverage:'仅所选目录内未压缩 .jsonl；不含官方接口数据，不与其他来源相加。',
  raceProtection:'拒绝符号链接并校验 realpath、文件身份和大小；支持时使用 O_NOFOLLOW。此为尽力校验，不能消除所有跨平台文件替换竞态。'};}
 async function readFile(filename,id){
  let handle;
  try{
   const before=await fs.lstat(filename);
   if(before.isSymbolicLink()){issue('symlink-refused',id);return;}
   if(!before.isFile()){issue('not-regular-file',id);return;}
   if(before.size>LOCAL_SCAN_LIMITS.fileBytes){issue('file-size-limit',id);return;}
   if(bytesRead+before.size>LOCAL_SCAN_LIMITS.totalBytes){issue('total-size-limit',id);stop=true;return;}
   const resolved=await fs.realpath(filename);if(!within(root,resolved)||resolved!==filename){issue('path-changed-or-outside-root',id);return;}
   handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
   const opened=await handle.stat();
   if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino){issue('file-replaced',id);return;}
   if(opened.size>LOCAL_SCAN_LIMITS.fileBytes){issue('file-size-limit',id);return;}
   const afterPath=await fs.realpath(filename);
   if(!within(root,afterPath)||afterPath!==resolved||(await fs.lstat(filename)).isSymbolicLink()){issue('path-changed-or-outside-root',id);return;}
   if(bytesRead+opened.size>LOCAL_SCAN_LIMITS.totalBytes){issue('total-size-limit',id);stop=true;return;}
   // Read precisely the captured size, never an unbounded readFile on a growing log.
   const buffer=Buffer.alloc(opened.size);let offset=0;
   while(offset<buffer.length){
    if(signal?.aborted){issue('cancelled',id);stop=true;return;}
    const {bytesRead:n}=await handle.read(buffer,offset,buffer.length-offset,offset);bytesRead+=n;
    if(!n)break;offset+=n;
   }
   const final=await handle.stat(),finalPath=await fs.lstat(filename);
   if(offset!==opened.size||final.size!==opened.size||final.mtimeMs!==opened.mtimeMs||final.ctimeMs!==opened.ctimeMs||finalPath.isSymbolicLink()||finalPath.ino!==opened.ino||finalPath.dev!==opened.dev||await fs.realpath(filename)!==resolved){issue('file-changed-during-read',id);return;}
   let text;
   try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{issue('invalid-utf8',id);return;}
   const parsed=parseLocalCodexUsage(text,{sourceId:id});results.push(parsed);filesRead++;
   if(Object.keys(parsed.diagnosticCounts).some(code=>!['initial-baseline-unattributed','model-unknown'].includes(code)))issue('parser-diagnostics',id);
  }catch(error){fail(error,id);}finally{if(handle)await handle.close().catch(()=>{});}
 }
 async function walk(folder,depth){
  if(stop)return;
  if(signal?.aborted){issue('cancelled');stop=true;return;}
  try{
   const st=await fs.lstat(folder),resolved=await fs.realpath(folder);
   if(st.isSymbolicLink()||!within(root,resolved)||resolved!==folder){issue('symlink-or-changed-directory',relativeId(root,folder));return;}
   // opendir streams entries: do not materialize an unbounded directory listing.
   const dir=await fs.opendir(folder);
   for await(const entry of dir){
    if(stop)break;if(signal?.aborted){issue('cancelled');stop=true;break;}
    if(++entriesVisited>20000){issue('directory-entry-limit');stop=true;break;}
    const filename=path.join(folder,entry.name),id=relativeId(root,filename);
    if(entry.isSymbolicLink()){issue('symlink-refused',id);continue;}
    if(entry.isDirectory()){
     if(depth>=LOCAL_SCAN_LIMITS.depth){issue('depth-limit',id);continue;}
     await walk(filename,depth+1);continue;
    }
    if(/\.jsonl\.(?:zst|gz|zip|bz2|xz)$/i.test(entry.name)){issue('compressed-format-unsupported',id);continue;}
    if(!entry.name.toLowerCase().endsWith('.jsonl'))continue;
    candidates++;if(candidates>LOCAL_SCAN_LIMITS.files){issue('file-count-limit');stop=true;break;}
    await readFile(filename,id);
   }
  }catch(error){fail(error,relativeId(root,folder));}
 }
 await walk(root,0);return finish();
}
