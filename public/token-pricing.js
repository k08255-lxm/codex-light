// Estimates only: community list prices are not a subscription invoice or actual charge.
const price=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n:null;
const tokens=n=>Number.isSafeInteger(n)&&n>=0?n:null;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const priceStructureKey=cost=>JSON.stringify(canonical(cost));
export function catalogPriceCandidates(catalog,model){
 return Object.entries(catalog||{}).filter(([,entry])=>Object.hasOwn(entry?.models||{},model)&&entry.models[model]?.cost).map(([provider,entry])=>({provider,model,cost:entry.models[model].cost}));
}
export function modelPriceFromCatalog(catalog,model,{provider='openai',fetchedAt=null,aliases=[]}={}){
 if(typeof model!=='string'||!model||model.length>200)throw new Error('模型标识无效');
 if(typeof provider!=='string'||!provider||provider.length>100)throw new Error('供应商标识无效');
 const alias=aliases.find(row=>row?.provider===provider&&row?.model===model);
 let catalogProvider=alias?.catalogProvider||provider;const catalogModel=alias?.catalogModel||model;
 let entry=Object.hasOwn(catalog||{},catalogProvider)&&Object.hasOwn(catalog[catalogProvider]?.models||{},catalogModel)?catalog[catalogProvider].models[catalogModel]:null;
 const candidates=catalogPriceCandidates(catalog,model);let modelReference=false;
 // Routing IDs do not identify billing providers. A model reference is safe only
 // when every full cost structure agrees, including cache fields and tiers.
 if(!entry&&!alias&&candidates.length&&candidates.every(row=>price(row.cost.input)!==null&&price(row.cost.output)!==null&&priceStructureKey(row.cost)===priceStructureKey(candidates[0].cost))){catalogProvider=candidates[0].provider;entry=catalog[catalogProvider].models[model];modelReference=true;}
 const cost=entry?.cost;
 const segmented=!!(cost?.context_over_200k||(Array.isArray(cost?.tiers)&&cost.tiers.length));
 const unsupportedReason=!cost?(candidates.length?'同名模型存在不同价格，请选择参考价格源或手填':'未找到精确模型价格，请手填参考单价'):segmented&&alias?.referenceTier!=='base'?'此模型有上下文分段价格，请明确选择基础参考档或手填':Object.keys(cost).some(key=>!['input','output','cache_read','cache_write','reasoning','tiers','context_over_200k'].includes(key))?'此模型包含额外计费维度，汇总 Token 无法确认，请手填参考单价':null;
 return Object.freeze({provider,model,catalogProvider:entry?catalogProvider:null,catalogModel,matchedBy:alias?'explicit-alias':modelReference?'consistent-model-reference':entry?'exact':'unmatched',referenceTier:alias?.referenceTier||null,segmented,input:price(cost?.input),output:price(cost?.output),cacheRead:price(cost?.cache_read),cacheWrite:price(cost?.cache_write),reasoning:price(cost?.reasoning),unsupportedReason,currency:'USD',unit:'per-million-tokens',source:'https://models.dev/api.json',fetchedAt,priceEffectiveAt:null,kind:'community-reference'});
}
export function estimateTokenCost(usage,pricing){
 if(!pricing?.provider||pricing.currency!=='USD'||pricing.unit!=='per-million-tokens')throw new Error('不支持的价格口径');
 if(usage?.model!==undefined&&usage.model!==pricing.model)throw new Error('模型与价格不匹配');
 if(usage?.provider!==undefined&&usage.provider!==pricing.provider)throw new Error('供应商与价格不匹配');
 const input=tokens(usage?.inputTokens),cached=tokens(usage?.cachedInputTokens),written=tokens(usage?.cacheWriteInputTokens),output=tokens(usage?.outputTokens);
 // input includes cached input. Never add cache/reasoning again to token totals.
 const validInput=input!==null&&cached!==null&&written!==null&&cached+written<=input;
 const validCached=input!==null&&cached!==null&&cached<=input&&(written===null||cached+written<=input);
 const separateReasoning=price(pricing.reasoning)!==null&&pricing.reasoning!==pricing.output;
 const reasoning=tokens(usage?.reasoningOutputTokens),validOutput=output!==null&&reasoning!==null&&reasoning<=output;
 const parts=[['input',validInput?input-cached-written:null,price(pricing.input)],['cacheRead',validCached?cached:null,price(pricing.cacheRead)],['cacheWrite',validInput?written:null,price(pricing.cacheWrite)],['output',separateReasoning?(validOutput?output-reasoning:null):output,price(pricing.output)]];
 if(separateReasoning)parts.push(['reasoning',validOutput?reasoning:null,price(pricing.reasoning)]);
 const components=parts.map(([kind,count,rate])=>({kind,tokens:count,usd:count===0?0:count!==null&&rate!==null?count*rate/1e6:null,pricePerMillion:rate}));
 const sum=components.reduce((n,x)=>n+(x.usd??0),0);
 const complete=!pricing.unsupportedReason&&components.every(x=>x.usd!==null&&Number.isFinite(x.usd))&&Number.isFinite(sum);
 // Expose a subtotal separately; never turn an unknown counter or price into 0.
 const knownUsd=!pricing.unsupportedReason&&Number.isFinite(sum)&&components.some(part=>part.tokens>0&&part.usd!==null)?sum:null;
 return {kind:'reference-estimate',currency:'USD',complete,usd:complete?sum:null,knownUsd,components,reason:pricing.unsupportedReason||(!validInput?'输入与缓存拆分不完整':!complete?'模型单价或 token 记录不完整':null),notice:'参考单价估算，不代表订阅账单或实际扣款；与官方后端估算分开显示，不相加。'};
}
