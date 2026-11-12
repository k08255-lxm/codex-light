import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {validateAttachmentMetadata} from './attachment-policy.mjs';

export const FILE_ATTACHMENT_LIMITS=Object.freeze({fileBytes:20*1024*1024,cacheBytes:200*1024*1024,instanceFiles:20,resolveFiles:5});
export function defaultAttachmentRoot({platform=process.platform,env=process.env,home=os.homedir()}={}){
 const base=platform==='win32'?(env.LOCALAPPDATA||path.join(home,'AppData','Local')):(env.XDG_DATA_HOME||path.join(home,'.local','share'));
 if(!path.isAbsolute(base))throw new Error('Attachment data directory must be absolute');
 return path.join(base,'CodexLight','attachments');
}
async function checkedDirectory(directory,create=false){
 const absolute=path.resolve(directory),base=path.parse(absolute).root;let current=base;
 for(const part of absolute.slice(base.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);
  let info;
  try{info=await fs.lstat(current);}catch(error){if(!create||error.code!=='ENOENT')throw error;try{await fs.mkdir(current,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}info=await fs.lstat(current);}
  if(info.isSymbolicLink()||!info.isDirectory())throw new Error('Attachment directory contains symlink or non-directory');
 }
 const canonical=await fs.realpath(absolute);
 // Windows realpath can normalize case; keep canonical root from the first initialization.
 return canonical;
}
async function cacheSize(root){
 let bytes=0,entries=0;
 async function walk(folder,depth){
  if(depth>16)throw new Error('Attachment cache nesting exceeds limit');
  if(await checkedDirectory(folder)!==folder)throw new Error('Attachment cache directory changed');
  const dir=await fs.opendir(folder);
  for await(const entry of dir){
   if(++entries>10000)throw new Error('Attachment cache entry count exceeds limit');
   const filename=path.join(folder,entry.name),stat=await fs.lstat(filename);
   if(stat.isSymbolicLink())throw new Error('Attachment cache contains symlink');
   if(stat.isDirectory())await walk(filename,depth+1);
   else if(stat.isFile()){bytes+=stat.size;if(!Number.isSafeInteger(bytes)||bytes>FILE_ATTACHMENT_LIMITS.cacheBytes)throw new Error('Attachment cache exceeds 200 MiB');}
   else throw new Error('Attachment cache contains non-regular entry');
  }
 }
 await walk(root,0);return bytes;
}
export class FileAttachmentStore {
 constructor({root=defaultAttachmentRoot()}={}){
  if(typeof root!=='string'||!path.isAbsolute(root))throw new TypeError('Attachment root must be absolute');
  this.root=path.resolve(root);this.canonical=null;this.owned=new Map();this.closed=false;this.tail=Promise.resolve();
 }
 async ensureRoot(create=false){const root=await checkedDirectory(this.root,create);if(this.canonical&&this.canonical!==root)throw new Error('Attachment root changed');this.canonical=root;return root;}
 serialize(operation){const task=this.tail.then(operation);this.tail=task.catch(()=>{});return task;}
 add(stream,{filename,mime}={}){return this.serialize(async()=>{
  if(this.closed)throw new Error('Attachment store closed');
  const initial=validateAttachmentMetadata({name:filename,size:0,mime});
  if(/^image\//i.test(mime.trim())||/\.(png|jpe?g|gif|webp|bmp|tiff?|ico|svg|avif|heic|heif)[ .]*$/i.test(filename))throw new Error('Use the image attachment workflow');
  if(this.owned.size>=FILE_ATTACHMENT_LIMITS.instanceFiles)throw new Error('At most 20 files per instance');
  if(!stream||typeof stream[Symbol.asyncIterator]!=='function')throw new TypeError('Expected async byte stream');
  const root=await this.ensureRoot(true),lock=path.join(root,'.upload-lock');let lockCreated=false,lockIdentity=null,directory=null,target=null,handle=null,identity=null;
  try{
   // Atomic cross-instance/process quota reservation. A crash leaves an explicit busy lock;
   // never guess that another process's lock is stale or remove it automatically.
   try{await fs.mkdir(lock,{mode:0o700});lockCreated=true;lockIdentity=await fs.lstat(lock);}catch(e){if(e.code==='EEXIST')throw new Error('Attachment cache busy or recovery required');throw e;}
   const used=await cacheSize(root),id=randomUUID();directory=path.join(root,id);await fs.mkdir(directory,{mode:0o700});identity=await fs.lstat(directory);
   const ext=/\.([a-zA-Z0-9]{1,12})$/.exec(filename)?.[1]?.toLowerCase();
   target=path.join(directory,`attachment${ext?'.'+ext:'.bin'}`);const temporary=path.join(directory,'.upload.tmp');
   handle=await fs.open(temporary,'wx',0o600);let size=0;
   for await(const chunk of stream){
    if(this.closed)throw new Error('Attachment store closed');
    if(!(chunk instanceof Uint8Array))throw new TypeError('Attachment chunks must be bytes');
    size+=chunk.byteLength;validateAttachmentMetadata({name:filename,size,mime});
    if(used+size>FILE_ATTACHMENT_LIMITS.cacheBytes)throw new Error('Attachment cache exceeds 200 MiB');
    let offset=0;while(offset<chunk.length){const {bytesWritten}=await handle.write(chunk,offset,chunk.length-offset);if(!bytesWritten)throw new Error('Attachment write incomplete');offset+=bytesWritten;}
   }
   await handle.sync();await handle.close();handle=null;
   if(this.closed)throw new Error('Attachment store closed');
   await this.ensureRoot();const dirStat=await fs.lstat(directory);if(dirStat.isSymbolicLink()||dirStat.dev!==identity.dev||dirStat.ino!==identity.ino||await fs.realpath(directory)!==directory)throw new Error('Attachment upload directory changed');
   await fs.rename(temporary,target);
   const metadata={...validateAttachmentMetadata({name:initial.name,size,mime}),id,path:target,
    warning:initial.riskWarning?'Archive or unverified format: not executed, unpacked or parsed.':'Stored as a file reference; content is not automatically parsed or uploaded to a model.'};
   const stat=await fs.lstat(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==size)throw new Error('Attachment file changed');
   this.owned.set(id,{metadata,dev:stat.dev,ino:stat.ino,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs});return {...metadata};
  }catch(error){
   if(handle)await handle.close().catch(()=>{});
   // Remove only this attempt's known directory after identity checks, never historical cache.
   if(directory&&identity){try{const s=await fs.lstat(directory);if(!s.isSymbolicLink()&&s.dev===identity.dev&&s.ino===identity.ino&&await fs.realpath(directory)===directory){for(const name of ['.upload.tmp',...(target?[path.basename(target)]:[])])await fs.unlink(path.join(directory,name)).catch(e=>{if(e.code!=='ENOENT')throw e;});await fs.rmdir(directory);}}catch{/* Leave uncertain files rather than touch replacement/user data. */}}
   throw error;
  }finally{if(lockCreated){try{await this.ensureRoot();const s=await fs.lstat(lock);if(s.isDirectory()&&!s.isSymbolicLink()&&s.dev===lockIdentity?.dev&&s.ino===lockIdentity?.ino)await fs.rmdir(lock);}catch{/* Never recursively remove a lock that changed. */}}}
 });}
 async resolve(ids){
  if(this.closed)throw new Error('Attachment store closed');
  if(!Array.isArray(ids)||ids.length>FILE_ATTACHMENT_LIMITS.resolveFiles||new Set(ids).size!==ids.length)throw new TypeError('Resolve up to 5 distinct uploaded IDs');
  await this.ensureRoot();const resolved=[];
  for(const id of ids){const item=this.owned.get(id);if(!item)throw new Error('Attachment ID not owned by this instance');
   await checkedDirectory(path.dirname(item.metadata.path));const stat=await fs.lstat(item.metadata.path);
   if(stat.isSymbolicLink()||!stat.isFile()||stat.dev!==item.dev||stat.ino!==item.ino||stat.size!==item.metadata.size||stat.mtimeMs!==item.mtimeMs||stat.ctimeMs!==item.ctimeMs||await fs.realpath(item.metadata.path)!==item.metadata.path)throw new Error('Attachment reference changed');
   resolved.push({...item.metadata});
  }return resolved;
 }
 listOwned(){return [...this.owned.values()].map(x=>({...x.metadata}));}
 deleteOwned(id){return this.serialize(async()=>{const [metadata]=await this.resolve([id]);await fs.unlink(metadata.path);this.owned.delete(id);await fs.rmdir(path.dirname(metadata.path));return {deleted:true,id};});}
 async close(){this.closed=true;await this.tail;this.owned.clear();}
}
