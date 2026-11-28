import {lstat,mkdir,open,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {DEFAULT_PREFERENCES,validatePreferences} from '../public/preferences.js';
const MAX=256*1024;
const error=()=>new Error('本机状态无法安全读取或保存；未使用替代存储。');
async function noLinks(file){for(let p=path.resolve(file);;p=path.dirname(p)){try{if((await lstat(p)).isSymbolicLink())throw error();}catch(e){if(e.code!=='ENOENT')throw e;}if(path.dirname(p)===p)break;}}
function validate(value) {
 const fields=Object.keys(value||{}).sort().join(',');
 const legacy=value?.version===1 && fields==='preferences,receipts,version' && Array.isArray(value.receipts);
 if(!legacy && !(value?.version===2 && fields==='preferences,version'))throw error();
 return {version:2,preferences:validatePreferences(value.preferences)};
}
export class DesktopState{
 constructor({root=process.platform==='win32'&&process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'CodexLight','state'):null}={}){if(!root||!path.isAbsolute(root))throw error();this.root=root;this.file=path.join(root,'state.json');this.queue=Promise.resolve();this.persistenceWarning=null;}
 async read({allowMissing=false}={}){await noLinks(this.file);let h;try{h=await open(this.file,'r');const s=await h.stat();if(!s.isFile()||s.size>MAX)throw error();const buf=Buffer.alloc(MAX+1);let count=0;while(count<=MAX){const r=await h.read(buf,count,MAX+1-count,null);if(!r.bytesRead)break;count+=r.bytesRead;}if(count>MAX)throw error();return validate(JSON.parse(buf.subarray(0,count).toString('utf8')));}catch(e){if(e.code==='ENOENT')return allowMissing?null:{version:2,preferences:{...DEFAULT_PREFERENCES}};throw error();}finally{await h?.close();}}
 update(fn){const job=this.queue.then(async()=>{const value=await this.read();await fn(value);const bytes=Buffer.from(JSON.stringify(validate(value)));if(bytes.length>MAX)throw error();await noLinks(this.root);await mkdir(this.root,{recursive:true,mode:0o700});await noLinks(this.file);const temp=path.join(this.root,'.state-'+randomBytes(16).toString('hex'));let h;try{h=await open(temp,'wx',0o600);await h.writeFile(bytes);await h.sync();await h.close();h=null;await noLinks(this.file);await rename(temp,this.file);}finally{await h?.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}return value;});this.queue=job.catch(()=>{});return job;}
 async preferenceSnapshot(){
  const saved=await this.read({allowMissing:true});
  return {preferences:saved?.preferences??{...DEFAULT_PREFERENCES},firstRun:saved===null};
 }
 async preferences(value){
  if(value===undefined)return (await this.read()).preferences;
  return (await this.update(s=>{
   const next=validatePreferences(value);
   for(const key of ['keepAwakeDuringTask','keepAwakeDuringRemote','desktopCompanion']){
    if(!Object.hasOwn(value,key))next[key]=s.preferences[key];
   }
   s.preferences=next;
  })).preferences;
 }
}
