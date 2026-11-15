import test from 'node:test';import assert from 'node:assert/strict';
import {PricingService} from '../src/pricing.mjs';
const model='gpt-6.1-sol';
const catalog={openai:{models:{[model]:{cost:{input:2,output:10,cache_read:.1}}}},reseller:{models:{[model]:{cost:{input:30,output:40}}}}};
test('custom route automatically uses exact publisher reference, not reseller or alias guesses',async()=>{
 const p=new PricingService();p.acceptCatalog(catalog);
 assert.equal(p.get(model,'custom').input,2);assert.equal(p.get(model,'custom').provider,'custom');assert.equal(p.get(model,'custom').matchedBy,'publisher-model-reference');assert.equal(p.get(model,'custom').cacheWrite,null);
 assert.equal(p.get(model+'-unknown','custom').input,null);
 await p.configure({mode:'manual',provider:'custom',model,input:5,output:9});assert.equal(p.get(model,'custom').input,5);
 await p.configure({mode:'automatic',provider:'custom',model});assert.equal(p.get(model,'custom').input,2);
 await p.configure({mode:'catalog',provider:'custom',model,catalogProvider:'reseller',catalogModel:model,referenceTier:'standard'});assert.equal(p.get(model,'custom').input,30);
});
test('publisher tier is explicitly base reference, not actual billed charge',()=>{
 const p=new PricingService();p.acceptCatalog({openai:{models:{[model]:{cost:{input:2,output:10,tiers:[{input:4}]}}}}});
 const result=p.get(model,'custom');assert.equal(result.referenceTier,'base');assert.equal(result.segmented,true);assert.equal(result.unsupportedReason,null);assert.equal(result.kind,'community-reference');
});
test('automatic public sync caches six hours, backs off failures and retains custom prices',async()=>{
 let now=1000000,calls=0,fail=false;
 const p=new PricingService({clock:()=>now,fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://models.dev/api.json');assert.equal(options.credentials,'omit');assert.equal(options.body,undefined);if(fail)throw Error('offline');return new Response(JSON.stringify(catalog));}});
 await p.configure({mode:'manual',provider:'custom',model,input:7,output:8});
 await Promise.all([p.ensureFresh(),p.ensureFresh()]);assert.equal(calls,1);assert.equal(p.get(model,'custom').input,7);
 await p.ensureFresh();assert.equal(calls,1);now+=7*3600e3;fail=true;const before=p.fetchedAt;assert.match((await p.ensureFresh()).refreshWarning,/缓存/);assert.equal(p.fetchedAt,before);await p.ensureFresh();assert.equal(calls,2);
});
