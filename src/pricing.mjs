import {modelPriceFromCatalog} from '../public/token-pricing.js';
const URL='https://models.dev/api.json';
// Explicit refresh only; no startup network request and no private data sent.
export class PricingService {
 constructor({fetchImpl=globalThis.fetch,clock=()=>Date.now()}={}){this.fetch=fetchImpl;this.clock=clock;this.catalog=null;this.fetchedAt=null;this.pending=null;}
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
   if(!json?.openai?.models||typeof json.openai.models!=='object'||Array.isArray(json.openai.models))throw new Error('来源没有有效 OpenAI 价格目录');
   this.catalog={openai:{models:json.openai.models}};this.fetchedAt=new Date(this.clock()).toISOString();
   return this.status();
  }finally{clearTimeout(timer);}
 }
 status(){return {source:URL,fetchedAt:this.fetchedAt,available:this.catalog!==null,priceEffectiveAt:null,notice:'社区参考价格，并非最终账单；同步时间不代表价格生效时间。'};}
 get(model){return modelPriceFromCatalog(this.catalog,model,{fetchedAt:this.fetchedAt});}
}
