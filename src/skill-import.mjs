import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {link,lstat,mkdir,open,readdir,realpath,unlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const namePattern=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const entryPattern=/^(?![.\s])[^\u0000-\u001F\u007F<>:"/\\|?*]{1,128}$/u;
const planTTL=5*60*1000, maxFiles=256, maxBytes=8*1024*1024, maxManifest=64*1024;
const fail=(message,status=400)=>Object.assign(new Error(message),{status,outcome:'notExecuted'});
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const sameNode=(a,b)=>a.dev===b.dev&&a.ino===b.ino;

async function ensureDirectory(directory,create=false){
 let info;
 try{info=await lstat(directory);}catch(error){
  if(error.code!=='ENOENT'||!create)throw error;
  try{await mkdir(directory);}catch(error){if(error.code!=='EEXIST')throw error;}
  info=await lstat(directory);
 }
 if(!info.isDirectory()||info.isSymbolicLink()||!samePath(await realpath(directory),directory))throw fail('只能使用本机的普通文件夹，不支持符号链接或重解析路径。');
 return info;
}

function checkEntry(name){
 if(!entryPattern.test(name)||/[.\s]$/u.test(name)||/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name))
  throw fail('技能中含不支持的文件名。请移除隐藏文件和非法 Windows 文件名后再试。');
}

function manifestName(bytes){
 if(!bytes||bytes.length>maxManifest)throw fail('需要位于所选文件夹顶层的 SKILL.md，且文件不超过 64 KB。');
 let source;
 try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw fail('SKILL.md 必须使用 UTF-8 编码。');}
 if(source.includes('\0'))throw fail('SKILL.md 不是有效的文本文件。');
 const header=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
 if(!header)throw fail('SKILL.md 缺少开头的技能元数据。');
 const names=[...header.matchAll(/^name:[ \t]*(?:"([a-z0-9-]+)"|'([a-z0-9-]+)'|([a-z0-9-]+))[ \t]*(?:#.*)?$/gm)];
 const name=names[0]?.slice(1).find(Boolean);
 const descriptions=[...header.matchAll(/^description:[ \t]*(\S[^\r\n]*)$/gm)];
 const description=descriptions[0]?.[1]?.trim();
 if(names.length!==1||[...header.matchAll(/^name\s*:/gm)].length!==1||!name||name.length>64||!namePattern.test(name)||descriptions.length!==1||[...header.matchAll(/^description\s*:/gm)].length!==1||!description||/^(?:null|~|''|""|#.*)$/i.test(description))
  throw fail('SKILL.md 需要有效且唯一的 name 和 description。');
 return name;
}

async function snapshot(root){
 const files=[],directories=[];let count=0,total=0;
 async function walk(directory,parts){
  if(parts.length>8)throw fail('技能文件夹层级超过 8 层。');
  const initial=await ensureDirectory(directory);
  const entries=await readdir(directory,{withFileTypes:true});
  const names=new Set();
  for(const entry of entries){
   if(++count>maxFiles)throw fail('技能包不能超过 256 个文件和目录。');
   checkEntry(entry.name);
   const key=entry.name.normalize('NFC').toLowerCase();
   if(names.has(key))throw fail('技能包存在仅大小写不同的文件名。');
   names.add(key);
   const childParts=[...parts,entry.name], file=path.join(directory,entry.name);
   if(entry.isDirectory()){directories.push(childParts);await walk(file,childParts);continue;}
   if(!entry.isFile())throw fail('技能包不能包含链接或特殊文件。');
   const before=await lstat(file);
   if(!before.isFile()||before.isSymbolicLink()||!samePath(await realpath(file),file))throw fail('技能包不能包含链接或特殊文件。');
   if(before.size>maxBytes-total)throw fail('技能包不能超过 8 MB。');
   const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
   try{
    const opened=await handle.stat();
    if(!opened.isFile()||opened.nlink!==1||!sameNode(before,opened)||opened.size!==before.size)throw fail('技能内容已变化，请重新选择。',409);
    const bytes=Buffer.alloc(opened.size);
    let cursor=0;
    while(cursor<bytes.length){
     const {bytesRead}=await handle.read(bytes,cursor,bytes.length-cursor,cursor);
     if(!bytesRead)throw fail('技能内容已变化，请重新选择。',409);
     cursor+=bytesRead;
    }
    const after=await handle.stat();
    if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||!sameNode(opened,await lstat(file)))throw fail('技能内容已变化，请重新选择。',409);
    total+=bytes.length;files.push({parts:childParts,bytes});
   }finally{await handle.close();}
  }
  if(!sameNode(initial,await ensureDirectory(directory)))throw fail('技能文件夹已变化，请重新选择。',409);
 }
 await walk(root,[]);
 const manifest=files.find(file=>file.parts.length===1&&file.parts[0]==='SKILL.md');
 const name=manifestName(manifest?.bytes);
 if(path.basename(root)!==name)throw fail('技能文件夹名称必须与 SKILL.md 中的 name 一致。');
 return {name,manifest,files,directories,total};
}

export function createSkillImporter({chooseFolder,home=os.homedir(),now=Date.now}={}){
 let selected=null,picking=false,installing=false;
 async function pick(){
  if(picking||installing)throw fail('还有一个技能导入操作未完成。',409);
  picking=true;selected=null;
  try{
   const folder=await chooseFolder();
   if(folder===null)return {plan:null};
   if(typeof folder!=='string'||folder.length>4096||folder.includes('\0')||!path.isAbsolute(folder)||(process.platform==='win32'&&!/^[a-z]:[\\/]/i.test(folder)))
    throw fail('请选择本机磁盘上的技能文件夹。');
   const source=path.resolve(folder);
   if(path.dirname(source)===source)throw fail('请选择单个技能文件夹，而不是整个磁盘。');
   const content=await snapshot(source);
   selected={...content,id:randomUUID(),expires:now()+planTTL};
   return {plan:{id:selected.id,name:content.name,fileCount:content.files.length,totalBytes:content.total}};
  }finally{picking=false;}
 }
 async function install(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='confirmed,planId'||input.confirmed!==true||typeof input.planId!=='string')
   throw fail('请确认要导入的技能。');
  if(installing||picking||!selected||selected.id!==input.planId||now()>=selected.expires)throw fail('导入确认已失效，请重新选择技能。',409);
  const {name,files,directories,manifest}=selected;selected=null;installing=true;
  try{
   const root=path.resolve(home);
   const agents=path.join(root,'.agents'),skills=path.join(agents,'skills');
   await ensureDirectory(root);
   await ensureDirectory(agents,true);
   const parent=await ensureDirectory(skills,true);
   const destination=path.join(skills,name);
   if((await readdir(skills)).some(existing=>existing.toLowerCase()===name))throw fail('同名技能已存在，未覆盖任何文件。',409);
   try{await mkdir(destination);}catch(error){if(error.code==='EEXIST')throw fail('同名技能已存在，未覆盖任何文件。',409);throw error;}
   const created=await ensureDirectory(destination);
   async function checkDestination(directory){
    if(!sameNode(parent,await ensureDirectory(skills))||!sameNode(created,await ensureDirectory(destination)))throw fail('导入目录已变化。',409);
    return ensureDirectory(directory);
   }
   try{
    for(const parts of directories){
     await checkDestination(path.join(destination,...parts.slice(0,-1)));
     await mkdir(path.join(destination,...parts));
    }
    for(const {parts,bytes} of files.filter(file=>file!==manifest)){
     await checkDestination(path.join(destination,...parts.slice(0,-1)));
     const handle=await open(path.join(destination,...parts),'wx',0o600);
     try{await handle.writeFile(bytes);}finally{await handle.close();}
    }
    // Publish a complete manifest last, without replacing an existing file.
    const stage=path.join(destination,`.codecang-import-${randomUUID()}.tmp`);
    const handle=await open(stage,'wx',0o600);
    let staged;
    try{await handle.writeFile(manifest.bytes);staged=await handle.stat();}finally{await handle.close();}
    await checkDestination(destination);
    const publishing=await lstat(stage);
    if(!publishing.isFile()||!sameNode(staged,publishing)||staged.size!==publishing.size||staged.mtimeMs!==publishing.mtimeMs)
     throw fail('技能临时文件已变化。',409);
    await link(stage,path.join(destination,'SKILL.md'));
    // The staging file is an identical second link. Remove only that copy.
    try{await checkDestination(destination);if(sameNode(staged,await lstat(stage)))await unlink(stage);}catch{}
   }catch(error){
    throw Object.assign(new Error('未能完成导入，可能留下不完整的技能文件夹。请检查后再试。',{cause:error}),{status:409,outcome:'unknown'});
   }
   return {name};
  }finally{installing=false;}
 }
 return {pick,install};
}
