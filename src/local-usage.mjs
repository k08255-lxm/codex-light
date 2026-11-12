// Original, pure parser. Reads no files, makes no requests, performs no price estimation.
const fields = {inputTokens:'input_tokens',cachedInputTokens:'cached_input_tokens',cacheWriteInputTokens:'cache_write_input_tokens',outputTokens:'output_tokens',reasoningOutputTokens:'reasoning_output_tokens',totalTokens:'total_tokens'};
const number = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const string = s => typeof s === 'string' && s.length > 0 && s.length <= 300 ? s : null;
const counters = obj => Object.fromEntries(Object.entries(fields).map(([key, wire]) => [key, number(obj?.[wire])]));
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s) ? s.toLowerCase() : null;
const MAX_RECORDS = 100000;
/** sourceId identifies the supplied source, never a rate-limit bucket. No filesystem access. */
export function parseLocalCodexUsage(input, {sourceId} = {}) {
  if (!string(sourceId)) throw new TypeError('A bounded sourceId is required');
  if (typeof input !== 'string' && !Array.isArray(input)) throw new TypeError('Expected JSONL string or records array');
  if (typeof input === 'string' && input.length > 32 * 1024 * 1024) throw new RangeError('Input exceeds 32 Mi characters');
  const diagnostics = [], counts = new Map();
  const diagnose = (code, record) => { counts.set(code, (counts.get(code) ?? 0) + 1); if (diagnostics.length < 100) diagnostics.push({code, record}); };
  const raw = typeof input === 'string' ? input.split('\n') : input;
  let declaredVersion = null;
  let threadId = null, model = null, provider = null, turnId = null, baseline = null, snapshot = null, blocked = false, metadataSeen = false;
  const turns=new Map();
  const instant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
  const turn=id=>{if(!string(id))return null;let row=turns.get(id);if(!row){row={turnId:id,model,provider,startedAt:null,completedAt:null,status:'unknown'};turns.set(id,row);}return row;};
  let firstTimestamp = null, lastTimestamp = null, tokenEvents = 0, duplicateEvents = 0;
  const increments = [], seen = new Set();
  if (raw.length > MAX_RECORDS) { diagnose('record-limit',MAX_RECORDS); blocked = true; }
  for (let i = 0; i < Math.min(raw.length,MAX_RECORDS); i++) {
    let row = raw[i];
    if (typeof input === 'string') {
      if (!row.trim()) continue;
      try { row = JSON.parse(row); } catch { diagnose(i === raw.length - 1 ? 'incomplete-tail' : 'invalid-json',i+1); blocked = true; continue; }
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) { diagnose('invalid-record',i+1); blocked = true; continue; }
    const payload = row.payload;
    if (row.type === 'session_meta') {
      const id = uuid(payload?.id);
      if (metadataSeen) { diagnose('repeated-session-meta',i+1); blocked = true; }
      metadataSeen = true;declaredVersion = string(payload?.cli_version);
      provider=typeof payload?.model_provider==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(payload.model_provider)?payload.model_provider:null;
      if (!id) { diagnose('invalid-thread-id',i+1); blocked = true; }
      else if (threadId && threadId !== id) { diagnose('mixed-thread-input',i+1); blocked = true; }
      else threadId = id;
      if (payload?.parent_thread_id != null || payload?.forked_from_id != null || payload?.source?.subagent?.thread_spawn?.parent_thread_id != null) { diagnose('parent-baseline-unresolved',i+1); blocked = true; }
      if (payload?.history_mode === 'paginated' || payload?.history_base != null) { diagnose('continuation-baseline-unresolved',i+1); blocked = true; }
      const sourceName = typeof payload?.source === 'string' ? payload.source : '';
      if (/workbuddy|deepseek|(^|[^a-z])(?:wb|dsh)(?:[^a-z]|$)/i.test(sourceName)) { diagnose('excluded-non-codex-source',i+1); blocked = true; }
      // No metadata model or source-name guessing. Only documented turn context sets model.
      continue;
    }
    if (counts.has('excluded-non-codex-source')) continue;
    if (row.type === 'turn_context') { model = string(payload?.model) ?? string(payload?.info?.model);if(payload?.turn_id!==undefined)turnId=string(payload.turn_id);const t=turn(turnId);if(t)t.model=model;continue; }
    if (row.type !== 'event_msg') continue; // Chat/tool payloads deliberately never retained.
    if (payload?.type === 'thread_settings_applied') { model = string(payload.thread_settings?.model); continue; }
    if(['task_started','turn_started'].includes(payload?.type)){turnId=string(payload.turn_id);const t=turn(turnId);if(t){t.startedAt=instant(row.timestamp);t.status='inProgress';}continue;}
    if(['task_complete','turn_complete','turn_aborted'].includes(payload?.type)){
      const t=turn(string(payload.turn_id)||turnId);if(t){t.completedAt=instant(row.timestamp);t.status=payload.type==='turn_aborted'?'interrupted':payload.error?'failed':'completed';}turnId=null;continue;
    }
    if (payload?.type === 'token_usage_record') { diagnose('usage-record-not-supported',i+1); continue; }
    if (payload?.type !== 'token_count') continue;
    tokenEvents++;
    if (!threadId) { diagnose('token-before-metadata',i+1); blocked = true; }
    const total = payload.info?.total_token_usage;
    if (!total || typeof total !== 'object' || Array.isArray(total)) { diagnose('missing-cumulative-total',i+1); baseline = null; continue; }
    const current = counters(total), timestamp = string(row.timestamp);
    if(declaredVersion==='0.157.1'&&!Object.hasOwn(total,'cache_write_input_tokens')){current.cacheWriteInputTokens=0;diagnose('declared-version-cache-write-default',i+1);}
    if (firstTimestamp === null) firstTimestamp = timestamp;
    lastTimestamp = timestamp;
    snapshot = current;
    // rate_limits.limit_id does not reset session cumulative counters or form a new bill.
    const signature = JSON.stringify(current);
    if (baseline && signature === JSON.stringify(baseline)) { duplicateEvents++; continue; }
    if (seen.has(signature)) { diagnose('replayed-snapshot',i+1); blocked = true; baseline = current; continue; }
    seen.add(signature);
    if (current.totalTokens === null) { diagnose('unknown-cumulative-total',i+1); baseline = null; continue; }
    if (!baseline) { diagnose('initial-baseline-unattributed',i+1); baseline = current; continue; }
    const decreasing = Object.keys(fields).some(key => current[key] !== null && baseline[key] !== null && current[key] < baseline[key]);
    if (decreasing) { diagnose('counter-reset-or-replay',i+1); blocked = true; baseline = current; continue; }
    const difference = Object.fromEntries(Object.keys(fields).map(key => [key, current[key] === null || baseline[key] === null ? null : current[key] - baseline[key]]));
    if (difference.totalTokens > 0) {
      if (blocked) diagnose('increment-deferred',i+1);
      else {
        increments.push({record:i+1,timestamp,model,provider,turnId,modelAttribution:model === null ? 'unknown' : 'observed-context',tokens:difference,kind:'observed-cumulative-difference'});
        if (!model) diagnose('model-unknown',i+1);
      }
    } else if (Object.values(difference).some(n => n !== null && n > 0)) { diagnose('inconsistent-counters',i+1); blocked = true; }
    baseline = current;
  }
  if (!metadataSeen) diagnose('session-meta-missing',0);
  // Ambiguity discovered late invalidates attribution for the whole supplied timeline.
  if (blocked && increments.length) { diagnose('timeline-attribution-deferred',0); increments.length = 0; }
  return {source:'local-codex-jsonl',sourceId,threadId,declaredVersion,compatibilityNotice:counts.has('declared-version-cache-write-default')?'按会话声明的 0.157.1 协议，将缺失缓存写入字段按默认 0 兼容；恢复后的逐条写入版本未核实。':null,snapshot:counts.has('excluded-non-codex-source') ? null : snapshot,firstTimestamp,lastTimestamp,tokenEvents,duplicateEvents,increments,
    provider,turns:blocked?[]:[...turns.values()],attribution:blocked || !threadId ? 'deferred' : 'observed-differences-only',
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
