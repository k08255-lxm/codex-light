import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {StatisticsService,publicAccountIdentity} from '../src/statistics.mjs';
import {PricingService} from '../src/pricing.mjs';
const account=email=>({account:{type:'chatgpt',email,planType:'pro',accessToken:'PRIVATE_TOKEN',id:'PRIVATE_ID'}});
const start=(service,id)=>service.observe({method:'turn/started',params:{threadId:'thread',turn:{id}}});
test('public identity keeps only public fields and never invents an API-key account',()=>{
 const identity=publicAccountIdentity(account('one@example.test'));assert.equal(identity.email,'one@example.test');assert.equal(identity.id.length,64);assert.ok(!JSON.stringify(identity).includes('PRIVATE'));
 assert.equal(publicAccountIdentity({account:null}),null);assert.equal(publicAccountIdentity({type:'apiKey',apiKey:'PRIVATE_KEY'}).id,null);assert.equal(publicAccountIdentity({type:'apiKey',email:'PRIVATE_KEY'}).email,null);
});
test('account snapshots belong only to new observed turns, retain routing filters and survive reload',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'light-account-stats-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const pricing=new PricingService(),service=new StatisticsService({pricing,root});
 start(service,'historical');service.acknowledge('account/read',{},account('one@example.test'));start(service,'one');service.setAccount(account('two@example.test'));start(service,'two');start(service,'one');
 service.thread({id:'thread',model:'m',modelProvider:'custom'});service.acknowledge('turn/start',{threadId:'thread'},{turn:{id:'two'}});
 const data=service.query();assert.equal(data.currentAccount.email,'two@example.test');assert.equal(data.details.data.find(row=>row.turnId==='historical').account,null);assert.equal(data.details.data.find(row=>row.turnId==='one').account.email,'one@example.test');assert.equal(data.details.data.find(row=>row.turnId==='two').provider,'custom');assert.equal(service.query({account:data.currentAccount.id}).totals.turnCount,1);assert.equal(service.query({account:'unknown'}).totals.turnCount,1);
 service.importLocal({sessions:[{threadId:'old',attribution:'observed-differences-only',turns:[{turnId:'imported',model:'m',provider:'custom'}]}]});assert.equal(service.query({scope:'local'}).details.data[0].account,null);
 await service.close();const saved=await fs.readFile(path.join(root,'live.json'),'utf8');assert.ok(!saved.includes('PRIVATE'));const restored=new StatisticsService({pricing,root});await restored.load();assert.equal(restored.currentAccount,null);assert.equal(restored.query().details.data.find(row=>row.turnId==='one').account.email,'one@example.test');await restored.close();
});
