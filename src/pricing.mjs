import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {modelPriceFromCatalog,catalogPriceCandidates} from '../public/token-pricing.js';
const URL='https://models.dev/api.json';
const MAX_BYTES=32*1024*1024;
const validProvider=value=>typeof value==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(value);
const validModel=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\x00-\x1f\x7f]/.test(value);
const identity=entry=>JSON.stringify([entry.provider,entry.model]);
async function noLinks(target){for(let p=path.resolve(target);;p=path.dirname(p)){try{if((await fs.lstat(p)).isSymbolicLink())throw new Error('价格缓存路径是链接');}catch(error){if(error.code!=='ENOENT')throw error;}if(path.dirname(p)===p)return;}}
// Explicit refresh only; no startup network request and no private data sent.
export class PricingService {
 constructor({fetchImpl=globalThis.fetch,clock=()=>Date.now(),root=null,manualPrices=[],aliases=[]}={}){if(root!==null&&(typeof root!=='string'||!path.isAbsolute(root)))throw new Error('价格缓存目录须为绝对路径');this.root=root;this.queue=Promise.resolve();this.persistenceWarning=null;this.fetch=fetchImpl;this.clock=clock;this.catalog=null;this.fetchedAt=null;this.pending=null;this.manual=new Map();this.aliases=aliases;this.modelCount=0;for(const entry of manualPrices)this.setManual(entry);}
 setManual(entry){
  if(!entry||!validProvider(entry.provider)||!validModel(entry.model)||Object.keys(entry).some(key=>!['provider','model','input','output','cacheRead','cacheWrite','reasoning'].includes(key)))throw new Error('手工价格参数无效');
  for(const key of ['input','output','cacheRead','cacheWrite','reasoning'])if(entry[key]!==null&&entry[key]!==undefined&&(typeof entry[key]!=='number'||!Number.isFinite(entry[key])||entry[key]<0))throw new Error('手工单价须为非负数或未知');
  if(typeof entry.input!=='number'||typeof entry.output!=='number')throw new Error('请填写输入和输出单价');
  this.manual.set(identity(entry),Object.freeze({...Object.fromEntries(['input','output','cacheRead','cacheWrite','reasoning'].map(key=>[key,entry[key]??null])),provider:entry.provider,model:entry.model,currency:'USD',unit:'per-million-tokens',source:'manual',kind:'manual-reference',matchedBy:'manual',unsupportedReason:null}));
 }
 async configure(entry){
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||!validProvider(entry.provider)||!validModel(entry.model))throw new Error('价格参数无效');
  if(entry.mode==='manual'){if(this.manual.size>=1000&&!this.manual.has(identity(entry)))throw new Error('手工价格数量已达上限');const {mode,...manual}=entry;this.setManual(manual);}
  else if(entry.mode==='catalog'){
   if(Object.keys(entry).some(key=>!['mode','provider','model','catalogProvider','catalogModel','referenceTier'].includes(key))||!validProvider(entry.catalogProvider)||!validModel(entry.catalogModel)||!['standard','base'].includes(entry.referenceTier))throw new Error('参考价格源参数无效');
   const selected=modelPriceFromCatalog(this.catalog,entry.catalogModel,{provider:entry.catalogProvider});
   if(selected.matchedBy!=='exact'||selected.segmented&&entry.referenceTier!=='base'||!selected.segmented&&entry.referenceTier!=='standard')throw new Error('请选择有效价格源及其参考档位');
   if(this.aliases.length>=1000&&!this.aliases.some(row=>identity(row)===identity(entry)))throw new Error('参考价格映射数量已达上限');
   const alias={provider:entry.provider,model:entry.model,catalogProvider:entry.catalogProvider,catalogModel:entry.catalogModel,referenceTier:entry.referenceTier};
   this.aliases=this.aliases.filter(row=>identity(row)!==identity(entry));this.aliases.push(alias);this.manual.delete(identity(entry));
  }else if(entry.mode==='automatic'){
   if(Object.keys(entry).some(key=>!['mode','provider','model'].includes(key)))throw new Error('价格参数无效');this.manual.delete(identity(entry));this.aliases=this.aliases.filter(row=>identity(row)!==identity(entry));
  }else throw new Error('未知价格模式');
  await this.save();return {...this.get(entry.model,entry.provider),persistenceWarning:this.persistenceWarning};
 }
 async load(){
  if(!this.root)return;let handle;
  try{
   const file=path.join(this.root,'pricing.json');await noLinks(file);handle=await fs.open(file,'r');const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_BYTES)throw new Error('价格缓存过大');
   const bytes=Buffer.alloc(MAX_BYTES+1);let count=0;while(count<bytes.length){const read=await handle.read(bytes,count,bytes.length-count,null);if(!read.bytesRead)break;count+=read.bytesRead;}if(count>MAX_BYTES)throw new Error('价格缓存过大');
   const data=JSON.parse(bytes.subarray(0,count).toString('utf8'));if(data.version!==1||!Array.isArray(data.manual)||!Array.isArray(data.aliases)||data.manual.length>1000||data.aliases.length>1000)throw new Error('价格缓存无效');
   const restored=new PricingService();if(data.catalog){restored.acceptCatalog(data.catalog);if(typeof data.fetchedAt!=='string'||!Number.isFinite(Date.parse(data.fetchedAt)))throw new Error('价格缓存时间无效');restored.fetchedAt=data.fetchedAt;}
   for(const entry of data.manual)restored.setManual(entry);
   for(const entry of data.aliases){if(!validProvider(entry.provider)||!validModel(entry.model)||!validProvider(entry.catalogProvider)||!validModel(entry.catalogModel)||!['base','standard'].includes(entry.referenceTier))throw new Error('价格映射无效');restored.aliases.push({provider:entry.provider,model:entry.model,catalogProvider:entry.catalogProvider,catalogModel:entry.catalogModel,referenceTier:entry.referenceTier});}
   Object.assign(this,{catalog:restored.catalog,modelCount:restored.modelCount,fetchedAt:restored.fetchedAt,manual:restored.manual,aliases:restored.aliases});
  }catch(error){if(error.code!=='ENOENT'){this.persistenceWarning='价格缓存无法安全读取，原文件已保留；请重新导入。';this.writeBlocked=true;}}
  finally{await handle?.close();}
 }
 save(){
  if(!this.root||this.writeBlocked)return this.queue;
  const manual=[...this.manual.values()].map(entry=>Object.fromEntries(['provider','model','input','output','cacheRead','cacheWrite','reasoning'].map(key=>[key,entry[key]])));
  const data=JSON.stringify({version:1,catalog:this.catalog,fetchedAt:this.fetchedAt,manual,aliases:this.aliases});if(Buffer.byteLength(data)>MAX_BYTES){this.persistenceWarning='价格缓存超过大小上限，当前价格仅保留在内存中。';return this.queue;}
  this.queue=this.queue.then(async()=>{let temporary;try{
   await noLinks(this.root);await fs.mkdir(this.root,{recursive:true,mode:0o700});await noLinks(path.join(this.root,'pricing.json'));
   temporary=path.join(this.root,'.pricing-'+randomBytes(12).toString('hex')+'.tmp');const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}await fs.rename(temporary,path.join(this.root,'pricing.json'));temporary=null;this.persistenceWarning=null;
  }catch{this.persistenceWarning='价格缓存保存失败，当前价格仅保留在内存中。';}finally{if(temporary)await fs.unlink(temporary).catch(()=>{});}});return this.queue;
 }
 async refresh(){if(this.pending)return this.pending;this.pending=this.fetchCatalog();try{return await this.pending;}finally{this.pending=null;}}
 async fetchCatalog(){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
  try{
   const response=await this.fetch(URL,{signal:controller.signal,redirect:'error',credentials:'omit',headers:{Accept:'application/json'}});
   if(!response.ok)throw new Error(`价格来源返回 HTTP ${response.status}`);
   if(!response.body)throw new Error('价格来源没有响应正文');
   const reader=response.body.getReader();const chunks=[];let count=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>32*1024*1024){await reader.cancel();throw new Error('价格目录超过 32 MiB 上限');}chunks.push(value);}}finally{reader.releaseLock();}
   const bytes=Buffer.concat(chunks.map(x=>Buffer.from(x)));const json=JSON.parse(bytes.toString('utf8'));
   this.acceptCatalog(json);this.fetchedAt=new Date(this.clock()).toISOString();await this.save();return this.status();
  }finally{clearTimeout(timer);}
 }
 acceptCatalog(json){
   if(!json||typeof json!=='object'||Array.isArray(json))throw new Error('来源没有有效价格目录');
   const catalog=Object.create(null);let modelCount=0;
   for(const [provider,entry]of Object.entries(json)){
    if(!/^[a-zA-Z0-9_.-]{1,100}$/.test(provider)||!entry?.models||typeof entry.models!=='object'||Array.isArray(entry.models))continue;
    const models=Object.create(null);
    for(const [model,value]of Object.entries(entry.models)){
     if(!model||model.length>200||!value?.cost||typeof value.cost!=='object'||Array.isArray(value.cost))continue;
     const cost=structuredClone(value.cost);
     if(!Object.values(cost).some(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0))continue;
     models[model]={cost};if(++modelCount>100000)throw new Error('价格目录超过 100000 个模型上限');
    }
    catalog[provider]={models};
   }
   if(!modelCount)throw new Error('来源没有可识别模型价格');
   this.catalog=catalog;this.modelCount=modelCount;
 }
 status(){return {source:URL,fetchedAt:this.fetchedAt,available:this.catalog!==null||this.manual.size>0,modelCount:this.modelCount,manualCount:this.manual.size,providerCount:Object.keys(this.catalog||{}).length,matching:'manual; explicit-source; exact-provider-and-model; consistent-model-reference',priceEffectiveAt:null,persistenceWarning:this.persistenceWarning,notice:'社区参考估算，非账单；路由与账户独立。歧义价格和分段基础档须明确选择。'};}
 get(model,provider='openai'){return this.manual.get(JSON.stringify([provider,model]))||modelPriceFromCatalog(this.catalog,model,{provider,aliases:this.aliases,fetchedAt:this.fetchedAt});}
 candidates(model){if(!validModel(model))throw new Error('模型标识无效');return catalogPriceCandidates(this.catalog,model).map(row=>modelPriceFromCatalog(this.catalog,row.model,{provider:row.provider,fetchedAt:this.fetchedAt}));}
 async close(){await this.queue;}
}
