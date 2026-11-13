import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {StatisticsService} from '../src/statistics.mjs';
import {PricingService} from '../src/pricing.mjs';
import {parseLocalCodexUsage,mergeLocalCodexUsage} from '../src/local-usage.mjs';
const THREAD='11111111-1111-4111-8111-111111111111';
const EPOCH=Date.UTC(2030,0,1);
const total=(input=100,output=20)=>({inputTokens:input,cachedInputTokens:40,cacheWriteInputTokens:0,outputTokens:output,reasoningOutputTokens:5,totalTokens:input+output});
function fixture(options={}){
 let elapsed=0;const pricing=new PricingService({fetchImpl:()=>{throw new Error('Tests never fetch');}});pricing.catalog={openai:{models:{m:{cost:{input:2,cache_read:1,cache_write:3,output:4}}}}};pricing.fetchedAt='2030-01-01T00:00:00.000Z';
 const service=new StatisticsService({pricing,now:()=>EPOCH+elapsed,monotonic:()=>elapsed,...options});
 const event=(method,params)=>service.observe({method,params:{threadId:THREAD,turnId:'t',...params}});
 const start=(turnId='t',model='m',provider='openai')=>{service.acknowledge('thread/start',{}, {thread:{id:THREAD,model,modelProvider:provider}});event('turn/started',{turn:{id:turnId,status:'inProgress'}});service.acknowledge('turn/start',{threadId:THREAD,model},{turn:{id:turnId}});};
 return {service,event,start,time:value=>{elapsed=value;},pricing};
}
async function directory(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'statistics-fixture-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('live metrics use monotonic visible-text spans; tool gaps are excluded and deltas never retained',async()=>{
 const {service,event,start,time}=fixture();start();
 time(1000);event('item/agentMessage/delta',{itemId:'a',delta:'PRIVATE_FIRST_CHUNK'});
 time(2000);event('item/agentMessage/delta',{itemId:'a',delta:'好🙂'});event('item/completed',{item:{id:'a',type:'agentMessage'}});event('item/completed',{item:{id:'a',type:'agentMessage'}});
 time(10000);event('item/agentMessage/delta',{itemId:'b',delta:'tool gap ended'});
 time(11000);event('item/agentMessage/delta',{itemId:'b',delta:'ab'});event('item/completed',{item:{id:'b',type:'agentMessage'}});
 event('thread/tokenUsage/updated',{tokenUsage:{total:total()}});event('thread/tokenUsage/updated',{tokenUsage:{total:total()}});
 time(15000);event('turn/completed',{turn:{id:'t',status:'completed',durationMs:15000}});
 const data=service.query();assert.equal(data.totals.turnCount,1);assert.equal(data.totals.submissionCount,1);assert.equal(data.totals.requestCount,null);
 assert.equal(data.totals.performance.firstTextLatencyMs.p50,1000);assert.equal(data.totals.performance.durationMs.p95,15000);assert.equal(data.totals.performance.textCharsPerSecond.mean,2);
 assert.equal(data.totals.performance.ttftMs,null);assert.equal(data.totals.performance.outputTokensPerSecond,null);
 assert.equal(data.totals.inputTokens,100);assert.equal(data.totals.outputTokens,20);assert.equal(data.totals.totalTokens,120);assert.equal(data.totals.cacheHitRate,.4);assert.ok(Math.abs(data.totals.estimatedCost.usd-.00024)<1e-12);
 assert.equal(data.totals.estimatedCost.complete,true);assert.equal(data.coverage.completeTokenRows,1);assert.equal(data.totals.successRate,1);
 assert.ok(!JSON.stringify(data).includes('PRIVATE_FIRST_CHUNK'));assert.ok(!JSON.stringify([...service.active.values()]).includes('PRIVATE_FIRST_CHUNK'));await service.close();
});

test('first unknown cumulative baseline is omitted; reset/replay cannot be billed twice',()=>{
 const {service,event,time}=fixture();event('turn/started',{turn:{id:'t',status:'inProgress'}});
 event('thread/tokenUsage/updated',{tokenUsage:{total:total(100)}});assert.equal(service.query().totals.totalTokens,null);
 event('thread/tokenUsage/updated',{tokenUsage:{total:total(110)}});assert.equal(service.query().totals.totalTokens,10);assert.equal(service.query().coverage.completeTokenRows,0);
 event('thread/tokenUsage/updated',{tokenUsage:{total:total(100)}});event('thread/tokenUsage/updated',{tokenUsage:{total:total(110)}});assert.equal(service.query().totals.totalTokens,null);
 time(3000);event('turn/completed',{turn:{id:'t',status:'completed'}});assert.equal(service.query().totals.performance.firstTextLatencyMs.count,0);
});

test('ack-before-start ordering, steer submission, one-chunk speed and duplicate started events remain truthful',()=>{
 const {service,event,time}=fixture();service.acknowledge('turn/start',{threadId:THREAD,model:'m'},{turn:{id:'t'}});
 time(10);event('turn/started',{turn:{id:'t'}});time(20);event('turn/started',{turn:{id:'t'}});
 service.acknowledge('turn/steer',{threadId:THREAD},{turnId:'t'});
 time(110);event('item/agentMessage/delta',{itemId:'a',delta:'one chunk'});time(200);event('turn/completed',{turn:{id:'t',status:'interrupted'}});
 const data=service.query();assert.equal(data.totals.submissionCount,2);assert.equal(data.totals.performance.firstTextLatencyMs.p50,100);assert.equal(data.totals.performance.textCharsPerSecond.count,0);assert.equal(data.totals.interruptionRate,1);assert.equal(data.totals.errorRate,0);
});

test('status rates use terminal turns only; retryable errors do not mark failed; disconnect becomes unknown',()=>{
 const {service,event,start,time}=fixture();start();event('error',{message:'sensitive error text',willRetry:true});assert.equal(service.query().totals.failedCount,0);
 event('turn/completed',{turn:{id:'t',status:'completed'}});
 for(const [i,status] of ['failed','interrupted','completed'].entries()){event('turn/started',{turn:{id:'t'+i}});event('turn/completed',{turn:{id:'t'+i,status}});}
 time(1000);event('turn/started',{turn:{id:'lost'}});service.observe({method:'bridge/status',params:{connected:false}});
 const data=service.query();assert.equal(data.totals.turnCount,5);assert.equal(data.totals.successRate,.5);assert.equal(data.totals.errorRate,.25);assert.equal(data.totals.interruptionRate,.25);assert.equal(data.totals.unknownCount,1);
 assert.ok(!JSON.stringify(data).includes('sensitive error text'));
});

const nativeToken=value=>({timestamp:'2030-01-01T01:00:00Z',type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:value,output_tokens:0,total_tokens:value,cached_input_tokens:0,reasoning_output_tokens:0}}}});
function parsed(sourceId='one'){
 return parseLocalCodexUsage([{type:'session_meta',payload:{id:THREAD,source:'cli',cli_version:'0.157.1',model_provider:'openai'}},
 {timestamp:'2030-01-01T00:00:00Z',type:'event_msg',payload:{type:'task_started',turn_id:'local-t'}},
 {type:'turn_context',payload:{turn_id:'local-t',model:'m'}},nativeToken(0),nativeToken(10),nativeToken(15),
 {timestamp:'2030-01-01T01:00:00Z',type:'event_msg',payload:{type:'task_complete',turn_id:'local-t',last_agent_message:'NEVER RETAIN PRIVATE OUTPUT'}}],{sourceId});
}
test('history groups safe differences by native turn and provider; historical latency/speed stay unavailable',()=>{
 const {service}=fixture();service.importLocal({...mergeLocalCodexUsage([parsed()]),partial:false});const data=service.query({scope:'local',bucket:'hour'});
 assert.equal(data.totals.turnCount,1);assert.equal(data.totals.totalTokens,15);assert.equal(data.totals.submissionCount,null);assert.equal(data.totals.requestCount,null);assert.equal(data.models[0].model,'m');assert.equal(data.providers[0].provider,'openai');
 assert.equal(data.totals.performance.durationMs.p50,3600000);assert.equal(data.totals.performance.firstTextLatencyMs.count,0);assert.equal(data.totals.performance.textCharsPerSecond.count,0);assert.ok(!JSON.stringify(data).includes('PRIVATE OUTPUT'));
 assert.equal(service.query().totals.turnCount,0,'local import never adds into live scope');
});

test('unbound observations are not requests; overlapping sessions retain metadata but exclude token totals',()=>{
 const {service}=fixture();const observation=parseLocalCodexUsage([{type:'session_meta',payload:{id:THREAD,source:'cli'}},nativeToken(0),nativeToken(5)],{sourceId:'old'});
 service.importLocal(mergeLocalCodexUsage([observation]));let data=service.query({scope:'local'});assert.equal(data.totals.turnCount,0);assert.equal(data.coverage.usageObservations,1);assert.equal(data.totals.totalTokens,5);
 service.importLocal(mergeLocalCodexUsage([parsed('one'),parsed('copy')]));data=service.query({scope:'local'});assert.equal(data.details.total,1);assert.equal(data.totals.totalTokens,null);assert.equal(data.coverage.excludedOverlappingThreads,1);
 const ambiguous=parsed();ambiguous.attribution='deferred';service.importLocal(mergeLocalCodexUsage([ambiguous]));assert.equal(service.query({scope:'local'}).coverage.excludedAmbiguousSessions,1);
});

test('pagination is snapshot-stable and bound to filters; trends are observed UTC buckets without fill',()=>{
 const {service,event,time}=fixture();
 for(let i=0;i<3;i++){time(i*86400000);event('turn/started',{turn:{id:'t'+i}});event('turn/completed',{turn:{id:'t'+i,status:'completed'}});}
 const first=service.query({limit:1});assert.equal(first.trend.length,3);assert.equal(first.details.data[0].turnId,'t2');assert.ok(first.details.nextCursor);
 time(2*86400000+1000);event('turn/started',{turn:{id:'new'}});const second=service.query({limit:1,cursor:first.details.nextCursor});assert.equal(second.details.total,3);assert.equal(second.details.data[0].turnId,'t1');
 assert.throws(()=>service.query({limit:2,cursor:first.details.nextCursor}),/过期/);assert.throws(()=>service.query({scope:'all'}));assert.throws(()=>service.query({from:'bad'}));assert.throws(()=>service.query({provider:3}));assert.throws(()=>service.query({cursor:'no'}));
 const filtered=service.query({from:'2030-01-02T00:00:00Z',to:'2030-01-03T00:00:00Z'});assert.equal(filtered.totals.turnCount,1);
});

test('consistent exact-model reference retains the original routing ID and exposes its source',()=>{
 const {service,event,start}=fixture();start('t','m','custom');event('thread/tokenUsage/updated',{tokenUsage:{total:total()}});event('turn/completed',{turn:{id:'t',status:'completed'}});
 const data=service.query();assert.ok(data.totals.estimatedCost.usd>0);assert.equal(data.totals.estimatedCost.pricedRows,1);assert.equal(data.providers[0].provider,'custom');assert.equal(data.details.data[0].estimatedCost.reference.matchedBy,'consistent-model-reference');assert.equal(data.details.data[0].estimatedCost.reference.catalogProvider,'openai');assert.equal(data.dsh.available,false);
});

test('persistence keeps only numeric/identity metadata; active records reopen unknown and corrupted files are preserved',async t=>{
 const root=await directory(t),{service,event,start}=fixture({root});await service.load();start();event('item/agentMessage/delta',{itemId:'x',delta:'PRIVATE_PROMPT_RESPONSE_CONTENT'});await service.flush();
 const saved=await fs.readFile(path.join(root,'live.json'),'utf8');assert.ok(!saved.includes('PRIVATE_PROMPT'));assert.ok(!saved.includes('delta'));assert.ok(!saved.includes('streams'));
 const restored=fixture({root}).service;await restored.load();assert.equal(restored.query().totals.unknownCount,1);await service.close();await restored.close();
 await fs.writeFile(path.join(root,'live.json'),'BROKEN PRIVATE FILE');const blocked=fixture({root}).service;await blocked.load();blocked.observe({method:'turn/started',params:{threadId:THREAD,turn:{id:'test'}}});await blocked.close();assert.equal(await fs.readFile(path.join(root,'live.json'),'utf8'),'BROKEN PRIVATE FILE');assert.ok(blocked.query().coverage.persistenceWarning);
});

test('retention is bounded with explicit partial coverage',async()=>{
 const {service,event}=fixture({limit:2});for(let i=0;i<3;i++){event('turn/started',{turn:{id:'t'+i}});event('turn/completed',{turn:{id:'t'+i,status:'completed'}});}
 const data=service.query();assert.equal(data.totals.turnCount,2);assert.equal(data.coverage.partial,true);assert.equal(data.coverage.retainedLimit,2);await service.close();
});

test('a missing intermediate token counter invalidates that component instead of preserving a stale price',()=>{
 const {service,event,start}=fixture();start();event('thread/tokenUsage/updated',{tokenUsage:{total:total(100,10)}});
 event('thread/tokenUsage/updated',{tokenUsage:{total:{...total(200,20),cachedInputTokens:null}}});
 let data=service.query();assert.equal(data.totals.inputTokens,200);assert.equal(data.totals.cachedInputTokens,null);assert.equal(data.totals.estimatedCost.usd,20*4/1e6);assert.equal(data.totals.estimatedCost.complete,false);assert.equal(data.totals.estimatedCost.partialRows,1);assert.equal(data.details.data[0].estimatedCost.components.find(part=>part.kind==='input').usd,null);
 event('thread/tokenUsage/updated',{tokenUsage:{total:total(300,30)}});data=service.query();assert.equal(data.totals.cachedInputTokens,null,'later known samples cannot recover an unknown earlier contribution');assert.equal(data.totals.estimatedCost.usd,30*4/1e6);assert.equal(data.details.data[0].estimatedCost.components.find(part=>part.kind==='cacheRead').usd,null);
});

test('malformed decoded cursor values fail with a controlled 400',()=>{
 const {service}=fixture();for(const value of [null,[],42,'text',{id:'x'},{id:'x',offset:0,extra:1}])assert.throws(()=>service.query({cursor:Buffer.from(JSON.stringify(value)).toString('base64url')}),e=>e.status===400&&e.outcome==='notExecuted');
});

test('a legacy turn with context and timestamped usage but no lifecycle event remains filterable and charted',()=>{
 const {service}=fixture();const session=parseLocalCodexUsage([{type:'session_meta',payload:{id:THREAD,source:'cli'}},{type:'turn_context',payload:{turn_id:'old-t',model:'m'}},nativeToken(0),nativeToken(100)],{sourceId:'legacy'});
 service.importLocal(mergeLocalCodexUsage([session]));const data=service.query({scope:'local',from:'2030-01-01T00:00:00Z',to:'2030-01-02T00:00:00Z'});
 assert.equal(data.totals.totalTokens,100);assert.equal(data.trend.length,1);assert.equal(data.details.data[0].startedAt,null);assert.equal(data.details.data[0].timestamp,'2030-01-01T01:00:00.000Z');assert.equal(data.totals.performance.durationMs.count,0);
});

test('unused new-thread baselines share the metadata retention bound',()=>{
 const {service}=fixture();for(let i=0;i<1100;i++)service.acknowledge('thread/start',{}, {thread:{id:'thread-'+i,model:'m'}});
 assert.equal(service.baselines.size,1000);assert.equal(service.threads.size,1000);assert.equal(service.query().totals.turnCount,0);
});
