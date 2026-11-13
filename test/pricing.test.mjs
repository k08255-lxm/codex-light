import test from 'node:test';import assert from 'node:assert/strict';import {PricingService} from '../src/pricing.mjs';
test('Pricing never fetches on construction/get, refresh does not send user data',async()=>{
 let n=0;const service=new PricingService({clock:()=>0,fetchImpl:async(url,opts)=>{n++;assert.equal(url,'https://models.dev/api.json');assert.equal(opts.redirect,'error');assert.equal(opts.credentials,'omit');return new Response(JSON.stringify({openai:{models:{model:{cost:{input:1}}}}}));}});
 assert.equal(service.get('model').input,null);assert.equal(n,0);await service.refresh();assert.equal(service.get('model').input,1);assert.equal(service.status().fetchedAt,'1970-01-01T00:00:00.000Z');assert.equal(n,1);
});
test('Refresh errors preserve prior price snapshot without faking newer timestamp',async()=>{
 let fail=false;const service=new PricingService({fetchImpl:async()=>fail?new Response('',{status:503}):new Response('{"openai":{"models":{"m":{"cost":{"input":1,"output":2}}}}}')});
 await service.refresh();const before=service.status().fetchedAt;fail=true;await assert.rejects(service.refresh(),/503/);assert.equal(service.status().fetchedAt,before);assert.equal(service.get('m','openai').input,1);
});
