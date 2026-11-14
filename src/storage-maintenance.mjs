import {lstat,readdir,mkdir,readFile,writeFile,unlink,open} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
const zip=promisify(gzip),unzip=promisify(gunzip),MAX_FILES=1000,MAX_BYTES=256*1024*1024,MAX_FILE=32*1024*1024;
const uuid=/^[0-9a-f-]{36}$/i,session=/^[0-9a-f]{32}$/i;
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=(message,code='STORAGE_INVALID')=>Object.assign(new Error(message),{code,status:409,outcome:'notExecuted'});
const effects={cache:'仅处理已关闭旧界面的浏览器缓存；不会清除登录、设置或对话。下次打开部分内容可能重新生成。',images:'只清理已确认未引用的图片；已发送、历史引用或引用状态未知的图片受保护，不修改 Codex 历史记录。',install:'仅处理应用下载的安装临时文件；当前安装源、系统 Installer 缓存和恢复备份不会处理。'};
export async function plain(file){for(let p=path.resolve(file);;p=path.dirname(p)){try{if((await lstat(p)).isSymbolicLink())throw fail('路径包含链接，已跳过');}catch(e){if(e.code!=='ENOENT')throw e;}if(path.dirname(p)===p)return;}}
async function bounded(file,limit=MAX_FILE){await plain(file);const h=await open(file,'r');try{const before=await h.stat();if(!before.isFile()||before.size>limit)throw fail('文件过大或类型不支持');const b=Buffer.alloc(Math.min(before.size+1,limit+1));let count=0;while(count<b.length){const r=await h.read(b,count,b.length-count,null);if(!r.bytesRead)break;count+=r.bytesRead;}if(count!==before.size||fingerprint(await h.stat())!==fingerprint(before))throw fail('文件读取期间已变化');return b.subarray(0,count);}finally{await h.close();}}
const fingerprint=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
export class StorageMaintenance {
 constructor({root,activeProfile=null,imageFiles=async()=>[],imageLease=async fn=>fn(),busy=()=>false,now=Date.now}={}){this.root=root?path.resolve(root):null;this.activeProfile=activeProfile?path.resolve(activeProfile):null;Object.assign(this,{imageFiles,imageLease,busy,now});this.plans=new Map();this.running=false;}
 async assertReady(allowBusy=false){if(!this.root)throw fail('此环境未提供本机应用存储目录','STORAGE_UNAVAILABLE');await plain(this.root);if(!allowBusy&&(this.running||this.busy()))throw fail('存在运行任务、上传或更新，请结束后重试','STORAGE_BUSY');}
 inside(file){const relative=path.relative(this.root,path.resolve(file));if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw fail('不允许访问应用目录之外的数据');return relative;}
 async candidates(category){
  const files=[],warnings=[];let observedBytes=0,protectedBytes=0,visited=0;
  const add=async(file,eligible=true,ownedTemp=false)=>{try{if(!ownedTemp||eligible)this.inside(file);await plain(file);const s=await lstat(file);if(!s.isFile())return;if(++visited>10000)throw fail('扫描达到文件数量上限');observedBytes+=s.size;if(!eligible||s.size>MAX_FILE){protectedBytes+=s.size;return;}files.push({file,size:s.size,fingerprint:fingerprint(s)});}catch(e){if(e.code!=='ENOENT')warnings.push('部分文件不可访问或不在安全范围，未列入清理');}};
  const walk=async(dir,eligible,depth=0)=>{if(depth>8||visited>10000){warnings.push('扫描范围过大，结果不完整');return;}try{await plain(dir);for(const e of await readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink()){warnings.push('已跳过链接');continue;}const p=path.join(dir,e.name);if(e.isDirectory())await walk(p,eligible,depth+1);else if(e.isFile())await add(p,eligible);}}catch(e){if(e.code!=='ENOENT')warnings.push('部分目录不可访问');}};
  if(category==='cache'){
   const base=path.join(this.root,'WebView','Sessions');let dirs=[];try{await plain(base);dirs=await readdir(base,{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')warnings.push('浏览器缓存不可访问');}
   for(const d of dirs){if(!d.isDirectory()||!session.test(d.name))continue;const profile=path.join(base,d.name);const safe=!!this.activeProfile&&profile.toLowerCase()!==this.activeProfile.toLowerCase();for(const rel of ['Default/Cache','Default/Code Cache','Default/GPUCache','GPUCache'])await walk(path.join(profile,rel),safe);}
   if(!this.activeProfile)warnings.push('无法确认当前浏览器目录，缓存仅统计，不允许清理');
  }else if(category==='images'){
   for(const item of await this.imageFiles())await add(typeof item==='string'?item:item.path,typeof item==='object'&&item.cleanupEligible===true,typeof item==='object'&&item.ownedTemp===true);warnings.push('历史内联图片属于 Codex 会话，不单独扫描或删除；当前临时图片及未知引用图片受保护'); // Store supplies owned paths only, never scan Codex history.
  }else if(category==='install'){
   const base=path.join(this.root,'Updates');let dirs=[];try{await plain(base);dirs=await readdir(base,{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')warnings.push('安装缓存不可访问');}
   for(const d of dirs){if(!d.isDirectory()||!/^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(d.name))continue;const dir=path.join(base,d.name);try{await plain(dir);for(const e of await readdir(dir,{withFileTypes:true})){if(e.isFile()&&(e.name==='CodexLight-Setup.exe'||/^[0-9a-f-]{36}\.partial$/.test(e.name)))await add(path.join(dir,e.name));}}catch{warnings.push('部分安装缓存已跳过');}}
   // MSI packages and their diagnostic/source directories are always protected, including current source.
   await walk(path.join(this.root,'SetupLogs'),false);
   warnings.push('MSI 源文件和安装记录受保护；恢复备份不计入可清理数据');
  }else throw fail('未知存储分类');
  return {files,observedBytes,protectedBytes,warnings:[...new Set(warnings)]};
 }
 async scan(){await this.assertReady(true);const categories=[];for(const category of Object.keys(effects)){const s=await this.candidates(category);categories.push({category,bytes:s.observedBytes,cleanableBytes:s.files.reduce((n,f)=>n+f.size,0),protectedBytes:s.protectedBytes,fileCount:s.files.length,warnings:s.warnings,impact:effects[category]});}return{categories,recoveries:await this.recoveries(),mode:'archive',note:'默认无损归档后清理原文件。归档仍占空间，仅压缩差额可能释放空间；不自动永久删除恢复备份。'};}
 async recoveries(){const base=path.join(this.root,'StorageRecovery'),items=[];try{await plain(base);for(const e of (await readdir(base,{withFileTypes:true})).slice(-100)){if(!e.isDirectory()||!uuid.test(e.name))continue;try{const file=path.join(base,e.name,'manifest.json'),m=JSON.parse(await bounded(file,1024*1024));if(m.version!==1||m.root!==this.root||!Object.hasOwn(effects,m.category)||!Array.isArray(m.files)||m.files.length>MAX_FILES)continue;items.push({id:e.name,category:m.category,fileCount:m.files.length,createdAt:(await lstat(file)).mtimeMs});}catch{}}}catch(e){if(e.code!=='ENOENT')return [];}return items.sort((a,b)=>b.createdAt-a.createdAt).slice(0,20);}
 async plan({category,mode='archive'}={}){
  await this.assertReady();if(!['archive','delete'].includes(mode)||(mode==='delete'&&category!=='cache'))throw fail('仅可再生的旧浏览器缓存支持逐次确认永久删除');if(this.plans.size>=16)this.plans.clear();
  const s=await this.candidates(category);let total=0;const files=[];for(const f of s.files){if(files.length>=MAX_FILES||total+f.size>MAX_BYTES)break;const bytes=await bounded(f.file);if(bytes.length!==f.size||fingerprint(await lstat(f.file))!==f.fingerprint)throw fail('扫描时文件已变化，请重试');files.push({...f,sha256:hash(bytes)});total+=f.size;}
  const id=randomUUID(),expiresAt=this.now()+120000;const manifestDigest=hash(Buffer.from(JSON.stringify(files.map(f=>[this.inside(f.file),f.fingerprint,f.sha256]))));this.plans.set(id,{category,mode,files,manifestDigest,expiresAt});return{id,manifestDigest,expiresAt,category,fileCount:files.length,bytes:total,mode,impact:effects[category],warning:'会移出本次选中的文件并保留可恢复归档。图片可能影响历史显示；归档不等于释放所有空间。',partial:files.length<s.files.length};
 }
 async apply({id,manifestDigest,confirmed}={}){
  await this.assertReady();const p=this.plans.get(id);if(confirmed!==true||!p||p.manifestDigest!==manifestDigest||p.expiresAt<this.now())throw fail('必须重新预览并确认本次清理','STORAGE_CONFIRM_REQUIRED');this.plans.delete(id);this.running=true;
  try{return await this.imageLease(async()=>{
   if(p.mode==='delete'){
    const eligible=new Set((await this.candidates('cache')).files.map(f=>f.file));let removedFiles=0,removedBytes=0;const failures=[];
    for(const f of p.files){try{if(!eligible.has(f.file))throw fail('不再符合清理条件');await plain(f.file);if(fingerprint(await lstat(f.file))!==f.fingerprint||hash(await bounded(f.file))!==f.sha256)throw fail('文件已变化');await unlink(f.file);removedFiles++;removedBytes+=f.size;}catch{failures.push('部分缓存已变化或被占用，未删除');}}
    return{outcome:failures.length?'partial':'succeeded',removedFiles,removedBytes,archiveBytes:0,recoveryId:null,estimatedNetBytes:removedBytes,failures:[...new Set(failures)],note:'本次确认的可再生旧缓存已永久删除，无法恢复；字节数是文件逻辑大小，不是实测磁盘可用空间增量。'};
   }
   const recoveryId=randomUUID(),dir=path.join(this.root,'StorageRecovery',recoveryId);await plain(dir);await mkdir(dir,{recursive:true});
   const eligible=new Set((await this.candidates(p.category)).files.map(f=>f.file));
   const manifest={version:1,root:this.root,category:p.category,files:[]};let archivedBytes=0;const failures=[];
   for(let i=0;i<p.files.length;i++){const f=p.files[i];try{if(!eligible.has(f.file))throw fail('文件已不符合清理条件');await plain(f.file);if(fingerprint(await lstat(f.file))!==f.fingerprint)throw fail('文件已变化');const bytes=await bounded(f.file);if(hash(bytes)!==f.sha256)throw fail('文件已变化');const packed=await zip(bytes);await writeFile(path.join(dir,`${i}.gz`),packed,{flag:'wx'});if(!Buffer.from(await unzip(await bounded(path.join(dir,`${i}.gz`),MAX_FILE+65536))).equals(bytes))throw fail('归档校验失败');manifest.files.push({relative:this.inside(f.file),sha256:f.sha256,size:f.size,archive:`${i}.gz`});archivedBytes+=packed.length;}catch{failures.push('部分文件已变化、被占用或归档失败，原文件保留');}}
   await writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest),{flag:'wx'});
   let removedBytes=0,removedFiles=0;for(const m of manifest.files){const f=p.files.find(x=>this.inside(x.file)===m.relative);try{await plain(f.file);if(fingerprint(await lstat(f.file))!==f.fingerprint||hash(await bounded(f.file))!==m.sha256)throw fail('文件已变化');await unlink(f.file);removedBytes+=m.size;removedFiles++;}catch{failures.push('部分原文件未能移除，已保留归档及原件');}}
   return{outcome:failures.length?'partial':'succeeded',removedFiles,removedBytes,archiveBytes:archivedBytes,recoveryId,estimatedNetBytes:removedBytes-archivedBytes,failures:[...new Set(failures)],note:'恢复归档仍占磁盘空间；估算未扣除文件系统和清单开销，不是实测可用空间。'};
  });}finally{this.running=false;}
 }
 async restore({recoveryId,confirmed}={}){
  await this.assertReady();if(confirmed!==true||!uuid.test(recoveryId||''))throw fail('恢复需要明确确认');this.running=true;try{return await this.imageLease(async()=>{
   const dir=path.join(this.root,'StorageRecovery',recoveryId);await plain(dir);await plain(path.join(dir,'manifest.json'));const raw=await bounded(path.join(dir,'manifest.json'),1024*1024);if(raw.length>1024*1024)throw fail('归档清单过大');const m=JSON.parse(raw);if(m.version!==1||m.root!==this.root||!Array.isArray(m.files)||m.files.length>MAX_FILES)throw fail('归档清单无效');let restored=0;const failures=[];
   for(const f of m.files){try{if(typeof f.relative!=='string'||!/^\d+\.gz$/.test(f.archive)||! /^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.size)||f.size<0||f.size>MAX_FILE)throw fail('清单无效');const target=path.resolve(this.root,f.relative);this.inside(target);const allowed=await this.restoreAllowed(m.category,target);if(!allowed)throw fail('恢复目标不在分类范围');await plain(target);await plain(path.join(dir,f.archive));const bytes=await unzip(await bounded(path.join(dir,f.archive),MAX_FILE+65536),{maxOutputLength:MAX_FILE});if(bytes.length!==f.size||hash(bytes)!==f.sha256)throw fail('归档校验失败');await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});restored++;}catch{failures.push('部分文件已存在、被占用或校验失败，未覆盖；归档保留');}}
   return{outcome:failures.length?'partial':'succeeded',restoredFiles:restored,failures:[...new Set(failures)],note:'归档继续保留，不自动删除。'};
  });}finally{this.running=false;}
 }
 async restoreAllowed(category,target){if(category==='cache'&&(!this.activeProfile||path.resolve(target).toLowerCase().startsWith(this.activeProfile.toLowerCase()+path.sep)))return false;const rel=this.inside(target).split(path.sep).join('/');if(category==='images')return (await this.imageFiles()).some(x=>(typeof x==='string'?x:x.path)===target)||/^images\/[0-9a-f-]{36}\.(png|jpg|webp|gif)$/i.test(rel);if(category==='install')return /^Updates\/\d+\.\d+\.\d+-[a-f0-9]{16}\/(CodexLight-Setup\.exe|[0-9a-f-]{36}\.partial)$/.test(rel);return category==='cache'&&/^WebView\/Sessions\/[0-9a-f]{32}\/(Default\/(Cache|Code Cache|GPUCache)|GPUCache)\//.test(rel);}
}
