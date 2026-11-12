import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {imageType} from './uploads.mjs';
import {isAbsoluteWorkingDirectory} from './security.mjs';

export const ARTIFACT_LIMITS=Object.freeze({bytes:8*1024*1024,svgBytes:1024*1024,dimension:4096,pixels:16000000,frames:128,animationPixels:32000000,concurrent:4});
const allowed=new Set(['.png','.jpg','.jpeg','.webp','.gif','.ico','.svg']);
const fail=(message,code,status=400)=>Object.assign(new Error(message),{code,status,outcome:'notExecuted'});
const unsupported=()=>fail('文件不是支持的图片，或无法确认图片尺寸','ARTIFACT_FORMAT_UNSUPPORTED',415);
const safeId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x20\x7f]/.test(value);
const equal=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const inside=(root,file)=>{const relative=path.relative(root,file);return relative!==''&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};
function dimensions(width,height){
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw unsupported();
 if(width>ARTIFACT_LIMITS.dimension||height>ARTIFACT_LIMITS.dimension||width*height>ARTIFACT_LIMITS.pixels)throw fail('图片尺寸超过预览上限','ARTIFACT_DIMENSION_LIMIT',413);
 return {width:Math.ceil(width),height:Math.ceil(height)};
}
function pngSize(bytes){
 if(bytes.length<33||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')throw unsupported();const size=dimensions(bytes.readUInt32BE(16),bytes.readUInt32BE(20));let frames=0,pixels=0;
 for(let offset=8;offset+12<=bytes.length;){
  const length=bytes.readUInt32BE(offset),kind=bytes.toString('ascii',offset+4,offset+8),start=offset+8;if(start+length+4>bytes.length)throw unsupported();
  if(kind==='acTL'){if(length!==8)throw unsupported();if(bytes.readUInt32BE(start)>ARTIFACT_LIMITS.frames)throw fail('动画帧数超过预览上限','ARTIFACT_FRAME_LIMIT',413);}
  if(kind==='fcTL'){if(length!==26)throw unsupported();const frame=dimensions(bytes.readUInt32BE(start+4),bytes.readUInt32BE(start+8));pixels+=frame.width*frame.height;if(frame.width>size.width||frame.height>size.height)throw unsupported();if(++frames>ARTIFACT_LIMITS.frames||pixels>ARTIFACT_LIMITS.animationPixels)throw fail('动画资源超过预览上限','ARTIFACT_FRAME_LIMIT',413);}
  offset=start+length+4;
 }return size;
}
function jpegSize(bytes){
 let offset=2;
 while(offset+3<bytes.length){
  if(bytes[offset++]!==0xff)throw unsupported();while(bytes[offset]===0xff)offset++;
  const marker=bytes[offset++];if(marker===0xd9||marker===0xda)break;
  if(marker===0x01||marker>=0xd0&&marker<=0xd8)continue;
  if(offset+2>bytes.length)throw unsupported();const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)throw unsupported();
  if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
   if(length<8)throw unsupported();return dimensions(bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3));
  }offset+=length;
 }throw unsupported();
}
function gifSize(bytes){
 if(bytes.length<14)throw unsupported();const size=dimensions(bytes.readUInt16LE(6),bytes.readUInt16LE(8));
 let offset=13+((bytes[10]&0x80)?3*(2**((bytes[10]&7)+1)):0),frames=0,framePixels=0;
 const skipBlocks=()=>{for(;;){if(offset>=bytes.length)throw unsupported();const length=bytes[offset++];if(!length)return;offset+=length;if(offset>bytes.length)throw unsupported();}};
 while(offset<bytes.length){
  const marker=bytes[offset++];if(marker===0x3b){if(!frames)throw unsupported();return size;}
  if(marker===0x21){offset++;skipBlocks();continue;}
  if(marker!==0x2c||offset+9>bytes.length)throw unsupported();
  const left=bytes.readUInt16LE(offset),top=bytes.readUInt16LE(offset+2),width=bytes.readUInt16LE(offset+4),height=bytes.readUInt16LE(offset+6),flags=bytes[offset+8];dimensions(width,height);
  if(left+width>size.width||top+height>size.height)throw unsupported();
  if(++frames>ARTIFACT_LIMITS.frames)throw fail('动画帧数超过预览上限','ARTIFACT_FRAME_LIMIT',413);
  framePixels+=width*height;if(framePixels>ARTIFACT_LIMITS.animationPixels)throw fail('动画像素总量超过预览上限','ARTIFACT_FRAME_LIMIT',413);
  offset+=9+((flags&0x80)?3*(2**((flags&7)+1)):0);offset++;skipBlocks();
 }throw unsupported();
}
function webpSize(bytes){
 if(bytes.length<20||bytes.readUInt32LE(4)+8>bytes.length)throw unsupported();let size=null,frames=0,framePixels=0;
 for(let offset=12;offset+8<=bytes.length;){
  const kind=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),start=offset+8;if(start+length>bytes.length)throw unsupported();
  if(kind==='VP8X'&&length>=10)size=dimensions(1+bytes.readUIntLE(start+4,3),1+bytes.readUIntLE(start+7,3));
  else if(kind==='VP8 '&&length>=10&&bytes.subarray(start+3,start+6).equals(Buffer.from([0x9d,0x01,0x2a]))){const frame=dimensions(bytes.readUInt16LE(start+6)&0x3fff,bytes.readUInt16LE(start+8)&0x3fff);if(size&&(frame.width>size.width||frame.height>size.height))throw unsupported();size||=frame;}
  else if(kind==='VP8L'&&length>=5&&bytes[start]===0x2f){const bits=bytes.readUInt32LE(start+1),frame=dimensions((bits&0x3fff)+1,((bits>>>14)&0x3fff)+1);if(size&&(frame.width>size.width||frame.height>size.height))throw unsupported();size||=frame;}
  if(kind==='ANMF'){if(length<16)throw unsupported();const frame=dimensions(1+bytes.readUIntLE(start+6,3),1+bytes.readUIntLE(start+9,3));framePixels+=frame.width*frame.height;if(++frames>ARTIFACT_LIMITS.frames||framePixels>ARTIFACT_LIMITS.animationPixels)throw fail('动画资源超过预览上限','ARTIFACT_FRAME_LIMIT',413);}
  offset=start+length+(length&1);
 }if(!size)throw unsupported();return size;
}
function icoSize(bytes){
 if(bytes.length<6||bytes.readUInt16LE(0)!==0||bytes.readUInt16LE(2)!==1)throw unsupported();const count=bytes.readUInt16LE(4);if(!count||count>64||bytes.length<6+16*count)throw unsupported();
 let width=0,height=0;for(let i=0;i<count;i++){
  const offset=6+16*i,length=bytes.readUInt32LE(offset+8),start=bytes.readUInt32LE(offset+12);if(length<12||start<6+16*count||start+length>bytes.length)throw unsupported();const data=bytes.subarray(start,start+length);let actual;
  if(imageType(data)?.mime==='image/png')actual=pngSize(data);
  else{const header=data.readUInt32LE(0);if(header===12)actual=dimensions(data.readUInt16LE(4),data.readUInt16LE(6)/2);else if(header>=40&&length>=header)actual=dimensions(Math.abs(data.readInt32LE(4)),Math.abs(data.readInt32LE(8))/2);else throw unsupported();}
  const w=bytes[offset]||256,h=bytes[offset+1]||256;if(actual.width!==w||actual.height!==h)throw unsupported();width=Math.max(width,w);height=Math.max(height,h);
 }return dimensions(width,height);
}
function svgSize(bytes){
 if(bytes.length>ARTIFACT_LIMITS.svgBytes)throw fail('SVG 超过 1 MiB 预览上限','ARTIFACT_SIZE_LIMIT',413);
 let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw unsupported();}
 // This is format/size admission, not HTML sanitization. SVG is served only for
 // an image-context consumer; scripts/external resources are disabled there.
 if(/<!DOCTYPE|<!ENTITY/i.test(source))throw fail('不支持含 DTD 或实体声明的 SVG','ARTIFACT_SVG_UNSUPPORTED',415);
 source=source.replace(/^\uFEFF/,'').trimStart();
 if(source.startsWith('<?xml')){const end=source.indexOf('?>');if(end<0)throw unsupported();source=source.slice(end+2).trimStart();}
 while(source.startsWith('<!--')){const end=source.indexOf('-->');if(end<0)throw unsupported();source=source.slice(end+3).trimStart();}
 if(!/^<svg(?=\s|>)/.test(source))throw unsupported();
 let end=4,quote=null;for(;end<source.length;end++){const char=source[end];if(quote){if(char===quote)quote=null;}else if(char==='"'||char==="'")quote=char;else if(char==='>')break;}
 if(end===source.length)throw unsupported();let attrs=source.slice(4,end).replace(/\/\s*$/,'');const values=new Map();
 while(attrs.trim()){
  const attribute=/^\s+([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])([\s\S]*?)\2/.exec(attrs);if(!attribute||values.has(attribute[1]))throw unsupported();values.set(attribute[1],attribute[3]);attrs=attrs.slice(attribute[0].length);
 }
 if(values.get('xmlns')!=='http://www.w3.org/2000/svg')throw unsupported();
 const numeric=value=>typeof value==='string'&&/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px)?$/i.test(value.trim())?parseFloat(value):null;
 let width=numeric(values.get('width')),height=numeric(values.get('height'));const view=(values.get('viewBox')||'').trim().split(/[\s,]+/).map(Number);
 if(view.length===4&&view.every(Number.isFinite)&&view[2]>0&&view[3]>0){
  dimensions(view[2],view[3]);if(width===null&&height===null){width=view[2];height=view[3];}else if(width===null)width=height*view[2]/view[3];else if(height===null)height=width*view[3]/view[2];
 }
 if((values.has('width')&&numeric(values.get('width'))===null)||(values.has('height')&&numeric(values.get('height'))===null))throw unsupported();
 return dimensions(width,height);
}

/** Header-sniffed MIME/dimensions; final decoder acceptance belongs to the img consumer. */
export function inspectArtifact(bytes,extension){
 let mime,size;const raster=imageType(bytes);
 if(raster){mime=raster.mime;if(!({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'})[extension]||({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'})[extension]!==mime)throw unsupported();
  if(mime==='image/png')size=pngSize(bytes);
  else if(mime==='image/jpeg')size=jpegSize(bytes);else if(mime==='image/gif')size=gifSize(bytes);else size=webpSize(bytes);
 }else if(extension==='.ico'){mime='image/vnd.microsoft.icon';size=icoSize(bytes);}
 else if(extension==='.svg'){mime='image/svg+xml';size=svgSize(bytes);}
 else throw unsupported();return {mime,...size};
}

async function checkPath(target,file=false){
 const absolute=path.resolve(target),base=path.parse(absolute).root;let current=base;
 for(const part of absolute.slice(base.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const stat=await fs.lstat(current);if(stat.isSymbolicLink())throw fail('不预览符号链接或 junction 产物','ARTIFACT_LINK_REFUSED',403);if(current!==absolute||!file){if(!stat.isDirectory())throw fail('产物目录无效','ARTIFACT_PATH_INVALID',403);}}
}

export class ArtifactPreviewService {
 constructor({projects}={}){this.projects=projects;this.threads=new Map();this.pending=new Set();this.closed=false;}
 bindThread(thread){if(safeId(thread?.id)&&typeof thread.cwd==='string'&&thread.cwd.length<=4096&&isAbsoluteWorkingDirectory(thread.cwd)){this.threads.delete(thread.id);this.threads.set(thread.id,thread.cwd);while(this.threads.size>1000)this.threads.delete(this.threads.keys().next().value);}}
 async root(input){
  if((input.threadId===undefined)===(input.projectId===undefined))throw fail('预览需唯一的已知对话或项目','ARTIFACT_SCOPE_REQUIRED');
  let root;
  if(input.threadId!==undefined){if(!safeId(input.threadId))throw fail('对话标识无效','ARTIFACT_SCOPE_INVALID');root=this.threads.get(input.threadId);}
  else{if(!safeId(input.projectId))throw fail('项目标识无效','ARTIFACT_SCOPE_INVALID');root=(await this.projects?.list())?.projects?.find(project=>project.id===input.projectId)?.path;}
  if(!root)throw fail('尚未授权该项目或绑定对话目录，请先打开对应项目或对话','ARTIFACT_SCOPE_UNKNOWN',403);
  root=path.resolve(root);if(equal(root,path.parse(root).root))throw fail('不提供整个磁盘根目录的图片预览','ARTIFACT_ROOT_REFUSED',403);return root;
 }
 async preview(input){
  if(this.closed)throw fail('产物预览服务正在关闭','ARTIFACT_CLOSED',409);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['threadId','projectId','path'].includes(key)))throw fail('产物预览参数无效','ARTIFACT_INPUT_INVALID');
  if(this.pending.size>=ARTIFACT_LIMITS.concurrent)throw fail('同时预览过多图片，请稍后重试','ARTIFACT_BUSY',429);
  const operation=this.read(input);this.pending.add(operation);try{return await operation;}finally{this.pending.delete(operation);}
 }
 async read(input){
  let handle;
  try{
   const root=await this.root(input),source=input.path;
   if(typeof source!=='string'||!source||source.length>4096||/[\x00-\x1f\x7f]/.test(source)||/^\\\\[?.]\\/.test(source)||source.replace(/^[A-Za-z]:[\\/]/,'').includes(':'))throw fail('只能预览项目内本地图片路径','ARTIFACT_PATH_INVALID',403);
   if(process.platform!=='win32'&&/^[A-Za-z]:[\\/]/.test(source))throw fail('图片不属于当前项目目录','ARTIFACT_OUTSIDE_ROOT',403);
   const extension=path.extname(source).toLowerCase();if(!allowed.has(extension))throw unsupported();
   const filename=path.resolve(root,source);if(!inside(root,filename))throw fail('图片不属于当前项目目录','ARTIFACT_OUTSIDE_ROOT',403);
   await checkPath(root);await checkPath(filename,true);
   const canonicalRoot=await fs.realpath(root),canonicalFile=await fs.realpath(filename);if(!equal(canonicalRoot,root)||!inside(canonicalRoot,canonicalFile))throw fail('图片不属于当前项目目录或目录身份已变化','ARTIFACT_OUTSIDE_ROOT',403);
   const rootStat=await fs.lstat(root),before=await fs.lstat(filename);
   if(!before.isFile()||before.nlink>1)throw fail('仅预览普通且无硬链接的图片文件','ARTIFACT_FILE_REFUSED',403);
   const max=extension==='.svg'?ARTIFACT_LIMITS.svgBytes:ARTIFACT_LIMITS.bytes;if(before.size<=0||before.size>max)throw fail('图片文件超过预览大小限制','ARTIFACT_SIZE_LIMIT',413);
   handle=await fs.open(canonicalFile,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));const opened=await handle.stat();
   if(!opened.isFile()||opened.nlink>1||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw fail('产物文件已改变，请重新预览','ARTIFACT_CHANGED',409);
   const bytes=Buffer.alloc(opened.size);let count=0;while(count<bytes.length){const result=await handle.read(bytes,count,bytes.length-count,count);if(!result.bytesRead)break;count+=result.bytesRead;}
   const after=await handle.stat(),afterPath=await fs.lstat(filename),afterRoot=await fs.lstat(root);
   await checkPath(root);await checkPath(filename,true);
   if(count!==opened.size||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||afterPath.ino!==opened.ino||afterPath.dev!==opened.dev||afterPath.nlink>1||afterRoot.ino!==rootStat.ino||afterRoot.dev!==rootStat.dev||!equal(await fs.realpath(root),canonicalRoot)||!equal(await fs.realpath(filename),canonicalFile))throw fail('产物文件在读取时发生变化，请重新预览','ARTIFACT_CHANGED',409);
   return {bytes,...inspectArtifact(bytes,extension)};
  }catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')throw fail('产物图片不存在或已移动','ARTIFACT_NOT_FOUND',404);if(['EACCES','EPERM','ELOOP'].includes(error.code))throw fail('无法安全读取产物图片','ARTIFACT_ACCESS_DENIED',403);throw error;}
  finally{await handle?.close();}
 }
 async close(){this.closed=true;await Promise.allSettled([...this.pending]);this.threads.clear();}
}
