import path from 'node:path';
import {lstat,readFile,mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';

const fail=message=>Object.assign(new Error(message),{code:'ENGINE_SETUP_FAILED',outcome:'notExecuted'});
async function noLinks(file){for(let p=path.resolve(file);;p=path.dirname(p)){try{if((await lstat(p)).isSymbolicLink())throw fail('运行环境设置路径不可为链接');}catch(e){if(e.code!=='ENOENT')throw e;}if(path.dirname(p)===p)break;}}
export class EngineSetupStore {
 constructor(root){if(!root||!path.isAbsolute(root))throw fail('缺少运行环境设置目录');this.root=root;this.file=path.join(root,'engine-setup.json');}
 async read(){await noLinks(this.file);try{const s=await lstat(this.file);if(!s.isFile()||s.size>4096)throw fail('运行环境设置记录无效');const v=JSON.parse(await readFile(this.file,'utf8'));if(v?.version!==1||!['complete','legacy','deferred'].includes(v.state))throw fail('运行环境设置记录无效');return v;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async existingUser(){for(const name of ['state.json','projects.json','wsl-runtime.json','lan-preferences.json']){const file=path.join(this.root,name);await noLinks(file);try{if((await lstat(file)).isFile())return true;}catch(e){if(e.code!=='ENOENT')throw e;}}return false;}
 async save(state){if(!['complete','legacy','deferred'].includes(state))throw fail('运行环境设置状态无效');await noLinks(this.file);await mkdir(this.root,{recursive:true});const tmp=path.join(this.root,`.engine-setup-${randomBytes(12).toString('hex')}.tmp`);try{await writeFile(tmp,JSON.stringify({version:1,state}),{flag:'wx',mode:0o600});await noLinks(this.file);await rename(tmp,this.file);}finally{await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
}

// One native candidate represents npm + official desktop. Their existing resolver
// still chooses the executable. WSL inventory never launches a distro; probe does.
export class EngineOnboarding {
 constructor({store,supported=true,nativeCandidate,listDistributions,probeDistribution,discoverRunning,saveSelection,current=()=>({target:'native'}),busy=()=>false}){Object.assign(this,{store,supported,nativeCandidate,listDistributions,probeDistribution,discoverRunning,saveSelection,current,busy});this.candidates=[];this.pending=[];this.diagnostic='';this.nativeUnresolved=false;this.required=false;this.operation=null;}
 async initialize(){this.required=false;if(!this.supported)return;const saved=await this.store.read();if(saved){this.required=false;return;}if(await this.store.existingUser()){await this.store.save('legacy');return;}this.required=true;}
 snapshot(){return {supported:this.supported,needed:this.required,candidates:this.candidates,pendingDistributions:this.pending,nativeUnresolved:this.nativeUnresolved,discoveryPending:this.pending.length>0||this.nativeUnresolved,diagnostic:this.diagnostic,current:this.current()};}
 exclusive(fn){if(this.operation)throw fail('正在处理运行环境，请稍候');const job=Promise.resolve().then(fn);this.operation=job;return job.finally(()=>{this.operation=null;});}
 async inventory(){if(!this.supported||!this.required)return this.snapshot();return this.exclusive(async()=>{
  this.diagnostic='';this.candidates=[];this.pending=[];this.nativeUnresolved=false;
  const native=Promise.resolve().then(()=>this.nativeCandidate()).then(c=>{
   if(c)this.candidates.push({...c,id:'native',label:'Windows 本机',selection:{target:'native'}});
  },error=>{this.nativeUnresolved=true;this.diagnostic=String(error.message);});
  if(this.discoverRunning){
   const [report]=await Promise.all([this.discoverRunning(),native]);
   this.pending=report.discoveryIncomplete?['未知']:report.pendingDistributions;
   this.candidates.push(...report.candidates.map(c=>this.wslCandidate(c.distribution,c)));
   if(report.diagnostic)this.diagnostic=[this.diagnostic,report.diagnostic].filter(Boolean).join(' ');
  }else{
   await native;
   try{this.pending=await this.listDistributions();}catch{this.diagnostic+=' WSL 列表未能读取，请重试或到设置手动配置。';this.pending=['未知'];}
  }
  return this.snapshot();
 });}
 wslCandidate(distribution,c){return {...c,id:`wsl:${distribution}`,label:`WSL · ${distribution}`,selection:{target:'wsl',distribution,...(c.user?{user:c.user}:{}),...(c.codexPath&&!c.passiveProbe?{codexPath:c.codexPath}:{})}};}
 async discover(){if(!this.required) return this.snapshot();return this.exclusive(async()=>{
  this.diagnostic='';let names;try{names=await this.listDistributions();}catch{this.pending=['unknown'];this.diagnostic='WSL 列表读取失败，未改变环境。';return this.snapshot();}
  this.candidates=this.candidates.filter(c=>c.id==='native');this.pending=[];
  for(const distribution of names){try{const c=await this.probeDistribution(distribution);this.candidates.push(this.wslCandidate(distribution,c));}catch(e){this.pending.push(distribution);this.diagnostic='部分发行版检测未完成，不能据此判断未安装。可以重试或在设置中配置。';}}
  return this.snapshot();
 });}
 async complete(input){return this.exclusive(async()=>{
  if(!this.required)return {...this.snapshot(),completed:true};
  if(this.busy())throw fail('请先完成当前任务；运行中的会话不会切换环境');
  if(input?.defer===true&&Object.keys(input).length===1){await this.store.save('deferred');this.required=false;return {...this.snapshot(),completed:true};}
  if(!input||Object.keys(input).some(k=>!['id','automatic'].includes(k))||typeof input.id!=='string')throw fail('无效的运行环境选择');
  const available=this.candidates.filter(c=>c.available===true),candidate=available.find(c=>c.id===input.id);
  if(!candidate)throw fail('环境尚未验证可用，请重新检测');
  if(input.automatic===true&&(available.length!==1||this.pending.length||this.nativeUnresolved))throw fail('检测未完成或存在多个环境，不能自动选择');
  // The selection callback revalidates the candidate, only persisting next launch.
  const result=await this.saveSelection(candidate.selection);
  await this.store.save('complete');this.required=false;
  return {...this.snapshot(),completed:true,selected:candidate.selection,restartRequired:result?.restartRequired===true};
 });}
}



