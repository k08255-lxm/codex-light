import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from './mini-dom.mjs';
import {mountStatistics} from '../public/ui/stats-view.js';
import {PricingService} from '../src/pricing.mjs';
import {StatisticsService} from '../src/statistics.mjs';
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
test('unpriced row leads to source/base selection, manual reference, and reset without changing routing',async()=>{
 const pricing=new PricingService();pricing.acceptCatalog({openai:{models:{m:{cost:{input:10,output:50,tiers:[{input:20,tier:{type:'context',size:272000}}]}}}},other:{models:{m:{cost:{input:12,output:60}}}}});
 const statistics=new StatisticsService({pricing});statistics.importLocal({sessions:[{threadId:'thread',attribution:'observed-differences-only',turns:[{turnId:'t',model:'m',provider:'custom',startedAt:new Date().toISOString()}],increments:[{turnId:'t',tokens:{inputTokens:1000,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:100,reasoningOutputTokens:0,totalTokens:1100}}]}]});
 const calls=[],document=createDocument(),host=document.createElement('div');document.body.append(host);
 const api=async(route,input)=>{calls.push({route,input});if(route==='/api/statistics/query')return statistics.query({...input,scope:'local'});if(route==='/api/pricing/model')return {...pricing.get(input.model,input.provider),candidates:pricing.candidates(input.model)};if(route==='/api/pricing/configure')return pricing.configure(input);throw new Error('Unexpected route '+route);};
 const view=mountStatistics(host,{api});view.activate();await settle();host.querySelectorAll('button').find(node=>node.textContent==='设置参考价').click();await settle();
 const source=host.querySelector('[aria-label="参考价格源"]'),mode=host.querySelector('[aria-label="价格模式"]'),form=host.querySelector('.pricing-form');assert.ok(source.textContent.includes('基础参考档'));
 source.value='0';form.dispatch('submit');await settle();assert.equal(pricing.get('m','custom').referenceTier,'base');assert.equal(pricing.get('m','custom').catalogProvider,'openai');assert.ok(host.textContent.includes('基础参考档'));
 mode.value='manual';mode.dispatch('change');host.querySelector('[aria-label="输入单价"]').value='2';host.querySelector('[aria-label="输出单价"]').value='8';form.dispatch('submit');await settle();assert.equal(pricing.get('m','custom').source,'manual');assert.equal(pricing.get('m','custom').cacheRead,null);
 mode.value='automatic';form.dispatch('submit');await settle();assert.equal(pricing.get('m','custom').matchedBy,'unmatched');assert.equal(statistics.query({scope:'local'}).providers[0].provider,'custom');assert.ok(calls.some(row=>row.route==='/api/pricing/model'&&row.input.provider==='custom'));
 view.deactivate();
});
