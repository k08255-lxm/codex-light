import test from 'node:test';import assert from 'node:assert/strict';
import {modelPriceFromCatalog,estimateTokenCost} from '../public/token-pricing.js';
const catalog={openai:{models:{example:{cost:{input:2,output:8,cache_read:0.2}}}},other:{models:{example:{cost:{input:0}}}}};
test('Pricing keeps exact OpenAI model identity and unknown fields',()=>{
 const p=modelPriceFromCatalog(catalog,'example',{fetchedAt:'2026-11-11T00:00:00Z'});assert.equal(p.input,2);assert.equal(p.cacheWrite,null);assert.equal(p.priceEffectiveAt,null);
 assert.equal(modelPriceFromCatalog(catalog,'Example').input,null);assert.equal(modelPriceFromCatalog(catalog,'unknown').input,null);
});
test('Reference price subtracts cached input once and no reasoning double-count',()=>{
 const p=modelPriceFromCatalog(catalog,'example');const result=estimateTokenCost({inputTokens:1000000,cachedInputTokens:200000,cacheWriteInputTokens:0,outputTokens:100000,reasoningOutputTokens:50000},p);
 assert.equal(result.complete,true);assert.ok(Math.abs(result.usd-2.44)<1e-12);
});
test('Unknown/non-finite/missing/inconsistent counts never zero-cost success',()=>{
 const p=modelPriceFromCatalog(catalog,'example');
 for(const u of [{inputTokens:1,outputTokens:1},{inputTokens:1,cachedInputTokens:2,cacheWriteInputTokens:0,outputTokens:1},{inputTokens:1,cachedInputTokens:0,cacheWriteInputTokens:1,outputTokens:1}])assert.equal(estimateTokenCost(u,p).usd,null);
 assert.equal(estimateTokenCost({inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0},p).usd,0);
});
