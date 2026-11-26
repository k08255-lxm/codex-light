import path from 'node:path';
import {lstat,mkdir,open,rename,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {compareVersions} from './update-manifest.mjs';

const SOURCES=['auto','npm','desktop'];
const VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX=8192;
const POLL_MS=30*60*1000;
const defaults=()=>({source:'auto',checkAutomatically:true,installOnRestart:false,queuedVersion:null,result:null});
const failure=message=>Object.assign(new Error(message),{outcome:'notExecuted',status:409});
const isVersion=value=>typeof value==='string'&&value.length<128&&VERSION.test(value);

async function withoutLinks(file){
 for(let current=path.resolve(file);;current=path.dirname(current)){
  try{if((await lstat(current)).isSymbolicLink())throw failure('运行引擎设置路径不可为链接');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(path.dirname(current)===current)return;
 }
}

export class RuntimeAutomationStore {
 constructor(root){this.root=root;this.file=path.join(root,'runtime-automation.json');}
 async read(){
  await withoutLinks(this.file);let handle;
  try{
   handle=await open(this.file,'r');const stat=await handle.stat();
   if(!stat.isFile()||stat.size>MAX)throw failure('运行引擎设置文件无效');
   const bytes=Buffer.alloc(MAX+1),read=await handle.read(bytes,0,bytes.length,0);
   if(read.bytesRead>MAX)throw failure('运行引擎设置文件无效');
   const state=JSON.parse(bytes.subarray(0,read.bytesRead).toString('utf8'));
   if(!state||!SOURCES.includes(state.source)||typeof state.checkAutomatically!=='boolean'||typeof state.installOnRestart!=='boolean'||(state.queuedVersion!==null&&!isVersion(state.queuedVersion)))throw failure('运行引擎设置文件无效');
   const {source,checkAutomatically,installOnRestart,queuedVersion}=state;
   const result=state.result;
   if(result!==null&&(!result||!['installing','succeeded','failed','unknown','deferred'].includes(result.outcome)||!isVersion(result.version)||!Number.isFinite(Date.parse(result.at))||(result.message!==undefined&&(typeof result.message!=='string'||result.message.length>500))))throw failure('运行引擎更新记录无效');
   if(state.queueOnce!==undefined&&typeof state.queueOnce!=='boolean')throw failure('运行引擎设置文件无效');
   return {source,checkAutomatically,installOnRestart,queuedVersion,result,...(state.queueOnce&&queuedVersion?{queueOnce:true}:{})};
  }catch(error){if(error.code==='ENOENT')return defaults();throw error;}
  finally{await handle?.close();}
 }
 async save(value){
  await withoutLinks(this.file);await mkdir(this.root,{recursive:true,mode:0o700});
  const temp=path.join(this.root,`.runtime-automation-${randomBytes(12).toString('hex')}.tmp`);
  let handle;
  try{handle=await open(temp,'wx',0o600);await handle.writeFile(JSON.stringify(value));await handle.sync();await handle.close();handle=null;await withoutLinks(this.file);await rename(temp,this.file);}
  finally{await handle?.close();await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 }
}

export class RuntimeAutomation {
 constructor({store,emit=()=>{},now=Date.now,interval=POLL_MS}){
  Object.assign(this,{store,emit,now,interval});this.state=defaults();this.queue=Promise.resolve();this.error=null;this.checkError=null;this.phase='idle';
 }
 async load(){
  try{
   this.state=await this.store.read();
   if(this.state.result?.outcome==='installing')await this.change(next=>{next.queuedVersion=null;next.result={...next.result,outcome:'unknown',message:'上次安装未确认完成。请核对当前版本后再安装。'};});
  }catch{this.error='运行引擎设置无法读取或保存，自动更新已暂停。';this.state={...defaults(),checkAutomatically:false};}
 }
 change(update){
  const job=this.queue.then(async()=>{
   if(this.error)throw failure(this.error);
   const next={...this.state};update(next);if(!next.queuedVersion)delete next.queueOnce;await this.store.save(next);this.state=next;this.emit();
  });this.queue=job.catch(()=>{});return job;
 }
 snapshot(){return {...this.state,phase:this.phase,error:this.error||this.checkError||null};}
 async configure(input,status){
  if(this.phase==='installing'||this.phase==='preflight')throw failure('启动前的引擎更新正在进行，请稍候');
  if(input&&Object.keys(input).join(',')==='queueVersion'){
   const version=input.queueVersion;
   await this.change(next=>{
    if(version!==null&&(!isVersion(version)||this.explicit||next.source==='desktop'||status.current?.source!=='npm'||status.canQueueUpgrade!==true||status.latest?.version!==version))throw failure('引擎或可升级版本已变化，请重新检查。');
    if(version===null&&!next.queueOnce)throw failure('没有待取消的单次升级。');
    next.queuedVersion=version;next.queueOnce=version!==null;
   });
   return this.snapshot();
  }
  if(!input||typeof input!=='object'||Array.isArray(input)||!Object.keys(input).length||Object.keys(input).some(key=>!['source','checkAutomatically','installOnRestart'].includes(key)))throw failure('运行引擎设置参数无效');
  if(Object.hasOwn(input,'source')&&!SOURCES.includes(input.source))throw failure('Windows 引擎来源无效');
  if(Object.hasOwn(input,'source')&&this.explicit)throw failure('此运行环境由显式路径指定');
  if(input.source&&input.source!=='auto'&&(!status[input.source]?.available||!status[input.source]?.version))throw failure(input.source==='npm'?'未找到可验证的全局 npm CLI':'未找到可验证的官方桌面内建引擎');
  for(const key of ['checkAutomatically','installOnRestart'])if(Object.hasOwn(input,key)&&typeof input[key]!=='boolean')throw failure('运行引擎设置参数无效');
  const source=input.source??this.state.source;
  if(input.installOnRestart===true&&(this.explicit||(source!=='npm'&&(source!=='auto'||status.current?.source!=='npm'))))throw failure('请先选择全局 npm CLI 作为下次启动引擎');
  await this.change(next=>{
   Object.assign(next,input);
   if((!next.installOnRestart&&!next.queueOnce)||next.source==='desktop')next.queuedVersion=null;
   if(input.installOnRestart===true&&['failed','unknown'].includes(next.result?.outcome)&&status.npm?.available&&status.npm.version)next.result=null;
  });
  await this.consider(status);
  if((input.checkAutomatically===true||input.source||input.installOnRestart===true)&&!this.closed)this.schedule(0);
  else if(input.checkAutomatically===false){clearTimeout(this.timer);this.timer=null;}
  return this.snapshot();
 }
 async consider(status){
  if(this.error||this.explicit||this.state.queueOnce||this.phase==='installing'||this.phase==='preflight')return;
  const {latest,npm,current}=status;
  if(!this.state.installOnRestart||!(this.state.source==='npm'||(this.state.source==='auto'&&current?.source==='npm'))||!latest||latest.stale||!isVersion(latest.version)||!npm?.version)return;
  let version=compareVersions(latest.version,npm.version)>0?latest.version:null;
  if(this.state.result?.outcome==='unknown'||(this.state.result?.outcome==='failed'&&this.state.result.version===version))version=null;
  if(version!==this.state.queuedVersion)await this.change(next=>{if(next.installOnRestart&&!next.queueOnce&&next.source!=='desktop')next.queuedVersion=version;});
 }
 start(runtime,source){this.runtime=runtime;this.currentSource=source;this.schedule(3500);}
 schedule(delay=this.interval){
  clearTimeout(this.timer);
  if(this.closed||this.error||this.explicit||!this.runtime||!this.state.checkAutomatically||!(this.state.source==='npm'||this.state.source==='auto'&&this.currentSource==='npm'))return;
  this.timer=setTimeout(async()=>{
   this.phase='checking';this.emit();
   try{const status=await this.runtime.check();this.checkError=null;if(!this.closed)await this.consider(status);}
   catch(error){if(!this.closed)this.checkError=String(error.message||'运行引擎更新检查失败').slice(0,500);}
   finally{this.phase='idle';if(!this.closed)this.emit();this.schedule();}
  },delay);this.timer.unref();
 }
 async beforeEngineStart(runtime,source){
  const queued=this.state.queuedVersion;
  if(this.closed||this.error||this.explicit||(!this.state.installOnRestart&&!this.state.queueOnce)||!queued)return null;
  if(source!=='npm'){
   if(source==='desktop')await this.change(next=>{next.queuedVersion=null;}).catch(()=>{this.error='运行引擎更新记录无法保存。';});
   return null;
  }
  this.phase='preflight';this.emit();
  const result=(outcome,message)=>({outcome,version:queued,at:new Date(this.now()).toISOString(),...(message?{message:String(message).slice(0,500)}:{})});
  const finish=async(outcome,message,{keep=false}={})=>this.change(next=>{if(!keep)next.queuedVersion=null;next.result=result(outcome,message);});
  try{
   let status;
   try{status=await runtime.check();}catch(error){await finish('deferred','无法重新确认待安装版本。'+error.message,{keep:true});return null;}
   if(this.closed)return null;
   if(!status.npm?.available||!status.npm.version||status.latest?.version!==queued){await finish('deferred','已检查版本或 npm 安装发生变化，请重新检查。');return null;}
   if(compareVersions(status.npm.version,queued)>=0){await finish('succeeded','已核对 npm CLI 达到计划版本。');return null;}
   await finish('installing',null,{keep:true});
   if(this.closed){await finish('deferred','更新在安装前取消。',{keep:true});return null;}
   this.phase='installing';this.emit();
   let installed;
   try{installed=await runtime.upgrade({version:queued,confirmed:true},{beforeEngineStart:true});}
   catch(error){
    const waiting=['RUNTIME_BUSY','RUNTIME_EXTERNAL_IN_USE','RUNTIME_OCCUPATION_UNKNOWN','RUNTIME_STAGE_CANCELLED'].includes(error.code);
    await finish(waiting?'deferred':error.outcome==='unknown'?'unknown':'failed',error.message,{keep:waiting});return null;
   }
   if(installed?.outcome!=='succeeded'||installed.installedVersion!==queued){await finish('unknown','引擎升级没有返回已验证的安装结果。');return null;}
   const replacement=await runtime.status();
   if(replacement.npm?.version!==queued||!replacement.npm.path){await finish('unknown','安装完成后无法确认引擎路径。');return null;}
   try{await finish('succeeded');}catch{this.error='已验证新引擎，但无法保存更新结果。';}
   return replacement.npm.path;
  }catch{this.error='运行引擎更新记录无法保存，请核对安装状态。';return null;}
  finally{this.phase='idle';this.emit();}
 }
 close(){this.closed=true;clearTimeout(this.timer);}
}
