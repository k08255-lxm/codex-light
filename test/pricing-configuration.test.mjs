import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PricingService} from '../src/pricing.mjs';
import {modelPriceFromCatalog,estimateTokenCost} from '../public/token-pricing.js';
const cost={input:10,output:50,cache_read:1,cache_write:12.5};
const segmented={...cost,tiers:[{input:20,output:75,tier:{type:'context',size:272000}}]};
const catalog={openai:{models:{m:{cost:segmented}}},cortecs:{models:{m:{cost:{...cost,input:12.272}}}}};
const usage={model:'m',provider:'custom',inputTokens:1000000,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:1000000,reasoningOutputTokens:0};
async function directory(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'light-pricing-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('full-structure agreement allows only exact model references and does not relabel routing',()=>{
 const c={a:{models:{m:{cost}}},b:{models:{m:{cost:{output:50,cache_write:12.5,input:10,cache_read:1}}}}};
 const reference=modelPriceFromCatalog(c,'m',{provider:'custom'});assert.equal(reference.matchedBy,'consistent-model-reference');assert.equal(reference.provider,'custom');assert.equal(reference.catalogProvider,'a');assert.equal(estimateTokenCost(usage,reference).usd,60);
 for(const changed of [{...cost,cache_write:undefined},{...cost,tiers:[{tier:{type:'context',size:272000},input:20}]},{...cost,input_audio:2}]){c.b.models.m.cost=changed;assert.equal(modelPriceFromCatalog(c,'m',{provider:'custom'}).matchedBy,'unmatched');}
 assert.equal(modelPriceFromCatalog(c,'M',{provider:'custom'}).input,null);assert.equal(modelPriceFromCatalog(c,'m-2026-11-13',{provider:'custom'}).input,null);
});

test('ambiguous provider and tier require explicit choice, manual missing prices remain unknown',async()=>{
 const service=new PricingService();service.acceptCatalog(catalog);
 assert.equal(service.get('m','custom').input,null);assert.match(service.get('m','custom').unsupportedReason,/不同价格/);assert.equal(service.candidates('m').length,2);
 await assert.rejects(service.configure({mode:'catalog',provider:'custom',model:'m',catalogProvider:'openai',catalogModel:'m',referenceTier:'standard'}),/档位/);
 await service.configure({mode:'catalog',provider:'custom',model:'m',catalogProvider:'openai',catalogModel:'m',referenceTier:'base'});
 const reference=service.get('m','custom');assert.equal(reference.provider,'custom');assert.equal(reference.referenceTier,'base');assert.equal(reference.matchedBy,'explicit-alias');assert.equal(estimateTokenCost(usage,reference).usd,60);
 await service.configure({mode:'manual',provider:'custom',model:'m',input:3,output:7});assert.equal(service.get('m','custom').cacheRead,null);assert.equal(estimateTokenCost({...usage,cachedInputTokens:2},service.get('m','custom')).usd,null);
 await service.configure({mode:'automatic',provider:'custom',model:'m'});assert.equal(service.get('m','custom').input,null);
 for(const entry of [{mode:'manual',provider:'custom',model:'m',input:null,output:2},{mode:'manual',provider:'custom',model:'m',input:-1,output:2},{mode:'manual',provider:'custom',model:'m',input:1,output:2,secret:'never'}])await assert.rejects(service.configure(entry));
});

test('public catalog, selected source and manual prices survive restart with no startup network',async t=>{
 const root=await directory(t),service=new PricingService({root,clock:()=>0,fetchImpl:async()=>new Response(JSON.stringify(catalog))});await service.refresh();
 await service.configure({mode:'catalog',provider:'custom',model:'m',catalogProvider:'openai',catalogModel:'m',referenceTier:'base'});await service.configure({mode:'manual',provider:'custom',model:'manual',input:1,output:2,cacheRead:null});await service.close();
 let fetched=0;const restored=new PricingService({root,fetchImpl:()=>{fetched++;throw new Error('No network');}});await restored.load();assert.equal(fetched,0);assert.equal(restored.get('m','custom').referenceTier,'base');assert.equal(restored.get('manual','custom').input,1);assert.equal(restored.get('manual','custom').cacheRead,null);assert.equal(restored.fetchedAt,'1970-01-01T00:00:00.000Z');assert.deepEqual(restored.catalog.openai.models.m.cost.tiers,segmented.tiers);
});

test('corrupt or unsafe cache is preserved and refresh failure keeps prior data',async t=>{
 const root=await directory(t),file=path.join(root,'pricing.json');await fs.writeFile(file,'BROKEN');const service=new PricingService({root});await service.load();assert.ok(service.status().persistenceWarning);await service.configure({mode:'manual',provider:'custom',model:'m',input:1,output:2});await service.close();assert.equal(await fs.readFile(file,'utf8'),'BROKEN');
});

test('missing write usage stays unknown while independently known components have an explicit subtotal',()=>{
 for(const reference of [cost,{input:10,output:50,cache_read:1}]){
  const pricing=modelPriceFromCatalog({p:{models:{m:{cost:reference}}}},'m',{provider:'custom'});
  const estimate=estimateTokenCost({...usage,inputTokens:1000,cachedInputTokens:100,cacheWriteInputTokens:null,outputTokens:100},pricing);
  assert.equal(estimate.complete,false);assert.equal(estimate.usd,null);assert.equal(estimate.knownUsd,.0051);assert.equal(estimate.components.find(part=>part.kind==='input').usd,null);assert.equal(estimate.components.find(part=>part.kind==='cacheWrite').tokens,null);
 }
 const unresolved=modelPriceFromCatalog(catalog,'m',{provider:'custom'});assert.equal(estimateTokenCost(usage,unresolved).knownUsd,null,'partial cost must not bypass ambiguous price selection');
});
