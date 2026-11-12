import test from 'node:test';
import assert from 'node:assert/strict';
import {safeUsageNumber,formatUsageNumber,formatUsageMicros,normalizeOfficialUsageStatistics,normalizeTokenUsageEvent,createTokenUsageSnapshots,mountOfficialUsageStatistics,USAGE_UNKNOWN} from '../public/usage-statistics.js';

test('unknown, zero, overflow and micro units are distinguished', () => {
  for (const value of [null,undefined,-1,1.1,Infinity,NaN,'0',Number.MAX_SAFE_INTEGER+1]) assert.equal(safeUsageNumber(value),null);
  assert.equal(safeUsageNumber(0),0); assert.equal(safeUsageNumber(Number.MAX_SAFE_INTEGER),Number.MAX_SAFE_INTEGER);
  assert.equal(formatUsageNumber(null),USAGE_UNKNOWN); assert.equal(formatUsageNumber(0),'0');
  assert.equal(formatUsageMicros(1),'0.000001 USD'); assert.equal(formatUsageMicros(0),'0.000000 USD');
  assert.equal(formatUsageMicros(1234567,'积分'),'1.234567 积分');
  assert.equal(formatUsageMicros(Number.MAX_SAFE_INTEGER),'9007199254.740991 USD');
});
test('official projection preserves date strings, unknown versus empty, and backend total', () => {
  assert.equal(normalizeOfficialUsageStatistics({}).dailyUsageBuckets,null);
  const value=normalizeOfficialUsageStatistics({summary:{lifetimeTokens:0},dailyUsageBuckets:[{startDate:'2030-01-02 server zone',tokens:2},{startDate:'2030-01-01',tokens:null}],threadUsage:{threadId:'t',groups:[{model:'m',inputTokens:100,cachedInputTokens:40,outputTokens:10,totalTokens:110}],estimatedUsageUsdMicros:0}});
  assert.equal(value.summary.lifetimeTokens,0); assert.equal(value.summary.peakDailyTokens,null);
  assert.equal(value.dailyUsageBuckets[0].startDate,'2030-01-02 server zone'); assert.equal(value.dailyUsageBuckets[1].tokens,null);
  assert.equal(value.threadUsage.groups[0].totalTokens,110); assert.equal(value.threadUsage.estimatedUsageUsdMicros,0);
  assert.deepEqual(normalizeOfficialUsageStatistics({dailyUsageBuckets:[]}).dailyUsageBuckets,[]);
});
test('notifications overwrite per thread, including duplicate snapshots and rollback', () => {
  const store=createTokenUsageSnapshots();
  const event={threadId:'a',tokenUsage:{total:{totalTokens:100,inputTokens:80,cachedInputTokens:40,outputTokens:20,reasoningOutputTokens:10},last:{totalTokens:400}}};
  store.update(event);store.update(event); assert.equal(store.get('a').totalTokens,100);
  store.update({threadId:'b',tokenUsage:{total:{totalTokens:25}}}); assert.equal(store.get('a').totalTokens,100);
  store.update({threadId:'a',tokenUsage:{total:{totalTokens:3}}}); assert.equal(store.get('a').totalTokens,3);
  store.get('a').totalTokens=999; assert.equal(store.get('a').totalTokens,3);
  store.update({threadId:'a',tokenUsage:{last:{totalTokens:500}}}); assert.equal(store.get('a').totalTokens,null);
  assert.equal(normalizeTokenUsageEvent({}),null); assert.equal(store.update({threadId:''}),null);
  store.clear('a'); assert.equal(store.get('a'),null); assert.equal(store.get('b').totalTokens,25); store.clear(); assert.equal(store.get('b'),null);
});
test('backend groups remain per-thread/per-effort and projections omit unrecognized telemetry', () => {
  const data=normalizeOfficialUsageStatistics({wb:{tokens:999},summary:{lifetimeTokens:10,secret:'x'},threadUsage:{threadId:'a',groups:[{model:'same',reasoningEffort:'high',totalTokens:3},{model:'same',reasoningEffort:'low',totalTokens:4}]}});
  assert.equal(data.threadUsage.groups.length,2);assert.equal(data.summary.lifetimeTokens,10); assert.ok(!JSON.stringify(data).includes('secret'));assert.ok(!JSON.stringify(data).includes('999'));
});
class Element {
  constructor(tag,doc){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.style={};this.attributes={};this.classList={add:()=>{}};this.textContent='';}
  append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=[...nodes];}setAttribute(k,v){this.attributes[k]=v;}
  set innerHTML(_){throw new Error('HTML forbidden');}
}
const doc={createElement:tag=>new Element(tag,doc)};
const text=el=>[el.textContent,...el.children.map(text)].join(' ');
const descendants=el=>[el,...el.children.flatMap(descendants)];
test('mount has accessible tables, safe text trend, explicit source and no network', () => {
  const root=new Element('section',doc), panel=mountOfficialUsageStatistics(root);
  panel.update({dailyUsageBuckets:[{startDate:'<script>bad</script>',tokens:0},{startDate:'server date',tokens:100},{startDate:null,tokens:null}],threadUsage:{threadId:'t',groups:[]}});
  assert.match(text(root),/来源：Codex 账户用量数据/);assert.match(text(root),/官方接口数据/); assert.match(text(root),/不与本地扫描统计相加/); assert.match(text(root),/<script>bad<\/script>/);
  assert.ok(descendants(root).some(el=>el.tagName==='caption'&&el.textContent.includes('日桶')));
  const bars=descendants(root).filter(el=>el.className==='usage-statistics-bar'); assert.deepEqual(bars.map(el=>el.style.width),['0%','100%']); assert.equal(bars[0].attributes['aria-hidden'],'true');
  assert.ok(descendants(root).some(el=>el.attributes.scope==='row'));
  panel.update({}, {loading:true}); assert.equal(root.attributes['aria-busy'],'true'); assert.equal(descendants(root).filter(el=>el.tagName==='table').length,0);
  panel.update({}, {error:true}); assert.match(text(root),/读取失败/); panel.reset();assert.equal(root.attributes['aria-busy'],'false');
  panel.destroy();panel.update({});assert.equal(root.children.length,0);
});
test('different thread snapshot is not rendered and missing costs do not invent prices', () => {
  const root=new Element('section',doc),panel=mountOfficialUsageStatistics(root);
  panel.update({threadUsage:{threadId:'selected',groups:[]}}, {tokenSnapshot:{threadId:'other',totalTokens:12345}});
  assert.ok(!text(root).includes('实时累计'));assert.ok(!text(root).includes('12,345'));assert.match(text(root),/未知/);
});
test('bounds are explicit and do not recompute global totals from partial rows', () => {
  const data=normalizeOfficialUsageStatistics({summary:{lifetimeTokens:99},dailyUsageBuckets:Array(3661).fill({tokens:1}),threadUsage:{groups:Array(501).fill({totalTokens:1})}});
  assert.equal(data.dailyUsageBuckets.length,3660);assert.equal(data.bucketsTruncated,true);assert.equal(data.threadUsage.groups.length,500);assert.equal(data.threadUsage.groupsTruncated,true);assert.equal(data.summary.lifetimeTokens,99);
});
test('account and thread scopes render separately without fabricated unknown sections',()=>{
 const root=new Element('section',doc),panel=mountOfficialUsageStatistics(root);
 panel.update({summary:{lifetimeTokens:2}},{scope:'account'});assert.match(text(root),/全局汇总/);assert.ok(!text(root).includes('当前会话估算'));
 panel.update({threadUsage:{threadId:'t',groups:[]}},{scope:'thread'});assert.match(text(root),/当前会话估算/);assert.ok(!text(root).includes('全局汇总'));assert.ok(!text(root).includes('日趋势：'));
});
