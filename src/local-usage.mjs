// Original, pure parser. Reads no files, makes no requests, performs no price estimation.
import {requestReceipt} from './request-usage.mjs';
const fields = {inputTokens:'input_tokens',cachedInputTokens:'cached_input_tokens',cacheWriteInputTokens:'cache_write_input_tokens',outputTokens:'output_tokens',reasoningOutputTokens:'reasoning_output_tokens',totalTokens:'total_tokens'};
const number = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const string = s => typeof s === 'string' && s.length > 0 && s.length <= 300 ? s : null;
const counters = obj => Object.fromEntries(Object.entries(fields).map(([key, wire]) => [key, number(obj?.[wire])]));
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s) ? s.toLowerCase() : null;
const MAX_RECORDS = 100000;
export const MAX_RECOVERY_LOG_BYTES=64*1024*1024;
// Decode a bounded native log one line at a time, so conversation text and
// attachments from earlier lines are not retained while extracting counters.
function* byteLines(bytes){
  for(let start=0;start<bytes.length;){
    const end=bytes.indexOf(10,start);
    yield {text:bytes.toString('utf8',start,end<0?bytes.length:end),last:end<0};
    if(end<0)break;
    start=end+1;
  }
}
/** sourceId identifies the supplied source, never a rate-limit bucket. No filesystem access. */
export function parseLocalCodexUsage(input, {sourceId} = {}) {
  if (!string(sourceId)) throw new TypeError('A bounded sourceId is required');
  const binary=Buffer.isBuffer(input);
  if (typeof input !== 'string' && !Array.isArray(input)&&!binary) throw new TypeError('Expected JSONL or records array');
  if (binary&&input.length>MAX_RECOVERY_LOG_BYTES)throw new RangeError('Input exceeds recovery byte limit');
  if (typeof input === 'string' && input.length > 32 * 1024 * 1024) throw new RangeError('Input exceeds 32 Mi characters');
  const diagnostics = [], counts = new Map();
  const diagnose = (code, record) => { counts.set(code, (counts.get(code) ?? 0) + 1); if (diagnostics.length < 100) diagnostics.push({code, record}); };
  const raw = binary?byteLines(input):typeof input === 'string' ? input.split('\n') : input;
  let declaredVersion = null;
  const usageCounters=value=>{
    const result=counters(value);
    if(declaredVersion==='0.157.1'&&value&&typeof value==='object'&&!Array.isArray(value)&&!Object.hasOwn(value,'cache_write_input_tokens'))result.cacheWriteInputTokens=0;
    return result;
  };
  let threadId = null, model = null, provider = null, turnId = null, baseline = null, snapshot = null, blocked = false, identityBlocked = false, metadataSeen = false;
  let ownSubagent=false,subagentRootTime=null,awaitingOwnerSettings=false,settingsModel=null;
  const turns=new Map(),coverageStarts=new Set(),coverageGaps=new Set();
  const instant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
  const turn=id=>{if(!string(id))return null;let row=turns.get(id);if(!row){row={turnId:id,model:null,provider,startedAt:null,completedAt:null,status:'unknown'};turns.set(id,row);}return row;};
  let firstTimestamp = null, lastTimestamp = null, tokenEvents = 0, duplicateEvents = 0;
  const increments = [], requests=[], seen = new Set();
  let i=-1;
  for (let row of raw) {
    if(++i>=MAX_RECORDS){diagnose('record-limit',MAX_RECORDS);blocked=true;break;}
    if (binary||typeof input === 'string') {
      const last=binary?row.last:i===raw.length-1;
      if(binary){row=row.text;if(i===0&&row.charCodeAt(0)===0xfeff)row=row.slice(1);}
      if (!row.trim()) continue;
      try { row = JSON.parse(row); } catch { diagnose(last ? 'incomplete-tail' : 'invalid-json',i+1); blocked = true; continue; }
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) { diagnose('invalid-record',i+1); blocked = true; continue; }
    const payload = row.payload;
    // Forks can embed a complete parent transcript (even its session_meta). Only
    // the explicit settings marker naming the new child starts its own event stream.
    if(awaitingOwnerSettings){
      if(row.type!=='event_msg'||payload?.type!=='thread_settings_applied'||payload.thread_id!==threadId)continue;
      awaitingOwnerSettings=false;
    }
    if (row.type === 'session_meta') {
      const id = uuid(payload?.id);
      if (metadataSeen) { diagnose('repeated-session-meta',i+1); blocked = true; identityBlocked = true; }
      metadataSeen = true;declaredVersion = string(payload?.cli_version);
      provider=typeof payload?.model_provider==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(payload.model_provider)?payload.model_provider:null;
      if (!id) { diagnose('invalid-thread-id',i+1); blocked = true; identityBlocked = true; }
      else if (threadId && threadId !== id) { diagnose('mixed-thread-input',i+1); blocked = true; identityBlocked = true; }
      else threadId = id;
      if (payload?.parent_thread_id != null || payload?.forked_from_id != null || payload?.source?.subagent?.thread_spawn?.parent_thread_id != null) {
        subagentRootTime=instant(payload?.timestamp)||instant(row.timestamp);
        ownSubagent=!!uuid(payload?.parent_thread_id)&&payload.parent_thread_id===payload?.source?.subagent?.thread_spawn?.parent_thread_id&&payload?.forked_from_id==null&&payload?.history_base==null&&!!subagentRootTime;
        if(!ownSubagent&&id&&uuid(payload.parent_thread_id)&&payload.parent_thread_id===payload.forked_from_id&&payload.parent_thread_id===payload.source?.subagent?.thread_spawn?.parent_thread_id&&!payload.history_base&&subagentRootTime){
          ownSubagent=true;awaitingOwnerSettings=true;
        }else if(!ownSubagent){diagnose('parent-baseline-unresolved',i+1);blocked=true;}
      }
      // Pagination is a storage format, not evidence that adjacent observed cumulative counters are invalid.
      if (payload?.history_mode === 'paginated') diagnose('paginated-storage',i+1);
      if (payload?.history_base != null) { diagnose('continuation-baseline-unresolved',i+1); blocked = true; }
      const sourceName = typeof payload?.source === 'string' ? payload.source : '';
      if (/workbuddy|deepseek|(^|[^a-z])(?:wb|dsh)(?:[^a-z]|$)/i.test(sourceName)) { diagnose('excluded-non-codex-source',i+1); blocked = true; }
      // No metadata model or source-name guessing. Only documented turn context sets model.
      continue;
    }
    if (counts.has('excluded-non-codex-source')) continue;
    if (row.type === 'turn_context') { model = string(payload?.model) ?? string(payload?.info?.model);if(payload?.turn_id!==undefined)turnId=string(payload.turn_id);const t=turn(turnId);if(t)t.model=model;continue; }
    if (row.type !== 'event_msg') continue; // Chat/tool payloads deliberately never retained.
    if (payload?.type === 'thread_settings_applied') {
      if(payload.thread_id&&payload.thread_id!==threadId)continue;
      model=string(payload.thread_settings?.model);
      if(payload.thread_id===threadId)settingsModel=model;
      const route=payload.thread_settings?.model_provider_id;
      if(typeof route==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(route))provider=route;
      continue;
    }
    if(['task_started','turn_started'].includes(payload?.type)){turnId=string(payload.turn_id);const t=turn(turnId);if(t){t.model??=settingsModel;t.startedAt=instant(row.timestamp);t.status='inProgress';if(baseline&&Object.values(baseline).every(n=>n!==null))coverageStarts.add(turnId);}continue;}
    if(['task_complete','turn_complete','turn_aborted'].includes(payload?.type)){
      const t=turn(string(payload.turn_id)||turnId);if(t){t.completedAt=instant(row.timestamp);t.status=payload.type==='turn_aborted'?'interrupted':payload.error?'failed':'completed';}turnId=null;continue;
    }
    if (payload?.type === 'token_usage_record') { diagnose('usage-record-not-supported',i+1);if(turnId)coverageGaps.add(turnId);if(ownSubagent)blocked=true; continue; }
    if (payload?.type !== 'token_count') continue;
    tokenEvents++;
    if (!threadId) { diagnose('token-before-metadata',i+1); blocked = true; }
    const total = payload.info?.total_token_usage;
    // Empty native usage notifications can precede the first request. A later
    // identical last/cumulative pair still proves that request began at zero.
    if(payload.info==null&&!seen.size&&!baseline)continue;
    if (!total || typeof total !== 'object' || Array.isArray(total)) { diagnose('missing-cumulative-total',i+1);if(turnId)coverageGaps.add(turnId); baseline = null; continue; }
    const current = usageCounters(total), timestamp = string(row.timestamp);
    if(declaredVersion==='0.157.1'&&!Object.hasOwn(total,'cache_write_input_tokens'))diagnose('declared-version-cache-write-default',i+1);
    if (firstTimestamp === null) firstTimestamp = timestamp;
    lastTimestamp = timestamp;
    if(ownSubagent&&JSON.stringify(current)!==JSON.stringify(baseline)){const last=usageCounters(payload.info?.last_token_usage);const expected=baseline?Object.fromEntries(Object.keys(fields).map(key=>[key,current[key]===null||baseline[key]===null?null:current[key]-baseline[key]])):current;const t=turns.get(turnId);
      if(!t?.startedAt||Date.parse(t.startedAt)<Date.parse(subagentRootTime)||!instant(timestamp)||Date.parse(timestamp)<=Date.parse(subagentRootTime)||Object.keys(fields).some(key=>expected[key]===null||last[key]!==expected[key])){diagnose('parent-baseline-unresolved',i+1);blocked=true;}
    }
    snapshot = current;
    // rate_limits.limit_id does not reset session cumulative counters or form a new bill.
    const signature = JSON.stringify(current);
    if (baseline && signature === JSON.stringify(baseline)) { duplicateEvents++; continue; }
    if (seen.has(signature)) { diagnose('replayed-snapshot',i+1); blocked = true; baseline = current; continue; }
    seen.add(signature);
    if (current.totalTokens === null) { diagnose('unknown-cumulative-total',i+1);if(turnId)coverageGaps.add(turnId); baseline = null; continue; }
    if(!blocked){
      const receipt=requestReceipt({threadId,turnId,endTokens:current.totalTokens,timestamp,
        tokens:usageCounters(payload.info?.last_token_usage),model:turns.get(turnId)?.model||model,provider});
      if(receipt && (!baseline || receipt.tokens.totalTokens<=current.totalTokens-baseline.totalTokens))requests.push(receipt);
    }
    // A fully observed first request can anchor zero only with an explicit turn start
    // and identical complete last/cumulative counters. Resumes/forks remain deferred.
    if(!baseline&&seen.size===1&&!blocked&&turnId&&turns.get(turnId)?.startedAt){
      const last=usageCounters(payload.info?.last_token_usage);
      if(instant(timestamp)&&Date.parse(timestamp)>=Date.parse(turns.get(turnId).startedAt)&&Object.keys(fields).every(key=>current[key]!==null&&last[key]===current[key])){baseline=Object.fromEntries(Object.keys(fields).map(key=>[key,0]));coverageStarts.add(turnId);}
    }
    if (!baseline) { diagnose('initial-baseline-unattributed',i+1);if(turnId)coverageGaps.add(turnId); baseline = current; continue; }
    const decreasing = Object.keys(fields).some(key => current[key] !== null && baseline[key] !== null && current[key] < baseline[key]);
    if (decreasing) { diagnose('counter-reset-or-replay',i+1); blocked = true; baseline = current; continue; }
    const difference = Object.fromEntries(Object.keys(fields).map(key => [key, current[key] === null || baseline[key] === null ? null : current[key] - baseline[key]]));
    if (difference.totalTokens > 0) {
      if (blocked) diagnose('increment-deferred',i+1);
      else {
        const turnModel=turnId?turns.get(turnId)?.model||null:model;
        increments.push({record:i+1,timestamp,model:turnModel,provider,turnId,modelAttribution:turnModel === null ? 'unknown' : 'observed-context',tokens:difference,kind:'observed-cumulative-difference'});
        if (!turnModel) diagnose('model-unknown',i+1);
      }
    } else if (Object.values(difference).some(n => n !== null && n > 0)) { diagnose('inconsistent-counters',i+1); blocked = true; }
    baseline = current;
  }
  if (!metadataSeen) diagnose('session-meta-missing',0);
  if(awaitingOwnerSettings){diagnose('parent-baseline-unresolved',0);blocked=true;}
  // Ambiguity discovered late invalidates attribution for the whole supplied timeline.
  if (blocked && increments.length) { diagnose('timeline-attribution-deferred',0); increments.length = 0; }
  const coveredTurns = new Set();
  for (const increment of increments) {
    const t = turns.get(increment.turnId);
    if (!t?.startedAt || !t.completedAt) continue;
    const time = Date.parse(increment.timestamp);
    if (time >= Date.parse(t.startedAt) && time <= Date.parse(t.completedAt) && Object.values(increment.tokens).every(n => n !== null)) {
      coveredTurns.add(t.turnId);
    } else {
      coverageGaps.add(t.turnId);
    }
  }
  return {source:'local-codex-jsonl',sourceId,threadId,declaredVersion,compatibilityNotice:counts.has('declared-version-cache-write-default')?'按会话声明的 0.157.1 协议，将缺失缓存写入字段按默认 0 兼容；恢复后的逐条写入版本未核实。':null,snapshot:counts.has('excluded-non-codex-source') ? null : snapshot,firstTimestamp,lastTimestamp,tokenEvents,duplicateEvents,increments,
    requests:blocked||!threadId?[]:requests,
    provider,turns:identityBlocked||!threadId||counts.has('excluded-non-codex-source')?[]:[...turns.values()].map(t=>({...t,coverageComplete:!blocked&&coverageStarts.has(t.turnId)&&!coverageGaps.has(t.turnId)&&coveredTurns.has(t.turnId)})),turnAttribution:identityBlocked||!threadId?'deferred':'observed-turn-records',attribution:blocked || !threadId ? 'deferred' : 'observed-differences-only',
    diagnostics,diagnosticCounts:Object.fromEntries(counts),
    notice:'仅传入本地记录的观察值；不是官方全局统计或账单，不与其他来源相加。首个累计快照不分摊到模型；缓存与推理不另加到总量。'};
}
/** Last supplied parse replaces an earlier parse of the same thread+source; never adds snapshots. */
export function mergeLocalCodexUsage(results) {
  if (!Array.isArray(results)) throw new TypeError('Expected parse results');
  const byKey = new Map();
  for (const result of results) {
    if (result?.source !== 'local-codex-jsonl' || !string(result.sourceId) || !uuid(result.threadId)) continue;
    byKey.set(JSON.stringify([result.threadId,result.sourceId]),result);
  }
  const sessions = [...byKey.values()], sources = new Map();
  for (const session of sessions) sources.set(session.threadId,(sources.get(session.threadId) ?? 0)+1);
  return {source:'local-codex-jsonl',sessions,overlappingThreadIds:[...sources].filter(([,count])=>count>1).map(([id])=>id),
    totalTokens:null,notice:'不汇总重叠线程或不同来源快照；来源顺序由调用方提供，后传入同键结果覆盖先前结果。'};
}
