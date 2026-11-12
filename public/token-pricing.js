// Estimates only: community list prices are not a subscription invoice or actual charge.
const price=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n:null;
const tokens=n=>Number.isSafeInteger(n)&&n>=0?n:null;
export function modelPriceFromCatalog(catalog,model,{fetchedAt=null}={}){
 if(typeof model!=='string'||!model||model.length>200)throw new Error('模型标识无效');
 const entry=catalog?.openai?.models?.[model];
 const cost=entry?.cost;
 return Object.freeze({provider:'openai',model,input:price(cost?.input),output:price(cost?.output),cacheRead:price(cost?.cache_read),cacheWrite:price(cost?.cache_write),currency:'USD',unit:'per-million-tokens',source:'https://models.dev/api.json',fetchedAt,priceEffectiveAt:null,kind:'community-reference'});
}
export function estimateTokenCost(usage,pricing){
 if(pricing?.provider!=='openai'||pricing.currency!=='USD'||pricing.unit!=='per-million-tokens')throw new Error('不支持的价格口径');
 if(usage?.model!==undefined&&usage.model!==pricing.model)throw new Error('模型与价格不匹配');
 const input=tokens(usage?.inputTokens),cached=tokens(usage?.cachedInputTokens),written=tokens(usage?.cacheWriteInputTokens),output=tokens(usage?.outputTokens);
 // input includes cached input. Never add cache/reasoning again to token totals.
 const validInput=input!==null&&cached!==null&&written!==null&&cached+written<=input;
 const parts=[['input',validInput?input-cached-written:null,price(pricing.input)],['cacheRead',cached,price(pricing.cacheRead)],['cacheWrite',written,price(pricing.cacheWrite)],['output',output,price(pricing.output)]];
 const components=parts.map(([kind,count,rate])=>({kind,tokens:count,usd:count===0?0:count!==null&&rate!==null?count*rate/1e6:null,pricePerMillion:rate}));
 const sum=components.reduce((n,x)=>n+(x.usd??0),0);
 const complete=components.every(x=>x.usd!==null&&Number.isFinite(x.usd))&&Number.isFinite(sum);
 return {kind:'reference-estimate',currency:'USD',complete,usd:complete?sum:null,components,notice:'参考单价估算，不代表订阅账单或实际扣款；与官方后端估算分开显示，不相加。'};
}
