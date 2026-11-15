import {StorageMaintenance} from './storage-maintenance.mjs';
const unavailable=()=>Object.assign(new Error('Native safe cleanup is unavailable; files were not changed'),{code:'STORAGE_SAFE_DELETE_UNAVAILABLE',status:409,outcome:'notExecuted'});
export class NativeStorageMaintenance extends StorageMaintenance {
 constructor({native,reservation,...options}){super(options);this.native=native;this.reservation=reservation;this.nativePlans=new Map();this.installSourceAudit=relatives=>this.native?.available?this.native.execute('inspectInstallSources',{relatives}):Promise.reject(unavailable());}
 async scan(){const result=await super.scan();const install=result.categories.find(c=>c.category==='install');if(install)install.deleteFileCount=install.fileCount;return {...result,recoveries:[],mode:'delete',note:'清理会永久删除已确认文件，不创建归档。已有恢复资料保留。',cleanupAvailable:this.native?.available===true};}
 async guarded(fn){
  if(!this.native?.available)throw unavailable();
  return this.reservation.run('storage',async()=>{await this.assertReady();this.running=true;try{return await this.imageLease(async()=>{if(this.busy())throw Object.assign(new Error('Storage is busy'),{code:'STORAGE_BUSY',status:409,outcome:'notExecuted'});return fn();});}finally{this.running=false;}});
 }
 async plan({category,mode='delete'}={}){return this.guarded(async()=>{
  if(!['cache','images','install'].includes(category)||mode!=='delete')throw unavailable();
  const selected=await this.candidates(category);let bytes=0,characters=0;const files=[];
  const eligible=selected.files.filter(f=>!(mode==='delete'&&category==='install')||((/\.partial$/.test(f.file)&&this.now()-Number(f.fingerprint.split(':')[3])>=7*86400000)||/[\\/]SetupLogs[\\/].+[\\/](?:install\.log|[^\\/]+\.msi)$/.test(f.file)));
  for(const f of eligible){const length=JSON.stringify(this.inside(f.file)).length+1;if(files.length>=64||bytes+f.size>32*1048576||characters+length>240000)break;files.push(f);bytes+=f.size;characters+=length;}
  const p=await this.native.execute('snapshot',{category,mode,relatives:files.map(f=>this.inside(f.file))});
  if(this.nativePlans.size>=16)this.nativePlans.clear();const msiFiles=files.filter(f=>/\.msi$/i.test(f.file));this.nativePlans.set(p.id,{category,mode,files,msiFileCount:msiFiles.length});
  return {...p,msiFileCount:msiFiles.length,msiBytes:msiFiles.reduce((n,f)=>n+f.size,0),msiScope:'codecang-family-current-user-and-machine',impact:selected.impact,partial:files.length<eligible.length};
 });}
 async apply(input){return this.guarded(async()=>{
  const p=this.nativePlans.get(input?.id);if(!p||input.confirmed!==true||(p.msiFileCount>0&&input.msiConfirmed!==true))throw unavailable();this.nativePlans.delete(input.id);
  // Image references may have changed since confirmation; do not silently broaden the native plan.
  const current=new Set((await this.candidates(p.category)).files.map(f=>f.file));if(p.files.some(f=>!current.has(f.file)))throw unavailable();
  const{id,manifestDigest,confirmed}=input;return this.native.execute('apply',{id,manifestDigest,confirmed,...(p.msiFileCount>0?{confirmedMsiScope:input.msiConfirmed===true}:{})});
 });}
 async restore(input){return this.guarded(()=>this.native.execute('restore',input));}
}
