import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import {promisify} from 'node:util';
import {parseLocalCodexUsage,mergeLocalCodexUsage} from './local-usage.mjs';

export const LOCAL_SCAN_LIMITS = Object.freeze({files:1000,fileBytes:32*1024*1024,totalBytes:128*1024*1024,expandedFileBytes:32*1024*1024,expandedTotalBytes:128*1024*1024,depth:8});
const within = (root,candidate) => {const relative=path.relative(root,candidate);return relative==='' || (!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));};
const relativeId=(root,name)=>path.relative(root,name).split(path.sep).join('/');
async function unlinkedDirectory(directory){
 const absolute=path.resolve(directory),parsed=path.parse(absolute);let current=parsed.root;
 for(const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){current=path.join(current,segment);if((await fs.lstat(current)).isSymbolicLink())return null;}
 const resolved=await fs.realpath(absolute);return (await fs.lstat(resolved)).isDirectory()?resolved:null;
}
/** Discovery reads directory metadata only; no session files or configuration contents. */
export async function discoverLocalCodexUsageDirectories({env=process.env,home=os.homedir()}={}){
 const candidates=[];if(typeof env.CODEX_HOME==='string'&&path.isAbsolute(env.CODEX_HOME))candidates.push(path.join(env.CODEX_HOME,'sessions'));if(typeof home==='string'&&path.isAbsolute(home))candidates.push(path.join(home,'.codex','sessions'));
 const directories=[];
 for(const candidate of candidates){try{const directory=await unlinkedDirectory(candidate);if(directory&&!directories.some(value=>process.platform==='win32'?value.toLowerCase()===directory.toLowerCase():value===directory))directories.push(directory);}catch(error){if(!['ENOENT','ENOTDIR','EACCES','EPERM','ELOOP'].includes(error.code))throw error;}}
 return {directory:directories[0]||null,directories};
}
/** Explicit, read-only scan. Never chooses a default directory or changes permissions. */
export async function scanLocalCodexUsage(directory, {signal} = {}) {
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw new TypeError('Explicit absolute directory required');
 const diagnostics=[],counts={},results=[];
 let partial=false,filesRead=0,bytesRead=0,expandedBytes=0,candidates=0,entriesVisited=0,stop=false;const files=[];
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
 function finish(){return {source:'local-codex-jsonl-scan',...mergeLocalCodexUsage(results),scanSource:'explicit-directory',partial,diagnostics,diagnosticCounts:counts,filesRead,bytesRead,expandedBytes,candidates,
  limits:LOCAL_SCAN_LIMITS,coverage:'仅读取所选目录内 .jsonl、.jsonl.gz、.jsonl.zst，按最近修改时间优先；受文件、输入及解压总量限制。不含官方接口数据，不与其他来源相加。',
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
   let decoded=buffer;
   if(/\.jsonl\.(gz|zst)$/i.test(filename)){
    const decompress=filename.toLowerCase().endsWith('.zst')?zlib.zstdDecompress:zlib.gunzip;
    if(typeof decompress!=='function'){issue('compression-runtime-unsupported',id);return;}
    const remaining=LOCAL_SCAN_LIMITS.expandedTotalBytes-expandedBytes;
    if(remaining<=0){issue('expanded-total-size-limit',id);stop=true;return;}
    const allowance=Math.min(LOCAL_SCAN_LIMITS.expandedFileBytes,remaining);
    try{decoded=await promisify(decompress)(buffer,{maxOutputLength:allowance});}catch(error){expandedBytes+=allowance;issue(error.code==='ERR_BUFFER_TOO_LARGE'?'expanded-size-limit':'decompression-failed',id);if(expandedBytes>=LOCAL_SCAN_LIMITS.expandedTotalBytes)stop=true;return;}
   }
   if(decoded.length>LOCAL_SCAN_LIMITS.expandedFileBytes){issue('expanded-file-size-limit',id);return;}
   if(expandedBytes+decoded.length>LOCAL_SCAN_LIMITS.expandedTotalBytes){issue('expanded-total-size-limit',id);stop=true;return;}expandedBytes+=decoded.length;
   if(signal?.aborted){issue('cancelled',id);stop=true;return;}
   let text;
   try{text=new TextDecoder('utf-8',{fatal:true}).decode(decoded);}catch{issue('invalid-utf8',id);return;}
   const parsed=parseLocalCodexUsage(text,{sourceId:id});results.push(parsed);filesRead++;
   if(Object.keys(parsed.diagnosticCounts).some(code=>!['initial-baseline-unattributed','model-unknown','paginated-storage'].includes(code)))issue('parser-diagnostics',id);
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
    if(/\.jsonl\.(?:zip|bz2|xz)$/i.test(entry.name)){issue('compressed-format-unsupported',id);continue;}
    if(!/\.jsonl(?:\.(?:zst|gz))?$/i.test(entry.name))continue;
    candidates++;const info=await fs.lstat(filename);if(info.isSymbolicLink()){issue('symlink-refused',id);continue;}if(!info.isFile()){issue('not-regular-file',id);continue;}files.push({filename,id,mtime:info.mtimeMs});
   }
  }catch(error){fail(error,relativeId(root,folder));}
 }
 await walk(root,0);
 if(candidates>LOCAL_SCAN_LIMITS.files)issue('file-count-limit');
 // A bounded directory walk collects metadata first, so older entries cannot consume the read budget first.
 const cancelled=signal?.aborted;stop=false;if(cancelled){if(!counts.cancelled)issue('cancelled');return finish();}
 for(const file of files.sort((a,b)=>b.mtime-a.mtime||a.id.localeCompare(b.id)).slice(0,LOCAL_SCAN_LIMITS.files)){if(stop)break;await readFile(file.filename,file.id);}
 return finish();
}
