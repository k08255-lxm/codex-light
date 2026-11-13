import {modelPriceFromCatalog} from '../public/token-pricing.js';
const URL='https://models.dev/api.json';
// Explicit refresh only; no startup network request and no private data sent.
export class PricingService {
 constructor({fetchImpl=globalThis.fetch,clock=()=>Date.now(),manualPrices=[],aliases=[]}={}){this.fetch=fetchImpl;this.clock=clock;this.catalog=null;this.fetchedAt=null;this.pending=null;this.manual=new Map();this.aliases=aliases;this.modelCount=0;for(const entry of manualPrices)this.setManual(entry);}
 setManual(entry){
  if(!entry||typeof entry.provider!=='string'||!/^[a-zA-Z0-9_.-]{1,100}$/.test(entry.provider)||typeof entry.model!=='string'||!entry.model||entry.model.length>200)throw new Error('手工价格模型或供应商无效');
  for(const key of ['input','output','cacheRead','cacheWrite','reasoning'])if(entry[key]!==null&&entry[key]!==undefined&&(typeof entry[key]!=='number'||!Number.isFinite(entry[key])||entry[key]<0))throw new Error('手工单价须为非负数或未知');
  this.manual.set(JSON.stringify([entry.provider,entry.model]),Object.freeze({...entry,currency:'USD',unit:'per-million-tokens',source:'manual',kind:'manual-reference',matchedBy:'manual',unsupportedReason:null}));
 }
 async refresh(){if(this.pending)return this.pending;this.pending=this.load();try{return await this.pending;}finally{this.pending=null;}}
 async load(){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
  try{
   const response=await this.fetch(URL,{signal:controller.signal,redirect:'error',credentials:'omit',headers:{Accept:'application/json'}});
   if(!response.ok)throw new Error(`价格来源返回 HTTP ${response.status}`);
   if(!response.body)throw new Error('价格来源没有响应正文');
   const reader=response.body.getReader();const chunks=[];let count=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>32*1024*1024){await reader.cancel();throw new Error('价格目录超过 32 MiB 上限');}chunks.push(value);}}finally{reader.releaseLock();}
   const bytes=Buffer.concat(chunks.map(x=>Buffer.from(x)));const json=JSON.parse(bytes.toString('utf8'));
   if(!json||typeof json!=='object'||Array.isArray(json))throw new Error('来源没有有效价格目录');
   const catalog=Object.create(null);let modelCount=0;
   for(const [provider,entry]of Object.entries(json)){
    if(!/^[a-zA-Z0-9_.-]{1,100}$/.test(provider)||!entry?.models||typeof entry.models!=='object'||Array.isArray(entry.models))continue;
    const models=Object.create(null);
    for(const [model,value]of Object.entries(entry.models)){
     if(!model||model.length>200||!value?.cost||typeof value.cost!=='object'||Array.isArray(value.cost))continue;
     const cost=Object.fromEntries(Object.entries(value.cost).filter(([key])=>['input','output','cache_read','cache_write','reasoning','context_over_200k','tiers'].includes(key)));
     if(!Object.values(cost).some(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0))continue;
     models[model]={cost};if(++modelCount>100000)throw new Error('价格目录超过 100000 个模型上限');
    }
    catalog[provider]={models};
   }
   if(!modelCount)throw new Error('来源没有可识别模型价格');
   this.catalog=catalog;this.modelCount=modelCount;this.fetchedAt=new Date(this.clock()).toISOString();
   return this.status();
  }finally{clearTimeout(timer);}
 }
 status(){return {source:URL,fetchedAt:this.fetchedAt,available:this.catalog!==null||this.manual.size>0,modelCount:this.modelCount,manualCount:this.manual.size,providerCount:Object.keys(this.catalog||{}).length,matching:'exact-provider-and-model; explicit-alias-only; manual-first',priceEffectiveAt:null,notice:'社区参考价格，并非最终账单；仅精确匹配供应商和模型，不去除前缀或日期。手工价格优先；同步时间不代表价格生效时间。'};}
 get(model,provider='openai'){return this.manual.get(JSON.stringify([provider,model]))||modelPriceFromCatalog(this.catalog,model,{provider,aliases:this.aliases,fetchedAt:this.fetchedAt});}
}
