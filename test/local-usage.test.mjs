import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLocalCodexUsage as parse,mergeLocalCodexUsage as merge} from '../src/local-usage.mjs';
const id='11111111-1111-4111-8111-111111111111';
const meta=extra=>({type:'session_meta',payload:{id,source:'cli',...extra}});
const context=model=>({type:'turn_context',payload:{model}});
const token=(n,extra={})=>({timestamp:'2030-01-01T01:00:00Z',type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:0,total_tokens:n,cached_input_tokens:0,reasoning_output_tokens:0,...extra},last_token_usage:{total_tokens:999999}}}});
const run=records=>parse(records,{sourceId:'synthetic-A'});
test('first snapshot is baseline, repeated totals and last are not additions',()=>{
 const result=run([meta(),context('m'),token(100),token(100),token(105)]);
 assert.equal(result.snapshot.totalTokens,105);assert.equal(result.duplicateEvents,1);assert.equal(result.increments.length,1);assert.equal(result.increments[0].tokens.totalTokens,5);assert.equal(result.increments[0].tokens.cacheWriteInputTokens,null);
});
test('model and rate-limit switches do not reset cumulative baseline',()=>{
 const a=token(10),b=token(15);a.payload.rate_limits={limit_id:'a'};b.payload.rate_limits={limit_id:'b'};
 const result=run([meta(),context('first'),token(0),a,context('second'),b]);
 assert.deepEqual(result.increments.map(e=>[e.model,e.tokens.totalTokens]),[['first',10],['second',5]]);
});
test('reset, historical replay, parent and continuation defer attribution',()=>{
 for(const records of [[meta(),token(5),token(9),token(5)],[meta(),token(5),token(9),token(2)],[meta({forked_from_id:id}),token(0),token(9)],[meta({history_mode:'paginated',history_base:{thread_id:id}}),token(0),token(9)]]){
 const r=run(records);assert.equal(r.attribution,'deferred');assert.deepEqual(r.increments,[]);
 }
});
test('missing, invalid and overflow tokens stay unknown, only observed differences exported',()=>{
 const r=run([meta(),token(Number.MAX_SAFE_INTEGER+1),token(0),token(3)]);
 assert.equal(r.increments[0].model,null);assert.equal(r.increments[0].tokens.totalTokens,3);
 assert.equal(run([meta(),token(-1)]).snapshot.totalTokens,null);
 assert.equal(run([meta(),{type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{total_tokens:3}}}}]).snapshot,null);
});
test('complete EOF accepted; incomplete/invalid lines diagnosed with no raw text retained',()=>{
 const json=[meta(),token(0),token(2)].map(x=>JSON.stringify(x)).join('\n');assert.equal(parse(json,{sourceId:'fixture'}).snapshot.totalTokens,2);
 const r=parse(json+'\n{"secret":',{sourceId:'fixture'});assert.equal(r.attribution,'deferred');assert.ok(r.diagnosticCounts['incomplete-tail']);assert.ok(!JSON.stringify(r).includes('secret'));
});
test('source identity dedup replaces; overlapping sources never summed',()=>{
 const a=run([meta(),token(1)]),b=run([meta(),token(2)]),c=parse([meta(),token(3)],{sourceId:'synthetic-B'});
 const r=merge([a,b,c]);assert.equal(r.sessions.length,2);assert.equal(r.sessions[0].snapshot.totalTokens,2);assert.deepEqual(r.overlappingThreadIds,[id]);assert.equal(r.totalTokens,null);
});
test('WB and tool usage excluded; new unsupported records do not masquerade as zero',()=>{
 const r=run([meta({source:'workbuddy'}),token(123)]);assert.equal(r.snapshot,null);assert.equal(r.tokenEvents,0);assert.deepEqual(r.increments,[]);
 const q=run([meta(),{type:'response_item',payload:{usage:{total_tokens:123},text:'dsh'}},{type:'event_msg',payload:{type:'token_usage_record',usage:{total_tokens:99}}}]);assert.equal(q.snapshot,null);assert.ok(q.diagnosticCounts['usage-record-not-supported']);
});

test('Only declared 0.157.1 missing cache-write uses protocol default; null remains unknown',()=>{
 const known=run([meta({cli_version:'0.157.1'}),context('m'),token(0),token(3)]);assert.equal(known.increments[0].tokens.cacheWriteInputTokens,0);assert.match(known.compatibilityNotice,/逐条/);
 for(const version of ['', '0.156.0', '0.158.0'])assert.equal(run([meta({cli_version:version}),token(3)]).snapshot.cacheWriteInputTokens,null);
 assert.equal(run([meta({cli_version:'0.157.1'}),token(3,{cache_write_input_tokens:null})]).snapshot.cacheWriteInputTokens,null);
 assert.equal(run([meta({parent_thread_id:'22222222-2222-4222-8222-222222222222'}),token(0),token(3)]).attribution,'deferred');
});
