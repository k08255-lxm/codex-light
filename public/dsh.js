// Read-only projections of existing Codex -> DSH MCP traffic. No network/model calls.
import { projectDelegatedEdit } from './delegated-changes.js';
const FIELDS = ['status','name','cwd','answer','partial_text','last_event','progress','error','finish_reason','updated_at','created_at','started_at','last_completed_answer','wait_outcome','next_action','context_tokens','context_limit_tokens'];
const MAX_TEXT = 16000;
const MAX_EVENT_TEXT = 16000;
const MAX_EVENT_SUMMARY = 4000;
const MAX_EVENT_DETAILS = 16000;
const MAX_EVENTS = 100;
const ACTIVE_STATUSES = new Set(['starting', 'running', 'interrupting']);
const TERMINAL_STATUSES = new Set(['completed', 'idle', 'error', 'failed', 'cancelled', 'interrupted', 'context_exhausted', 'closed']);
const text = (value, max = MAX_TEXT) => {
  if (value === undefined || value === null) return '';
  let s; try { s = typeof value === 'string' ? value : JSON.stringify(value); } catch { return '[无法显示]'; }
  return s.length > max ? s.slice(0, max) + '\n…〔显示已截断〕' : s;
};
const clip = (value, max) => {
  const s = String(value ?? '');
  return s.length > max ? s.slice(0, max) + '\n…〔显示已截断〕' : s;
};
const object = value => {
  if (typeof value === 'string') { if (value.length > 1024 * 1024) return null; try { value = JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
};
export function dshModelMetadata(value) {
  const safe=item=>typeof item==='string'&&item.trim()&&item.length<=256&&!/[\x00-\x1f]/.test(item)?item.trim():'';
  const model=safe(value?.model)||safe(value?.model_name);
  const provider=safe(value?.provider)||safe(value?.model_provider);
  const effort=safe(value?.effort)||safe(value?.reasoning_effort)||safe(value?.reasoningEffort);
  return {...(model?{model}:{}),...(provider?{provider}:{}),...(effort?{effort}:{})};
}
const isDshServer = name => /^dsh[-_]subagent(?:\s*\(demo\))?$/i.test(String(name || ''));
export function isDshItem(item) { return item?.type === 'mcpToolCall' && isDshServer(item.server) && /^dsh_/.test(item.tool || ''); }
export function dshRuntimeStatusLabel(status) { return ({notStarted:'尚未启动',starting:'正在启动',connected:'已连接',authenticationRequired:'需要身份验证',failed:'连接失败',cancelled:'连接已取消',disabled:'已禁用'})[status] || (status ? `未知状态（${text(status,120)}）` : '会话连接状态未知'); }
export function dshConnectionSummary(data, scope = '全局', {sessionScoped = false} = {}) {
  const entries = (Array.isArray(data) ? data : []).filter(row => isDshServer(row.name)).slice(0, 10);
  if (!entries.length) return { label: '未发现 DSH MCP', connected: false, scope, servers: [] };
  const servers = entries.map(row => ({ name: text(row.name, 120), runtimeStatus: text(row.runtimeStatus, 120), authStatus: text(row.authStatus, 120), toolCount: Array.isArray(row.tools) ? row.tools.length : row.tools && typeof row.tools === 'object' ? Object.keys(row.tools).length : 0 }));
  const connected = servers.some(row => row.runtimeStatus === 'connected');
  const label = connected ? 'DSH MCP 已连接' : servers.some(row => !row.runtimeStatus) ? (sessionScoped ? '已发现 DSH 工具目录；会话连接状态未知' : '已发现 DSH 工具目录；尚未检查会话连接') : `DSH MCP：${servers.map(row => dshRuntimeStatusLabel(row.runtimeStatus)).join(' / ')}`;
  return { label, connected, scope, sessionScoped, servers };
}

/** All JSON payload layers a tool result may use. Compact bridges return content[].text only;
 * older adapters return structuredContent or the tool object directly. Never execute or fetch. */
function resultRoots(result) {
  const root = object(result); if (!root) return [];
  const roots = [], seen = new Set();
  const add = value => {
    const row = object(value); if (!row || seen.has(row)) return;
    seen.add(row); roots.push(row);
    for (const key of ['structuredContent', 'result', 'data', 'agent', 'output']) if (row[key] !== undefined) add(row[key]);
    for (const block of Array.isArray(row.content) ? row.content.slice(0, 20) : []) if (block?.type === 'text') add(block.text);
  };
  add(root.structuredContent);
  for (const block of Array.isArray(root.content) ? root.content.slice(0, 20) : []) if (block?.type === 'text') add(block.text);
  add(root.result);
  add(root.data);
  add(root.agent);
  add(root);
  return roots;
}
function listRows(root) {
  for (const key of ['items', 'agents', 'list']) if (Array.isArray(root?.[key])) return root[key];
  if (Array.isArray(root?.data)) return root.data;
  return null;
}
/** A single task ID for scope checks. List envelopes are ambiguous and deliberately return ''. */
export function dshToolResultAgentId(result) {
  const ids = new Set();
  for (const root of resultRoots(result)) {
    if (!root || root.isError) continue;
    if (listRows(root)) continue;
    const id = root.agent_id ?? root.agentId ?? root.id;
    if (typeof id === 'string' && id) ids.add(text(id, 200));
  }
  if (ids.size > 1) return 'conflict';
  return [...ids][0] || '';
}
/** Legacy status carries the exact parent Codex thread; compact list/status do not. */
export function dshToolResultParentThreadId(result) {
  for (const root of resultRoots(result)) {
    if (!root || root.isError || listRows(root)) continue;
    const parent = root.parent_thread_id ?? root.parentThreadId;
    if (typeof parent === 'string' && parent) return text(parent, 200);
  }
  return '';
}
function payloads(result) {
  const rows = [], seen = new Set();
  const push = value => {
    const row = object(value); if (!row || seen.has(row)) return;
    seen.add(row); rows.push(row);
  };
  for (const root of resultRoots(result)) {
    if (!root || root.isError) continue;
    const items = listRows(root);
    if (items) { for (const entry of items.slice(0, 50)) if (object(entry)?.agent_id) push(entry); continue; }
    if (Array.isArray(root.events) || root.agent_id || root.status || root.answer || root.partial_text || root.finish_reason) push(root);
  }
  return rows.slice(0, 50);
}
function extract(row, args, { allowIdAlias = false } = {}) {
  const id = row?.agent_id || (allowIdAlias ? row?.id : null) || args?.agent_id;
  const out = { agentId: id ? text(id, 200) : null, ...dshModelMetadata(row) };
  for (const field of FIELDS) if (row && row[field] !== undefined && row[field] !== null) {
    if (field === 'context_tokens' || field === 'context_limit_tokens') {
      const numeric = Number(row[field]);
      out[field] = Number.isFinite(numeric) ? numeric : text(row[field], 120);
    } else out[field] = text(row[field], field === 'answer' || field === 'partial_text' || field === 'last_completed_answer' ? MAX_TEXT : 4000);
  }
  if (Array.isArray(row?.events) && row.events.length) {
    const events = mergeDshEvents([], row.events);
    const meaningful = events.filter(event => event.text || event.summary || event.details);
    if (meaningful.length) out.eventSummary = text(meaningful.slice(-5).map(eventLine).join('\n'), 16000);
    const final = lastFinalEvent(events);
    if (final?.text) { out.finalText = final.text; out.finalEventId = final.event_id; out.finalEventSeq = final.seq; }
    out.lastEventType = events.at(-1)?.type || '';
  }
  if (!out.name && args?.name) out.name = text(args.name, 160);
  if (!out.cwd && args?.cwd) out.cwd = text(args.cwd, 2000);
  return out;
}
export function dshStatusLabel(task) {
  if (!task.status) return task.callState === 'completed' ? '调用已返回，任务状态未知' : task.callState === 'failed' ? 'MCP 调用失败，任务状态未知' : '等待 DSH 状态';
  return ({starting:'启动中',running:'运行中',interrupting:'正在中断',idle:'空闲',completed:'已完成',interrupted:'已中断',error:'任务错误',context_exhausted:'上下文已耗尽',closed:'已关闭'})[task.status] || `DSH 返回：${text(task.status, 120)}`;
}
export function isDshTerminalStatus(status) { return TERMINAL_STATUSES.has(String(status || '').toLowerCase()); }
function isActiveStatus(status) { return ACTIVE_STATUSES.has(String(status || '').toLowerCase()); }
function isFinalEventType(type) { return /(?:^|\/)assistant\/(?:final|final_answer)$/i.test(String(type || '')) || /^final$/i.test(String(type || '')); }
function lastFinalEvent(events) {
  for (let index = (events?.length || 0) - 1; index >= 0; index--) if (isFinalEventType(events[index]?.type) && events[index].text) return events[index];
  return null;
}
function eventLine(event) { return `${event.type || 'event'}: ${event.text || event.summary || event.details || ''}`.trimEnd(); }

/** Return the first object payload that satisfies the projection. */
function resultPayload(result, predicate) {
  const root = object(result); if (!root) return null;
  const roots = [];
  const seen = new Set();
  const add = value => {
    const row = object(value); if (!row || seen.has(row)) return;
    seen.add(row); roots.push(row);
    if (row.data && typeof row.data === 'object') add(row.data);
    if (row.result && typeof row.result === 'object') add(row.result);
    if (row.structuredContent && typeof row.structuredContent === 'object') add(row.structuredContent);
    for (const block of Array.isArray(row.content) ? row.content.slice(0, 20) : []) if (block?.type === 'text') add(block.text);
  };
  add(root.structuredContent);
  for (const block of Array.isArray(root.content) ? root.content.slice(0, 20) : []) if (block?.type === 'text') add(block.text);
  add(root);
  for (const candidate of roots) if (!candidate.isError && predicate(candidate)) return candidate;
  return null;
}
export function dshResultError(result) {
  const r = object(result); if (!r) return '';
  const roots = [r, object(r.result), object(r.structuredContent), object(r.data)].filter(Boolean);
  const failed = roots.find(row => row.isError === true);
  if (!failed) return '';
  const content = Array.isArray(failed.content) ? failed.content : [];
  return text(content.filter(row => row?.type === 'text').map(row => row.text).join('\n') || failed.message || failed.error || 'DSH 工具返回错误', 4000);
}

const DETAIL_KEYS = ['name', 'tool', 'command', 'path', 'status', 'exit_code', 'exitCode', 'call_id', 'callId', 'id'];
const scalar = value => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
function pickedDetail(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const add = row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    for (const key of DETAIL_KEYS) if (scalar(row[key])) out[key] = typeof row[key] === 'string' ? row[key].slice(0, 1000) : row[key];
  };
  add(value);
  add(value.event?.data);
  add(value.data);
  return out;
}
function flatObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.length <= 12 && entries.every(([, item]) => scalar(item) || item === null);
}
/** Human-readable one-liner for the fields tool events actually carry. */
function describeDetail(value) {
  const picked = pickedDetail(value);
  const keys = Object.keys(picked);
  if (keys.length) {
    const parts = [];
    const name = picked.name ?? picked.tool;
    if (name !== undefined) parts.push(String(name));
    for (const key of keys) if (key !== 'name' && key !== 'tool') parts.push(`${key}=${String(picked[key])}`);
    return parts.join(' · ').slice(0, MAX_EVENT_SUMMARY);
  }
  if (flatObject(value)) return text(value, MAX_EVENT_SUMMARY);
  return '';
}
function detailsOf(value) {
  const out = pickedDetail(value);
  for (const key of ['arguments', 'args', 'input', 'description', 'message']) {
    const item = value?.[key];
    if (scalar(item)) out[key] = typeof item === 'string' ? item.slice(0, MAX_EVENT_TEXT) : item;
  }
  if (!Object.keys(out).length) return '';
  return text(out, MAX_EVENT_DETAILS);
}
function assistantTextOf(event, data) {
  const direct = event?.text ?? data?.text ?? data?.event?.text;
  if (typeof direct === 'string') return direct;
  const message = data?.message ?? data?.event?.data?.message;
  return (Array.isArray(message?.content) ? message.content : []).filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n');
}
function continuationOffset(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+):(\d+):(\d+)$/.exec(value);
  if (!match) return null;
  const offset = Number(match[3]);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
}
function defineInternal(row, key, value) { try { Object.defineProperty(row, key, { value, enumerable: false, configurable: true, writable: true }); } catch { row[key] = value; } }
function isReasoningType(type) { return /(?:^|[\/:_-])(?:reasoning|thinking|analysis|chain[_/-]?of[_/-]?thought|internal)(?:[\/:_-]|$)/i.test(String(type || '')); }

function normalizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const data = object(event.data);
  const nestedType = data?.event?.type ?? data?.type;
  const type = text(event.type || event.kind || nestedType || 'event', 200);
  // Do not surface provider-internal reasoning even if a bridge labels it as an event.
  if (isReasoningType(type) || isReasoningType(nestedType)) return null;
  const eventId = text(event.event_id ?? event.eventId ?? '', 300);
  const seqRaw = event.seq;
  const seq = typeof seqRaw === 'number' ? seqRaw : seqRaw === undefined || seqRaw === null ? null : text(seqRaw, 120);
  let eventText = event.text === undefined || event.text === null ? '' : text(event.text, MAX_EVENT_TEXT);
  if (!eventText) { const assistant = assistantTextOf(event, data); if (assistant) eventText = text(assistant, MAX_EVENT_TEXT); }
  let summary = '', details = '';
  if (object(event.summary)) { summary = describeDetail(event.summary); details = detailsOf(event.summary); }
  else if (event.summary !== undefined && event.summary !== null) summary = text(event.summary, MAX_EVENT_SUMMARY);
  if (!summary && data) summary = describeDetail(data);
  if (!details && data) details = detailsOf(data);
  const chunk = typeof event.data_chunk === 'string' ? event.data_chunk : '';
  const continuation = event.continuation_cursor === undefined || event.continuation_cursor === null ? undefined : event.continuation_cursor;
  if (!eventId && seq === null && !eventText && !summary && !details && !chunk) return null;
  const row = { event_id: eventId, seq, type };
  const edit=projectDelegatedEdit(event);
  if(edit?.changes.length)row.changes=edit.changes;
  if(typeof event.success==='boolean')row.success=edit.success;
  if(edit?.taskTurn)row.taskTurn=edit.taskTurn;
  if(edit?.callId)row.callId=edit.callId;
  if (eventText) row.text = eventText;
  if (summary) row.summary = summary;
  if (details) row.details = details;
  if (event.scope) row.scope = text(event.scope, 40);
  if (continuation !== undefined) row.continuation_cursor = continuation;
  if (chunk) defineInternal(row, '_chunk', { encoding: event.encoding === 'json' ? 'json' : 'text', text: chunk });
  defineInternal(row, '_normalized', true);
  return row;
}
function mergeText(target, incoming, field) {
  const next = incoming[field], previous = target[field];
  if (!next) return;
  if (!previous) { target[field] = next; return; }
  if (previous === next || previous.includes(next)) return;
  if (next.startsWith(previous)) { target[field] = next; return; }
  const offset = incoming.chunk_start ?? continuationOffset(incoming.continuation_cursor);
  if (offset !== null) {
    if (previous.length === offset) { target[field] = clip(previous + next, field === 'text' ? MAX_EVENT_TEXT : MAX_EVENT_DETAILS); return; }
    if (previous.length > offset && previous.slice(offset).startsWith(next)) return;
  }
  if (next.length > previous.length) target[field] = next;
}
function mergeChunk(target, incoming) {
  const incomingChunk = incoming._chunk, current = target._chunk;
  if (!incomingChunk) return;
  if (!current) { defineInternal(target, '_chunk', { ...incomingChunk }); return; }
  const next = incomingChunk.text, previous = current.text;
  if (!previous) { current.text = next; current.encoding = incomingChunk.encoding; return; }
  if (previous === next || previous.includes(next)) return;
  const offset = incoming.chunk_start ?? continuationOffset(incoming.continuation_cursor);
  if (offset !== null && previous.length === offset) { current.text = clip(previous + next, MAX_EVENT_TEXT * 2); return; }
  if (offset !== null && previous.length > offset && previous.slice(offset).startsWith(next)) return;
  if (next.startsWith(previous) || next.length > previous.length) { current.text = next; current.encoding = incomingChunk.encoding; }
}
function mergeEventRow(target, incoming) {
  for(const key of ['changes','success','taskTurn','callId'])if(incoming[key]!==undefined)target[key]=incoming[key];
  mergeText(target, incoming, 'text');
  mergeText(target, incoming, 'summary');
  mergeText(target, incoming, 'details');
  if (incoming.scope && !target.scope) target.scope = incoming.scope;
  if (incoming.continuation_cursor !== undefined) target.continuation_cursor = incoming.continuation_cursor;
  if (target.seq === null && incoming.seq !== null) target.seq = incoming.seq;
  mergeChunk(target, incoming);
}
function finalizeEvent(row) {
  const chunk = row._chunk;
  if (chunk) {
    if (chunk.encoding === 'json') {
      let parsed = null;
      try { parsed = JSON.parse(chunk.text); } catch {}
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const summary = describeDetail(parsed), details = detailsOf(parsed);
        if (summary && !row.summary) row.summary = summary;
        if (details && !row.details) row.details = details;
        row.chunk_complete = true;
      } else {
        row.chunk_complete = false;
        if (!row.details) row.details = clip(chunk.text, MAX_EVENT_DETAILS);
      }
    } else if (!row.text) row.text = clip(chunk.text, MAX_EVENT_TEXT);
  }
  if (row.text) row.text = clip(row.text, MAX_EVENT_TEXT);
  if (row.summary) row.summary = clip(row.summary, MAX_EVENT_SUMMARY);
  if (row.details) row.details = clip(row.details, MAX_EVENT_DETAILS);
  return row;
}
export function mergeDshEvents(previous = [], incoming = [], {limit = MAX_EVENTS} = {}) {
  const rows = new Map();
  for (const event of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const row = event?._normalized ? event : normalizeEvent(event); if (!row) continue;
    const key = row.event_id || row.seq !== null ? JSON.stringify([row.event_id, row.seq, row.type]) : null;
    if (key && rows.has(key)) mergeEventRow(rows.get(key), row);
    else if (key) rows.set(key, row);
    else rows.set(Symbol('event'), row);
  }
  return [...rows.values()].map(finalizeEvent).slice(-Math.min(1000,Math.max(MAX_EVENTS,limit)));
}
export function dshListSnapshot(result) {
  const payload = resultPayload(result, row => listRows(row) !== null);
  if (!payload) return { available: false, items: [], count: 0, matched: 0, total: 0, omitted: null };
  const items = (listRows(payload) || []).slice(0, 500).map(row => {
    if (!row || typeof row !== 'object' || !row.agent_id) return null;
    return {
      agent_id: text(row.agent_id, 200),
      ...dshModelMetadata(row),
      name: row.name === undefined || row.name === null ? '' : text(row.name, 300),
      cwd: row.cwd === undefined || row.cwd === null ? '' : text(row.cwd, 4000),
      status: row.status === undefined || row.status === null ? '' : text(row.status, 120),
      updated_at: row.updated_at === undefined || row.updated_at === null ? '' : text(row.updated_at, 200),
      created_at: row.created_at === undefined || row.created_at === null ? '' : text(row.created_at, 200),
      started_at: row.started_at === undefined || row.started_at === null ? '' : text(row.started_at, 200),
      progress: row.progress === undefined || row.progress === null ? '' : text(row.progress, 4000),
      last_event: row.last_event === undefined || row.last_event === null ? '' : text(row.last_event, 4000),
      finish_reason: row.finish_reason === undefined || row.finish_reason === null ? '' : text(row.finish_reason, 4000),
      error: row.error === undefined || row.error === null ? '' : text(row.error, 4000),
      context_tokens: Number.isFinite(Number(row.context_tokens)) ? Number(row.context_tokens) : row.context_tokens === undefined || row.context_tokens === null ? null : text(row.context_tokens, 120),
      context_limit_tokens: Number.isFinite(Number(row.context_limit_tokens)) ? Number(row.context_limit_tokens) : row.context_limit_tokens === undefined || row.context_limit_tokens === null ? null : text(row.context_limit_tokens, 120),
    };
  }).filter(Boolean);
  return {
    available: true,
    items,
    count: Number.isFinite(Number(payload.count)) ? Number(payload.count) : items.length,
    matched: Number.isFinite(Number(payload.matched)) ? Number(payload.matched) : items.length,
    total: Number.isFinite(Number(payload.total)) ? Number(payload.total) : items.length,
    omitted: payload.omitted ?? null,
  };
}
/** Keep only rows attributed to this Codex thread, and whitelist their fields. */
export function dshFilterListResult(result, allowedIds) {
  const payload = resultPayload(result, row => listRows(row) !== null);
  if (!payload) return null;
  const allowed = allowedIds instanceof Set ? allowedIds : new Set(Array.isArray(allowedIds) ? allowedIds : []);
  const projection = dshListSnapshot(result);
  const items = projection.items.filter(row => allowed.has(row.agent_id));
  const out = {
    count: items.length,
    matched: items.length,
    total: Number.isFinite(Number(payload.total)) ? Number(payload.total) : items.length,
    ...(payload.omitted === undefined || payload.omitted === null ? {} : { omitted: payload.omitted }),
    items,
  };
  const encoded = JSON.stringify(out);
  return { content: [{ type: 'text', text: encoded }], structuredContent: out };
}
export function dshEventsSnapshot(result, { after = 0, retainChanges = false } = {}) {
  const payload = resultPayload(result, row => Array.isArray(row.events) || row.next_cursor !== undefined || row.nextCursor !== undefined || row.has_more !== undefined);
  if (!payload) return { available: false, agent_id: '', events: [], next_cursor: after ?? 0, has_more: false, final_text: '', final_event_id: null, last_event: '' };
  const events = mergeDshEvents([], Array.isArray(payload.events) ? payload.events : [],{limit:retainChanges?1000:MAX_EVENTS});
  // A continuation page starts mid-event. The bridge's continuation_cursor marks the end
  // of the returned chunk; the request's after cursor marks where this chunk starts.
  const startOffset = continuationOffset(after) ?? (typeof after === 'number' && Number.isSafeInteger(after) && after >= 0 ? 0 : null);
  const cursorEvent = typeof after === 'string' ? after.split(':')[0] : null;
  const continuationEvent = events.find(event => event.continuation_cursor !== undefined && (!cursorEvent || String(event.event_id) === cursorEvent));
  if (startOffset !== null && continuationEvent) defineInternal(continuationEvent, 'chunk_start', startOffset);
  const rawCursor = payload.next_cursor ?? payload.nextCursor ?? payload.continuation_cursor;
  const nextCursor = rawCursor !== undefined && rawCursor !== null && rawCursor !== ''
    ? rawCursor
    : events.at(-1)?.continuation_cursor ?? events.at(-1)?.event_id ?? after ?? 0;
  const final = lastFinalEvent(events);
  return {
    available: true,
    agent_id: payload.agent_id === undefined || payload.agent_id === null ? '' : text(payload.agent_id, 200),
    events,
    next_cursor: nextCursor,
    has_more: payload.has_more === true || payload.hasMore === true,
    final_text: final?.text || '',
    final_event_id: final?.event_id ?? null,
    last_event: events.at(-1)?.type || '',
  };
}
export function dshStatusSnapshot(result) {
  const payload = resultPayload(result, row => row.status !== undefined && !Array.isArray(row.items) && !Array.isArray(row.events));
  if (!payload) return { available: false, agent_id: '', status: '', name: '', cwd: '', updated_at: '', created_at: '', started_at: '', progress: '', last_event: '', finish_reason: '', error: '', context_tokens: null, context_limit_tokens: null, answer: '', partial_text: '', last_completed_answer: '', wait_outcome: '', next_action: '' };
  const status = payload.status === undefined || payload.status === null ? '' : text(payload.status, 120);
  const completed = String(status).toLowerCase() === 'completed';
  const exhausted = String(status).toLowerCase() === 'context_exhausted';
  return {
    available: true,
    agent_id: payload.agent_id === undefined || payload.agent_id === null ? '' : text(payload.agent_id, 200),
    ...dshModelMetadata(payload),
    status,
    name: payload.name === undefined || payload.name === null ? '' : text(payload.name, 300),
    cwd: payload.cwd === undefined || payload.cwd === null ? '' : text(payload.cwd, 4000),
    updated_at: payload.updated_at === undefined || payload.updated_at === null ? '' : text(payload.updated_at, 200),
    created_at: payload.created_at === undefined || payload.created_at === null ? '' : text(payload.created_at, 200),
    started_at: payload.started_at === undefined || payload.started_at === null ? '' : text(payload.started_at, 200),
    progress: payload.progress === undefined || payload.progress === null ? '' : text(payload.progress, 4000),
    last_event: payload.last_event === undefined || payload.last_event === null ? '' : text(payload.last_event, 4000),
    finish_reason: payload.finish_reason === undefined || payload.finish_reason === null ? '' : text(payload.finish_reason, 4000),
    error: payload.error === undefined || payload.error === null ? '' : text(payload.error, 4000),
    context_tokens: Number.isFinite(Number(payload.context_tokens)) ? Number(payload.context_tokens) : payload.context_tokens === undefined || payload.context_tokens === null ? null : text(payload.context_tokens, 120),
    context_limit_tokens: Number.isFinite(Number(payload.context_limit_tokens)) ? Number(payload.context_limit_tokens) : payload.context_limit_tokens === undefined || payload.context_limit_tokens === null ? null : text(payload.context_limit_tokens, 120),
    answer: completed && payload.answer !== undefined && payload.answer !== null ? text(payload.answer, MAX_TEXT) : '',
    last_completed_answer: exhausted && payload.last_completed_answer !== undefined && payload.last_completed_answer !== null ? text(payload.last_completed_answer, MAX_TEXT) : '',
    partial_text: payload.partial_text === undefined || payload.partial_text === null ? '' : text(payload.partial_text, MAX_TEXT),
    wait_outcome: payload.wait_outcome === undefined || payload.wait_outcome === null ? '' : text(payload.wait_outcome, 80),
    next_action: payload.next_action === undefined || payload.next_action === null ? '' : text(payload.next_action, 120),
  };
}

/** Legacy status has more fields than the UI needs; keep only whitelisted display data. */
export function dshSafeStatusResult(result) {
  const projection = dshStatusSnapshot(result);
  if (!projection.available) return null;
  const out = { ...projection };
  const encoded = JSON.stringify(out);
  return { content: [{ type: 'text', text: encoded }], structuredContent: out };
}

function clearFinal(task, update = {}) {
  task.answer = update.answer ?? '';
  task.finish_reason = update.finish_reason ?? '';
  task.error = update.error ?? '';
  task.partial_text = update.partial_text ?? '';
  task.last_completed_answer = update.last_completed_answer ?? '';
  task.wait_outcome = update.wait_outcome ?? '';
  task.next_action = update.next_action ?? '';
  task.eventSummary = update.eventSummary ?? '';
  task.finalText = update.finalText ?? '';
  task.finalEventId = update.finalEventId ?? null;
  task.finalClearedAt = new Date().toISOString();
}
function hasFinal(task) { return !!(task?.answer || task?.finish_reason || task?.error || task?.partial_text || task?.finalText || task?.last_completed_answer); }
function snapshotIsOlder(previous, next) {
  if (!previous || !next) return false;
  const left = Date.parse(previous), right = Date.parse(next);
  if (Number.isNaN(left) || Number.isNaN(right)) return String(next) < String(previous);
  return right < left;
}
function isWindowsAbsolute(value) { return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value); }
function pathWithin(child, root) {
  if (!child || !root) return true;
  const normalize = value => String(value).replace(/\\/g, '/').replace(/\/+$/, '');
  const left = normalize(child), right = normalize(root);
  const fold = isWindowsAbsolute(String(child)) || isWindowsAbsolute(String(root));
  const a = fold ? left.toLowerCase() : left, b = fold ? right.toLowerCase() : right;
  return a === b || a.startsWith(b + '/');
}
const positiveMs = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
function timeMs(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? numeric * (Math.abs(numeric) < 1e11 ? 1000 : 1) : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function runCallRejected(item, row) {
  return !!item.error || item.result?.isError === true || !!dshResultError(item.result) ||
    ['failed','declined','rejected','cancelled','canceled'].includes(String(item.status || '').toLowerCase()) ||
    item.accepted === false || item.result?.accepted === false || row?.accepted === false;
}
function runDispatchTime(item) {
  const started = positiveMs(item._startedAtMs);
  if (started !== null) return { at: started, source: 'dispatch_started_at' };
  const completed = positiveMs(item._completedAtMs);
  if (completed !== null) return { at: completed, source: 'dispatch_completed_at' };
  return null;
}
/** Bind a run start only to known, accepted parent dispatch calls. Never invents Date.now(). */
function applyRunStart(task, item, row, update, agentId) {
  if (!agentId || !['dsh_start','dsh_followup','dsh_send'].includes(item.tool)) return;
  const seen = Array.isArray(task.runStartCallIds) ? task.runStartCallIds : task.runStartedAtCallId ? [task.runStartedAtCallId] : [];
  if (seen.includes(item.id) || runCallRejected(item, row)) return;
  const dispatch = runDispatchTime(item);
  if (item.tool === 'dsh_start' && task.runStartedFromFollowup) return;
  if (dispatch && positiveMs(task.runStartedAtMs) !== null && dispatch.at < task.runStartedAtMs) return;
  const calls = [...seen, item.id].slice(-20);
  if (item.tool === 'dsh_start') {
    const created = timeMs(update.created_at);
    const start = created !== null ? { at: created, source: 'created_at' } : dispatch;
    if (!start) return;
    task.runStartedAtMs = start.at; task.runStartedAtSource = start.source;
    task.runStartedAtCallId = item.id; task.runStartedFromFollowup = false; task.runStartCallIds = calls;
    return;
  }
  task.runStartedAtMs = dispatch?.at ?? null; task.runStartedAtSource = dispatch?.source ?? null;
  if (!update.started_at) delete task.started_at;
  task.runStartedAtCallId = item.id; task.runStartedFromFollowup = true; task.runStartCallIds = calls;
}
export class DshTaskStore {
  constructor(limit = 50) { this.limit = limit; this.threadId = null; this.tasks = new Map(); this.calls = new Map(); this.sequence = 0; this.olderSequence = 0; this.listMeta = null; this.owners=new Map();this.editEvidence=new Map();this.editMaxSeq=new Map(); }
  reset(threadId = null) { this.threadId = threadId; this.tasks.clear(); this.calls.clear(); this.sequence = 0; this.olderSequence = 0; this.listMeta = null; this.owners.clear();this.editEvidence.clear();this.editMaxSeq.clear(); }
  ingest(threadId, item, { older = false, source = 'Codex MCP 事件' } = {}) {
    if (threadId !== this.threadId || !isDshItem(item) || !item.id) return false;
    // List rows are discovery metadata for a cwd, not proof that those agents belong to
    // this Codex thread. Live list ingestion has its own attributed path (ingestLiveList).
    if (item.tool === 'dsh_list') return false;
    const args = object(item.arguments) || {}; const rows = payloads(item.result);
    const candidates = rows.length ? rows : [{}];
    for (const row of candidates) {
      const update = extract(row, args, { allowIdAlias: ['dsh_start','dsh_followup','dsh_status','dsh_wait','dsh_result','dsh_attach'].includes(item.tool) });
      // Legacy full status may carry the current assistant message while still running.
      if (item.tool === 'dsh_status' && String(update.status || '').toLowerCase() !== 'completed') delete update.answer;
      if (!older && item.tool === 'dsh_status') {
        const knownKey = update.agentId || this.calls.get(item.id);
        const known = knownKey ? this.tasks.get(knownKey) : null;
        if (known?.updated_at && update.updated_at && snapshotIsOlder(known.updated_at, update.updated_at)) {
          for (const field of ['status','progress','last_event','updated_at','finish_reason','error','context_tokens','context_limit_tokens']) delete update[field];
        }
      }
      const provisional = `call:${item.id}`; const key = update.agentId || this.calls.get(item.id) || provisional;
      if (update.agentId && this.tasks.has(provisional)) { const old = this.tasks.get(provisional); this.tasks.delete(provisional); if (!this.tasks.has(key)) this.tasks.set(key, old); }
      const previous = this.tasks.get(key) || {}; if (!update.agentId && previous.agentId) update.agentId = previous.agentId;
      this.trackDelegation(update.agentId,item,row,{older});
      if(update.agentId&&Array.isArray(row.events))this.ingestChanges(threadId,update.agentId,row.events,{hasMore:row.has_more});
      if (older && this.tasks.has(key)) continue;
      const task = { ...previous, ...update, key, threadId, source: text(source, 120), tool: text(item.tool, 100), callState: text(item.status || 'inProgress', 80), lastCallId: item.id };
      applyRunStart(task, item, row, update, update.agentId || this.calls.get(item.id));
      // A returned MCP envelope being completed says nothing about the child lifecycle.
      if (!update.status && !previous.status) delete task.status;
      if (['starting','running'].includes(update.status) && (['dsh_start','dsh_followup','dsh_send'].includes(item.tool) || !['starting','running','interrupting'].includes(previous.status))) clearFinal(task, update);
      if (item.error) task.callError = text(item.error, 4000);
      else if (item.result?.isError) task.callError = text(item.result.content?.find(c => c.type === 'text')?.text || 'MCP 返回错误', 4000);
      else if (item.status === 'completed') task.callError = '';
      // assistant/final is real DSH output, but it only becomes the final answer of a completed task.
      if (update.finalText) { task.finalText = update.finalText; task.finalEventId = update.finalEventId ?? null; task.finalEventSeq = update.finalEventSeq ?? null; }
      if (task.status === 'completed' && task.finalText && !task.answer) task.answer = task.finalText;
      if (task.status === 'completed' && previous.finalText && !task.answer) task.answer = previous.finalText;
      task.order = older ? --this.olderSequence : ++this.sequence; this.tasks.set(key, task); this.calls.set(item.id, key);
    }
    if (new Set(rows.map(row => row.agent_id).filter(Boolean)).size > 1) this.calls.delete(item.id);
    this.trim(); return true;
  }
  /**
   * Automatic list projection. A dsh_list snapshot is discovery/status evidence, never a
   * completed MCP call for an individual child. It deliberately does not create answers.
   */
  ingestLiveList(threadId, snapshot, { checkedAt = null, source = 'DSH 当前目录自动列表', cwd = null } = {}) {
    if (threadId !== this.threadId || !snapshot || !Array.isArray(snapshot.items)) return false;
    const checked = checkedAt || new Date().toISOString();
    this.listMeta = { checkedAt: checked, count: snapshot.count ?? snapshot.items.length, matched: snapshot.matched ?? snapshot.items.length, total: snapshot.total ?? snapshot.items.length, omitted: snapshot.omitted ?? null };
    let changed = false;
    for (const row of snapshot.items.slice(0, 500)) {
      const agentId = text(row?.agent_id, 200); if (!agentId) continue;
      if (cwd && row.cwd && !pathWithin(row.cwd, cwd)) continue;
      const previous = this.tasks.get(agentId) || null;
      const update = { agentId, key: agentId, threadId, updated_at: row.updated_at === undefined || row.updated_at === null ? previous?.updated_at : text(row.updated_at, 200) };
      Object.assign(update,dshModelMetadata(row));
      for (const field of ['name','cwd','status','progress','last_event','finish_reason','error','context_tokens','context_limit_tokens','created_at','started_at']) if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
        if (field === 'context_tokens' || field === 'context_limit_tokens') { const numeric = Number(row[field]); update[field] = Number.isFinite(numeric) ? numeric : text(row[field], 120); }
        else update[field] = text(row[field], 4000);
      }
      if (!update.status && previous?.status) update.status = previous.status;
      if (previous?.updated_at && update.updated_at && snapshotIsOlder(previous.updated_at, update.updated_at)) {
        for (const field of ['status','progress','last_event','updated_at','finish_reason','error','context_tokens','context_limit_tokens']) delete update[field];
        update.updated_at = previous.updated_at;
      }
      const meaningful = !previous || ['name','cwd','status','progress','last_event','finish_reason','error','context_tokens','created_at','started_at','updated_at'].some(field => (update[field] ?? '') !== (previous[field] ?? ''));
      const task = {
        ...(previous || {}), ...update, source: previous?.source || text(source, 120), tool: previous?.tool || 'dsh_list',
        callState: previous?.callState || 'snapshot', listCheckedAt: checked, listedAt: checked,
        liveSource: text(source, 120),
      };
      // Auto snapshots cannot claim a completed call or a final answer. A genuine active
      // lifecycle does invalidate any old final display while preserving the event cursor.
      delete task.callCompletedByList;
      if (isActiveStatus(task.status) && hasFinal(previous)) clearFinal(task, update);
      if (task.status === 'completed' && previous?.finalText && !task.answer) task.answer = previous.finalText;
      if (meaningful) task.order = ++this.sequence; else if (!previous) task.order = ++this.sequence;
      this.tasks.set(agentId, task);
      if (meaningful || !previous) changed = true;
    }
    this.trim(); return changed;
  }
  /** Manual/automatic compact status. Does not infer completion from a returned envelope. */
  ingestLiveStatus(threadId, agentId, status, { checkedAt = null, source = 'DSH 自动状态' } = {}) {
    if (threadId !== this.threadId || !agentId || !status?.status) return false;
    const id = text(agentId, 200); const previous = this.tasks.get(id) || {};
    const update = { agentId: id, key: id, threadId };
    Object.assign(update,dshModelMetadata(status));
    for (const field of ['status','name','cwd','updated_at','created_at','started_at','progress','last_event','finish_reason','error','context_tokens','context_limit_tokens','partial_text','wait_outcome','next_action']) if (status[field] !== undefined && status[field] !== null && status[field] !== '') {
      if (field === 'context_tokens' || field === 'context_limit_tokens') { const numeric = Number(status[field]); update[field] = Number.isFinite(numeric) ? numeric : text(status[field], 120); }
      else update[field] = text(status[field], 4000);
    }
    if (String(status.status).toLowerCase() === 'completed' && status.answer) update.answer = text(status.answer, MAX_TEXT);
    if (String(status.status).toLowerCase() === 'context_exhausted' && status.last_completed_answer) update.last_completed_answer = text(status.last_completed_answer, MAX_TEXT);
    if (previous.updated_at && update.updated_at && snapshotIsOlder(previous.updated_at, update.updated_at)) {
      for (const field of ['status','progress','last_event','updated_at','finish_reason','error','context_tokens','answer','last_completed_answer']) delete update[field];
      update.updated_at = previous.updated_at;
    }
    const task = { ...previous, ...update, source: previous.source || text(source, 120), tool: previous.tool || 'dsh_status', callState: previous.callState || 'snapshot', statusCheckedAt: checkedAt || new Date().toISOString(), liveSource: text(source, 120) };
    if (isActiveStatus(task.status) && hasFinal(previous)) clearFinal(task, update);
    if (task.status === 'completed' && !task.answer && (update.answer || previous.finalText)) task.answer = update.answer || previous.finalText;
    task.order = previous.order || ++this.sequence;
    this.tasks.set(id, task); this.trim(); return true;
  }
  /** Events are evidence only. They never set the task status or a successful answer. */
  ingestLiveEvents(threadId, agentId, events, { checkedAt = null, cursor = undefined, hasMore = false, syncingHistory = false, source = 'DSH 自动事件' } = {}) {
    if (threadId !== this.threadId || !agentId) return false;
    const id = text(agentId, 200); const previous = this.tasks.get(id) || {};
    this.ingestChanges(threadId,agentId,events,{hasMore});
    const merged = mergeDshEvents(previous.liveEvents, events);
    const final = lastFinalEvent(merged);
    const task = {
      ...previous, agentId: id, key: id, threadId, liveEvents: merged, eventCursor: cursor ?? previous.eventCursor ?? 0,
      eventsHasMore: !!hasMore, syncingHistory: !!syncingHistory, eventsCheckedAt: checkedAt || new Date().toISOString(),
      source: previous.source || text(source, 120), tool: previous.tool || 'dsh_events', callState: previous.callState || 'snapshot',
      liveSource: text(source, 120),
    };
    if (final?.text) { task.finalText = final.text; task.finalEventId = final.event_id ?? null; task.finalEventSeq = final.seq ?? null; }
    const meaningful = merged.filter(event => event.text || event.summary || event.details);
    if (meaningful.length) task.eventSummary = text(meaningful.slice(-5).map(eventLine).join('\n'), 16000);
    if (task.status === 'completed' && task.finalText && !task.answer) task.answer = task.finalText;
    if (!previous.agentId) task.order = ++this.sequence;
    this.tasks.set(id, task); this.trim(); return true;
  }
  trackDelegation(agentId,item,result,{older=false}={}) {
    if(!agentId||!item._turnId||!['dsh_start','dsh_followup','dsh_send'].includes(item.tool))return;
    const owners=this.owners.get(agentId)||[];
    if(owners.some(owner=>owner.callId===item.id))return;
    const previous=this.tasks.get(agentId);
    const boundary=!older&&item.status!=='completed'&&previous?.changesCaughtUp&&isDshTerminalStatus(previous.status)?this.editMaxSeq.get(agentId):null;
    const explicitTurn=Number(result?.taskTurn??result?.turn);
    const owner={callId:item.id,turnId:item._turnId,isStart:item.tool==='dsh_start',
      taskTurn:item.tool==='dsh_start'?1:Number.isSafeInteger(explicitTurn)&&explicitTurn>0?explicitTurn:null,
      afterSeq:Number.isSafeInteger(boundary)?boundary:null,beforeSeq:null,closed:false};
    if(owner.isStart&&owners.length){owner.closed=true;owner.beforeSeq=owners[0].afterSeq;owners.unshift(owner);}
    else {if(owners.length){owners.at(-1).closed=true;owners.at(-1).beforeSeq=owner.afterSeq;}owners.push(owner);}
    this.owners.set(agentId,owners);
  }
  ingestChanges(threadId,agentId,events,{hasMore}={}) {
    if(threadId!==this.threadId||!agentId||!Array.isArray(events))return false;
    let changed=false;
    const task=this.tasks.get(agentId);
    if(task&&typeof hasMore==='boolean')task.changesCaughtUp=!hasMore;
    for(const event of events){
      const edit=projectDelegatedEdit(event);if(!edit)continue;
      if(edit.seq!==null)this.editMaxSeq.set(agentId,Math.max(this.editMaxSeq.get(agentId)??-1,edit.seq));
      const eventId=event.event_id??edit.seq;
      if(eventId===null||eventId===undefined)continue;
      const key=`${agentId}:${eventId}`;
      if(event.success===false){changed=this.editEvidence.delete(key)||changed;continue;}
      if(!edit.success||!edit.changes.length)continue;
      const evidence={...edit,agentId,eventId:String(eventId)};
      if(JSON.stringify(this.editEvidence.get(key))===JSON.stringify(evidence))continue;
      this.editEvidence.set(key,evidence);changed=true;
    }
    return changed;
  }
  delegatedChanges({turns=[],activeTurnId=null,now=Date.now()}={}) {
    const result=[];
    for(const evidence of this.editEvidence.values()){
      const owners=this.owners.get(evidence.agentId)||[];
      let owner=null;
      if(evidence.taskTurn){const matching=owners.filter(value=>value.taskTurn===evidence.taskTurn);if(matching.length===1)owner=matching[0];}
      if(!owner&&evidence.seq!==null){
        owner=[...owners].reverse().find(value=>(value.isStart||value.afterSeq!==null&&evidence.seq>value.afterSeq)&&(!value.closed||value.beforeSeq!==null&&evidence.seq<=value.beforeSeq));
      }
      // Recent-item paging can omit the spawn call. Only task turn 1 may use a unique
      // native parent-turn time window; observed UI times are deliberately excluded.
      if(!owner&&evidence.taskTurn===1){
        const created=this.tasks.get(evidence.agentId)?.created_at;
        const numeric=created!==null&&created!==undefined&&created!==''?Number(created):NaN;
        const createdMs=Number.isFinite(numeric)?numeric*(Math.abs(numeric)<1e11?1000:1):Date.parse(created||'');
        if(Number.isFinite(createdMs)){
          const matching=turns.filter(turn=>{
            const meta=turn.meta||turn,id=turn.id||meta.id;
            const start=meta.startedAtMs;
            const active=id===activeTurnId||turn.status==='running';
            const end=active?now:meta.completedAtMs;
            return Number.isFinite(start)&&Number.isFinite(end)&&end>=start&&createdMs>=start&&createdMs<=end;
          });
          if(matching.length===1)owner={turnId:matching[0].id||matching[0].meta?.id};
        }
      }
      if(!owner)continue;
      result.push({...evidence,turnId:owner.turnId,cwd:this.tasks.get(evidence.agentId)?.cwd||''});
    }
    return result;
  }
  progress(threadId, itemId, message) {
    if (threadId !== this.threadId) return false;
    const key = this.calls.get(itemId); const task = key && this.tasks.get(key); if (!task) return false;
    task.mcpProgress = text(message, 4000); task.order = ++this.sequence; this.trim(); return true;
  }
  trim() {
    while (this.tasks.size > this.limit) { const oldest = [...this.tasks.values()].sort((a,b) => a.order - b.order)[0]; this.tasks.delete(oldest.key); }
    for (const [call, key] of this.calls) if (!this.tasks.has(key)) this.calls.delete(call);
    while (this.calls.size > 200) this.calls.delete(this.calls.keys().next().value);
  }
  values() { return [...this.tasks.values()].sort((a,b) => b.order - a.order); }
}
