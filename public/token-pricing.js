// Estimates only: community list prices are not a subscription invoice or actual charge.
const price=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n:null;
const tokens=n=>Number.isSafeInteger(n)&&n>=0?n:null;
export function modelPriceFromCatalog(catalog,model,{provider='openai',fetchedAt=null,aliases=[]}={}){
 if(typeof model!=='string'||!model||model.length>200)throw new Error('模型标识无效');
 if(typeof provider!=='string'||!provider||provider.length>100)throw new Error('供应商标识无效');
 const alias=aliases.find(row=>row?.provider===provider&&row?.model===model);
 const catalogProvider=alias?.catalogProvider||provider,catalogModel=alias?.catalogModel||model;
 const entry=Object.hasOwn(catalog||{},catalogProvider)&&Object.hasOwn(catalog[catalogProvider]?.models||{},catalogModel)?catalog[catalogProvider].models[catalogModel]:null;
 const cost=entry?.cost;
 const unsupportedReason=!cost?'未找到精确供应商与模型价格':cost.context_over_200k||(Array.isArray(cost.tiers)&&cost.tiers.length)?'此模型有上下文分段价格，现有回合汇总无法确认适用档位':null;
 return Object.freeze({provider,model,catalogProvider,catalogModel,matchedBy:alias?'explicit-alias':entry?'exact':'unmatched',input:price(cost?.input),output:price(cost?.output),cacheRead:price(cost?.cache_read),cacheWrite:price(cost?.cache_write),reasoning:price(cost?.reasoning),unsupportedReason,currency:'USD',unit:'per-million-tokens',source:'https://models.dev/api.json',fetchedAt,priceEffectiveAt:null,kind:'community-reference'});
}
export function estimateTokenCost(usage,pricing){
 if(!pricing?.provider||pricing.currency!=='USD'||pricing.unit!=='per-million-tokens')throw new Error('不支持的价格口径');
 if(usage?.model!==undefined&&usage.model!==pricing.model)throw new Error('模型与价格不匹配');
 if(usage?.provider!==undefined&&usage.provider!==pricing.provider)throw new Error('供应商与价格不匹配');
 const input=tokens(usage?.inputTokens),cached=tokens(usage?.cachedInputTokens),written=tokens(usage?.cacheWriteInputTokens),output=tokens(usage?.outputTokens);
 // input includes cached input. Never add cache/reasoning again to token totals.
 const validInput=input!==null&&cached!==null&&written!==null&&cached+written<=input;
 const separateReasoning=price(pricing.reasoning)!==null&&pricing.reasoning!==pricing.output;
 const reasoning=tokens(usage?.reasoningOutputTokens),validOutput=output!==null&&reasoning!==null&&reasoning<=output;
 const parts=[['input',validInput?input-cached-written:null,price(pricing.input)],['cacheRead',validInput?cached:null,price(pricing.cacheRead)],['cacheWrite',validInput?written:null,price(pricing.cacheWrite)],['output',separateReasoning?(validOutput?output-reasoning:null):output,price(pricing.output)]];
 if(separateReasoning)parts.push(['reasoning',validOutput?reasoning:null,price(pricing.reasoning)]);
 const components=parts.map(([kind,count,rate])=>({kind,tokens:count,usd:count===0?0:count!==null&&rate!==null?count*rate/1e6:null,pricePerMillion:rate}));
 const sum=components.reduce((n,x)=>n+(x.usd??0),0);
 const complete=!pricing.unsupportedReason&&components.every(x=>x.usd!==null&&Number.isFinite(x.usd))&&Number.isFinite(sum);
 return {kind:'reference-estimate',currency:'USD',complete,usd:complete?sum:null,components,reason:pricing.unsupportedReason||(!validInput?'输入与缓存拆分不完整':!complete?'模型单价或 token 记录不完整':null),notice:'参考单价估算，不代表订阅账单或实际扣款；与官方后端估算分开显示，不相加。'};
}
