import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
const MAX_FILE=10*1024*1024, MAX_TOTAL=50*1024*1024, MAX_FILES=20;
export function imageType(buffer){
 if(buffer.length>=8 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {extension:'png',mime:'image/png'};
 if(buffer.length>=3 && buffer[0]===0xff && buffer[1]===0xd8 && buffer[2]===0xff)return {extension:'jpg',mime:'image/jpeg'};
 if(buffer.length>=12 && buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP')return {extension:'webp',mime:'image/webp'};
 if(buffer.length>=6 && ['GIF87a','GIF89a'].includes(buffer.toString('ascii',0,6)))return {extension:'gif',mime:'image/gif'};
 return null;
}
export class UploadStore {
 constructor({maxFile=MAX_FILE,maxTotal=MAX_TOTAL,maxFiles=MAX_FILES,tempRoot=os.tmpdir()}={}){
  Object.assign(this,{maxFile,maxTotal,maxFiles,tempRoot});this.records=new Map();this.total=0;this.reserved=0;this.closed=false;this.directoryPromise=null;this.writes=new Set();this.closing=null;
 }
 async directory(){return this.directoryPromise ||= mkdtemp(path.join(this.tempRoot,'codex-light-images-'));}
 async add(stream,{filename='image'}={}){
  if(this.closed)throw new Error('附件服务已关闭');
  if(this.records.size+this.reserved>=this.maxFiles)throw new Error('附件数量已达上限，请在当前任务结束后重启以清理附件');
  this.reserved++;const chunks=[];let length=0;
  try{
   for await(const chunk of stream){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);length+=bytes.length;if(length>this.maxFile)throw new Error('单张图片不能超过 10 MiB');chunks.push(bytes);}
   if(this.closed)throw new Error('附件服务已关闭');
   if(this.total+length>this.maxTotal)throw new Error('本次会话附件总量已达上限');
   const bytes=Buffer.concat(chunks);const type=imageType(bytes);if(!type)throw new Error('只支持 PNG、JPEG、WebP 或 GIF 图片，不接受 SVG/可执行文件');
   const write=this.persist(bytes,type,length,filename);this.writes.add(write);
   try{return await write;}finally{this.writes.delete(write);}
  }finally{this.reserved--;}
 }
 async persist(bytes,type,length,filename){
   const id=randomUUID(), directory=await this.directory();
   if(this.closed)throw new Error('附件服务已关闭');
   // Reserve byte count before async writes so parallel uploads cannot exceed the budget.
   if(this.total+length>this.maxTotal)throw new Error('本次会话附件总量已达上限');
   this.total+=length;
   const file=path.join(directory,`${id}.${type.extension}`);
   try{await writeFile(file,bytes,{flag:'wx',mode:0o600});}catch(error){this.total-=length;throw error;}
   if(this.closed){await rm(file,{force:true});this.total-=length;throw new Error('附件服务已关闭');}
   const name=String(filename).replace(/[\x00-\x1f\x7f]/g,'').split(/[\\/]/).at(-1).slice(0,160)||`image.${type.extension}`;
   const record={id,name,size:length,mime:type.mime,path:file};this.records.set(id,record);
   return {id,name,size:length,mime:type.mime};
 }
 resolve(ids){
  if(!Array.isArray(ids)||ids.length>5||new Set(ids).size!==ids.length)throw new Error('每次最多发送 5 张不同图片');
  return ids.map(id=>{const record=this.records.get(id);if(!record)throw new Error('附件不存在或已过期，请重新选择');return {type:'localImage',path:record.path};});
 }
 async remove(id){const record=this.records.get(id);if(!record)return false;this.records.delete(id);this.total-=record.size;await rm(record.path,{force:true});return true;}
 close(){
  if(this.closing)return this.closing;
  this.closed=true;
  // Writers have finished reading and cannot be stalled by an unfinished upload stream.
  // No new writer can register after closed becomes true.
  this.closing=(async()=>{await Promise.allSettled([...this.writes]);this.records.clear();this.total=0;if(this.directoryPromise){const directory=await this.directoryPromise;await rm(directory,{recursive:true,force:true});}})();
  return this.closing;
 }
}
