// Read-only projections of existing Codex -> DSH MCP traffic. No network/model calls.
const FIELDS = ['status','name','cwd','answer','partial_text','last_event','progress','error','finish_reason','updated_at','created_at'];
const MAX_TEXT = 16000;
const MAX_EVENT_TEXT = 8000;
const MAX_EVENT_SUMMARY = 4000;
const MAX_EVENTS = 100;
const ACTIVE_STATUSES = new Set(['starting', 'running', 'interrupting']);
const TERMINAL_STATUSES = new Set(['completed', 'idle', 'error', 'failed', 'cancelled', 'interrupted', 'context_exhausted', 'closed']);
const text = (value, max = MAX_TEXT) => {
  if (value === undefined || value === null) return '';
  let s; try { s = typeof value === 'string' ? value : JSON.stringify(value); } catch { return '[无法显示]'; }
  return s.length > max ? s.slice(0, max) + '\n…〔显示已截断〕' : s;
};
const object = value => {
  if (typeof value === 'string') { if (value.length > 1024 * 1024) return null; try { value = JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
};
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
function payloads(result) {
  const r = object(result); if (!r) return [];
  const candidates = [r.structuredContent];
  for (const block of Array.isArray(r.content) ? r.content.slice(0, 20) : []) if (block?.type === 'text') candidates.push(block.text);
  // Some app-server adapters return the tool's structured result directly.
  candidates.push(r);
  const rows = [];
  for (const candidate of candidates) {
    const root = object(candidate); if (!root) continue;
    for (const value of [root, root.data, root.result, root.agent]) {
      const row = object(value); if (!row) continue;
      if (row.agent_id || row.status || row.answer || row.partial_text || row.finish_reason || Array.isArray(row.events)) rows.push(row);
      for (const entry of Array.isArray(row.items) ? row.items.slice(0, 50) : []) if (object(entry)?.agent_id) rows.push(entry);
    }
  }
  return rows.slice(0, 50);
}
function extract(row, args, { allowIdAlias = false } = {}) {
  const id = row?.agent_id || (allowIdAlias ? row?.id : null) || args?.agent_id;
  const out = { agentId: id ? text(id, 200) : null };
  for (const field of FIELDS) if (row && row[field] !== undefined && row[field] !== null) out[field] = text(row[field], field === 'answer' || field === 'partial_text' ? MAX_TEXT : 4000);
  if (Array.isArray(row?.events) && row.events.length) out.eventSummary = text(row.events.slice(-5).map(e => `${text(e.type, 160)}: ${text(e.text ?? e.summary ?? '', 3000)}`).join('\n'), 16000);
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
  };
  add(root.structuredContent);
  for (const block of Array.isArray(root.content) ? root.content.slice(0, 20) : []) if (block?.type === 'text') add(block.text);
  add(root);
  for (const candidate of roots) if (!candidate.isError && predicate(candidate)) return candidate;
  return null;
}
export function dshResultError(result) {
  const r = object(result); if (!r?.isError) return '';
  const content = Array.isArray(r.content) ? r.content : [];
  return text(content.filter(row => row?.type === 'text').map(row => row.text).join('\n') || r.message || 'DSH 工具返回错误', 4000);
}
function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const eventId = text(event.event_id ?? event.eventId ?? '', 300);
  const seqRaw = event.seq;
  const seq = typeof seqRaw === 'number' ? seqRaw : seqRaw === undefined || seqRaw === null ? null : text(seqRaw, 120);
  const type = text(event.type || event.kind || 'event', 200);
  // Do not surface provider-internal reasoning even if a bridge labels it as an event.
  if (/(?:^|[\/:_-])(?:reasoning|thinking|analysis|chain[_/-]?of[_/-]?thought|internal)(?:[\/:_-]|$)/i.test(type)) return null;
  const summaryValue = event.summary;
  const summary = summaryValue === undefined || summaryValue === null ? '' : text(summaryValue, MAX_EVENT_SUMMARY);
  const eventText = event.text === undefined || event.text === null ? '' : text(event.text, MAX_EVENT_TEXT);
  const continuation = event.continuation_cursor === undefined || event.continuation_cursor === null ? undefined : event.continuation_cursor;
  if (!eventId && seq === null && !eventText && !summary) return null;
  return { event_id: eventId, seq, type, ...(eventText ? { text: eventText } : {}), ...(summary ? { summary } : {}), ...(continuation !== undefined ? { continuation_cursor: continuation } : {}) };
}
export function mergeDshEvents(previous = [], incoming = []) {
  const rows = []; const seen = new Set();
  for (const event of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const row = normalizeEvent(event); if (!row) continue;
    const key = JSON.stringify([row.event_id, row.seq, row.type, row.text || '', row.summary || '', row.continuation_cursor ?? '']);
    if (seen.has(key)) continue;
    seen.add(key); rows.push(row);
  }
  return rows.slice(-MAX_EVENTS);
}
export function dshListSnapshot(result) {
  const payload = resultPayload(result, row => Array.isArray(row.items));
  if (!payload) return { available: false, items: [], count: 0, matched: 0, total: 0, omitted: null };
  const items = payload.items.slice(0, 500).map(row => {
    if (!row || typeof row !== 'object' || !row.agent_id) return null;
    return {
      agent_id: text(row.agent_id, 200),
      name: row.name === undefined || row.name === null ? '' : text(row.name, 300),
      cwd: row.cwd === undefined || row.cwd === null ? '' : text(row.cwd, 4000),
      status: row.status === undefined || row.status === null ? '' : text(row.status, 120),
      updated_at: row.updated_at === undefined || row.updated_at === null ? '' : text(row.updated_at, 200),
      progress: row.progress === undefined || row.progress === null ? '' : text(row.progress, 4000),
      last_event: row.last_event === undefined || row.last_event === null ? '' : text(row.last_event, 4000),
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
export function dshEventsSnapshot(result) {
  const payload = resultPayload(result, row => Array.isArray(row.events) || row.next_cursor !== undefined || row.has_more !== undefined);
  if (!payload) return { available: false, events: [], next_cursor: 0, has_more: false };
  const events = mergeDshEvents([], Array.isArray(payload.events) ? payload.events : []);
  const cursor = payload.next_cursor ?? payload.nextCursor;
  const nextCursor = typeof cursor === 'number' || typeof cursor === 'string' ? cursor : 0;
  return { available: true, events, next_cursor: nextCursor, has_more: payload.has_more === true };
}
export function dshStatusSnapshot(result) {
  const payload = resultPayload(result, row => row.status !== undefined && !Array.isArray(row.items) && !Array.isArray(row.events));
  if (!payload) return { available: false, status: '', name: '', cwd: '', updated_at: '', progress: '', last_event: '' };
  return {
    available: true,
    status: payload.status === undefined || payload.status === null ? '' : text(payload.status, 120),
    name: payload.name === undefined || payload.name === null ? '' : text(payload.name, 300),
    cwd: payload.cwd === undefined || payload.cwd === null ? '' : text(payload.cwd, 4000),
    updated_at: payload.updated_at === undefined || payload.updated_at === null ? '' : text(payload.updated_at, 200),
    progress: payload.progress === undefined || payload.progress === null ? '' : text(payload.progress, 4000),
    last_event: payload.last_event === undefined || payload.last_event === null ? '' : text(payload.last_event, 4000),
  };
}

function clearFinal(task) {
  task.answer = '';
  task.finish_reason = '';
  task.error = '';
  task.partial_text = '';
  task.eventSummary = '';
  task.finalClearedAt = new Date().toISOString();
}
export class DshTaskStore {
  constructor(limit = 50) { this.limit = limit; this.threadId = null; this.tasks = new Map(); this.calls = new Map(); this.sequence = 0; this.olderSequence = 0; this.listMeta = null; }
  reset(threadId = null) { this.threadId = threadId; this.tasks.clear(); this.calls.clear(); this.sequence = 0; this.olderSequence = 0; this.listMeta = null; }
  ingest(threadId, item, { older = false, source = 'Codex MCP 事件' } = {}) {
    if (threadId !== this.threadId || !isDshItem(item) || !item.id) return false;
    const args = object(item.arguments) || {}; const rows = payloads(item.result); const candidates = rows.length ? rows : [{}];
    for (const row of candidates) {
      const update = extract(row, args, { allowIdAlias: ['dsh_start','dsh_followup','dsh_status','dsh_wait','dsh_result','dsh_attach'].includes(item.tool) });
      const provisional = `call:${item.id}`; const key = update.agentId || this.calls.get(item.id) || provisional;
      if (update.agentId && this.tasks.has(provisional)) { const old = this.tasks.get(provisional); this.tasks.delete(provisional); if (!this.tasks.has(key)) this.tasks.set(key, old); }
      const previous = this.tasks.get(key) || {}; if (!update.agentId && previous.agentId) update.agentId = previous.agentId; if (older && this.tasks.has(key)) continue;
      const task = { ...previous, ...update, key, threadId, source: text(source, 120), tool: text(item.tool, 100), callState: text(item.status || 'inProgress', 80), lastCallId: item.id };
      // A returned MCP envelope being completed says nothing about the child lifecycle.
      if (!update.status && !previous.status) delete task.status;
      if (['starting','running'].includes(update.status) && (['dsh_start','dsh_followup','dsh_send'].includes(item.tool) || !['starting','running','interrupting'].includes(previous.status))) { clearFinal(task); task.mcpProgress = ''; }
      if (item.error) task.callError = text(item.error, 4000);
      else if (item.result?.isError) task.callError = text(item.result.content?.find(c => c.type === 'text')?.text || 'MCP 返回错误', 4000);
      else if (item.status === 'completed') task.callError = '';
      task.order = older ? --this.olderSequence : ++this.sequence; this.tasks.set(key, task); this.calls.set(item.id, key);
    }
    if (new Set(rows.map(row => row.agent_id).filter(Boolean)).size > 1) this.calls.delete(item.id);
    this.trim(); return true;
  }
  /**
   * Automatic list projection. A dsh_list snapshot is discovery/status evidence, never a
   * completed MCP call for an individual child. It deliberately does not create answers.
   */
  ingestLiveList(threadId, snapshot, { checkedAt = null, source = 'DSH 当前目录自动列表' } = {}) {
    if (threadId !== this.threadId || !snapshot || !Array.isArray(snapshot.items)) return false;
    const checked = checkedAt || new Date().toISOString();
    this.listMeta = { checkedAt: checked, count: snapshot.count ?? snapshot.items.length, matched: snapshot.matched ?? snapshot.items.length, total: snapshot.total ?? snapshot.items.length, omitted: snapshot.omitted ?? null };
    let changed = false;
    for (const row of snapshot.items.slice(0, 500)) {
      const agentId = text(row?.agent_id, 200); if (!agentId) continue;
      const previous = this.tasks.get(agentId) || null;
      const update = { agentId, key: agentId, threadId, updated_at: row.updated_at === undefined || row.updated_at === null ? previous?.updated_at : text(row.updated_at, 200) };
      for (const field of ['name','cwd','status','progress','last_event']) if (row[field] !== undefined && row[field] !== null && row[field] !== '') update[field] = text(row[field], field === 'cwd' ? 4000 : 4000);
      if (!update.status && previous?.status) update.status = previous.status;
      const meaningful = !previous || ['name','cwd','status','progress','last_event','updated_at'].some(field => (update[field] ?? '') !== (previous[field] ?? ''));
      const task = {
        ...(previous || {}), ...update, source: previous?.source || text(source, 120), tool: previous?.tool || 'dsh_list',
        callState: previous?.callState || 'snapshot', listCheckedAt: checked, listedAt: checked,
        liveSource: text(source, 120),
      };
      // Auto snapshots cannot claim a completed call or a final answer. A genuine active
      // lifecycle does invalidate any old final display while preserving the event cursor.
      delete task.callCompletedByList;
      if (isActiveStatus(task.status) && (previous?.answer || previous?.finish_reason || previous?.error || previous?.partial_text)) clearFinal(task);
      if (meaningful) task.order = ++this.sequence; else if (!previous) task.order = ++this.sequence;
      this.tasks.set(agentId, task);
      if (meaningful || !previous) changed = true;
    }
    this.trim(); return changed;
  }
  /** Manual/automatic compact status. Does not infer completion from a returned envelope. */
  ingestLiveStatus(threadId, agentId, status, { checkedAt = null, source = 'DSH 自动状态' } = {}) {
    if (threadId !== this.threadId || !agentId || !status) return false;
    const id = text(agentId, 200); const previous = this.tasks.get(id) || {};
    const update = { agentId: id, key: id, threadId };
    for (const field of ['status','name','cwd','updated_at','progress','last_event']) if (status[field] !== undefined && status[field] !== null && status[field] !== '') update[field] = text(status[field], field === 'cwd' ? 4000 : 4000);
    const task = { ...previous, ...update, source: previous.source || text(source, 120), tool: previous.tool || 'dsh_status', callState: previous.callState || 'snapshot', statusCheckedAt: checkedAt || new Date().toISOString(), liveSource: text(source, 120) };
    if (isActiveStatus(task.status) && (previous.answer || previous.finish_reason || previous.error || previous.partial_text)) clearFinal(task);
    task.order = previous.order || ++this.sequence;
    this.tasks.set(id, task); this.trim(); return true;
  }
  /** Events are evidence only. They never set the task status or a successful answer. */
  ingestLiveEvents(threadId, agentId, events, { checkedAt = null, cursor = undefined, hasMore = false, syncingHistory = false, source = 'DSH 自动事件' } = {}) {
    if (threadId !== this.threadId || !agentId) return false;
    const id = text(agentId, 200); const previous = this.tasks.get(id) || {};
    const merged = mergeDshEvents(previous.liveEvents, events);
    const task = {
      ...previous, agentId: id, key: id, threadId, liveEvents: merged, eventCursor: cursor ?? previous.eventCursor ?? 0,
      eventsHasMore: !!hasMore, syncingHistory: !!syncingHistory, eventsCheckedAt: checkedAt || new Date().toISOString(),
      source: previous.source || text(source, 120), tool: previous.tool || 'dsh_events', callState: previous.callState || 'snapshot',
      liveSource: text(source, 120),
    };
    if (merged.length) task.eventSummary = merged.slice(-5).map(event => `${event.type || 'event'}: ${event.text || event.summary || ''}`).join('\n').slice(0, 16000);
    if (!previous.agentId) task.order = ++this.sequence;
    this.tasks.set(id, task); this.trim(); return true;
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
