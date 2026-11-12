import test from 'node:test';
import assert from 'node:assert/strict';
import {StatisticsService} from '../src/statistics.mjs';
import {PricingService} from '../src/pricing.mjs';

function fixture({baseline=true}={}){
 let now=1000;
 const service=new StatisticsService({pricing:new PricingService(),now:()=>now,monotonic:()=>now});
 if(baseline)service.acknowledge('thread/start',{}, {thread:{id:'thread',model:'fixture'}});
 const event=(method,params)=>service.observe({method,params:{threadId:'thread',turnId:'turn',...params}});
 event('turn/started',{turn:{id:'turn',status:'inProgress'}});
 const usage=output=>event('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:100,cachedInputTokens:0,outputTokens:output,reasoningOutputTokens:0,totalTokens:100+output}}});
 const finish=(status='completed',durationMs=2000)=>{now+=2000;event('turn/completed',{turn:{id:'turn',status,durationMs}});};
 const data=()=>service.query();
 return{service,event,usage,finish,data};
}

test('whole-turn output tok/s uses complete output coverage, independently of optional cache-write usage',()=>{
 const f=fixture();f.usage(100);assert.equal(f.data().details.data[0].performance.turnOutputTokensPerSecond,null);
 f.finish();const data=f.data();
 assert.equal(data.details.data[0].performance.turnOutputTokensPerSecond,50);
 assert.deepEqual(data.totals.performance.turnOutputTokensPerSecond,{count:1,p50:50,p95:50,mean:50});
 assert.equal(data.totals.performance.outputTokensPerSecond,null,'no fabricated model generation rate');
 assert.equal(data.totals.performance.textCharsPerSecond.count,0,'no character/token conversion');
 assert.equal(data.details.data[0].tokensComplete,false,'optional cache-write stays unknown');
 assert.match(data.coverage.notes.join(' '),/包含思考、工具和等待/);
});
test('missing initial baseline, resets and omitted output snapshot never produce a partial-throughput estimate',()=>{
 const partial=fixture({baseline:false});partial.usage(100);partial.usage(150);partial.finish();assert.equal(partial.data().details.data[0].performance.turnOutputTokensPerSecond,null);
 const reset=fixture();reset.usage(100);reset.usage(10);reset.finish();assert.equal(reset.data().totals.performance.turnOutputTokensPerSecond.count,0);
 const missing=fixture();missing.usage(100);missing.event('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:150,totalTokens:250}}});missing.usage(120);missing.finish();assert.equal(missing.data().details.data[0].performance.turnOutputTokensPerSecond,null);
});
test('interrupted/failed/zero-duration turns are omitted; a measured zero-output completed turn remains zero',()=>{
 for(const status of ['interrupted','failed']){const f=fixture();f.usage(100);f.finish(status);assert.equal(f.data().details.data[0].performance.turnOutputTokensPerSecond,null);}
 const zeroDuration=fixture();zeroDuration.usage(100);zeroDuration.finish('completed',0);assert.equal(zeroDuration.data().totals.performance.turnOutputTokensPerSecond.count,0);
 const zeroOutput=fixture();zeroOutput.usage(0);zeroOutput.finish();assert.equal(zeroOutput.data().details.data[0].performance.turnOutputTokensPerSecond,0);
});
test('inconsistent token snapshots cannot leave a stale complete rate',()=>{
 for(const totalTokens of [200,250]){
  const f=fixture();f.usage(100);
  f.event('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:100,cachedInputTokens:0,outputTokens:200,reasoningOutputTokens:0,totalTokens}}});
  f.finish();const row=f.data().details.data[0];
  assert.equal(row.performance.turnOutputTokensPerSecond,null);assert.equal(row.outputTokensComplete,false);assert.equal(row.tokens.outputTokens,null);
 }
});
