// DSH subagent panel: MCP connection summary, live task cards, read-only status reads.
// Read-only by design: nothing here creates, continues, stops or retries an agent, and an MCP
// call returning is never shown as task completion.
import { boundedText } from '../store.js';
import { dshConnectionSummary, dshStatusLabel, dshRuntimeStatusLabel, dshEventsSnapshot, dshStatusSnapshot } from '../dsh.js';
import { createAgentInspector } from './agent-inspector.js';

/**
 * @param {object} deps
 * @param {object} deps.state       shared session state (thread, connected, dsh* fields)
 * @param {(id:string)=>HTMLElement} deps.$  element lookup
 * @param {object} deps.dshLive     DshLiveMonitor instance
 * @param {object} deps.dshTasks    DshTaskStore instance
 * @param {Function} deps.api       authenticated HTTP call
 * @param {Function} deps.rpc       authenticated RPC call
 * @param {Function} deps.el        element factory
 */
export function createDshView({ document, state, $, dshLive, dshTasks, api, rpc, el }) {
  function renderDshConnection() {
    const c = state.dshConnection;
    const label = state.dshRefreshing ? '正在读取 MCP 状态…' : c ? `${!state.connected ? '上次检查：' : ''}${c.label}` : '尚未检查 DSH 连接';
    const detail = c ? `${c.scope} · ${c.checkedAt || ''}\n${(c.servers || []).map(server => `${server.name} · 会话：${!c.sessionScoped && !server.runtimeStatus ? '尚未检查' : dshRuntimeStatusLabel(server.runtimeStatus)} · 身份验证：${server.authStatus || '未提供'} · 工具目录：${server.toolCount} 项（可能来自缓存）`).join('\n')}\n以上仅是工具目录及已提供的会话状态，不代表 DeepSeek 推理已成功。${c.partial ? '\n列表尚有后续页，这不是完整服务器清单。' : ''}` : '只读取 MCP 连接状态，不发起任务或模型请求。';
    for (const id of ['dsh-status-label','dsh-settings-label']) $(id).textContent = label;
    for (const id of ['dsh-status-details','dsh-settings-details']) $(id).textContent = detail;
    for (const id of ['refresh-dsh','refresh-dsh-settings']) $(id).disabled = state.dshRefreshing || !state.connected;
  }
  async function refreshDsh() {
    if (state.dshRefreshing || !state.connected) return;
    state.dshRefreshing = true; renderDshConnection(); const generation = state.openGeneration; const threadId = state.thread?.id;
    try {
      let scope = threadId ? '当前对话' : '全局 MCP 配置'; let result; let scopedThread = threadId;
      try { result = await rpc('mcpServerStatus/list', { limit: 100, ...(threadId ? { threadId } : {}) }); }
      catch (e) {
        // Only older protocols rejecting the threadId field may fall back to global status.
        if (!threadId || e.code !== -32602 || !/threadId|thread_id|unknown field|unrecognized field/i.test(e.message)) throw e;
        result = await rpc('mcpServerStatus/list', { limit: 100 }); scopedThread = null; scope = '全局 MCP 配置（旧 CLI 不支持当前对话范围）';
      }
      const rows = [...(result.data || [])]; const cursors = new Set(); let pages = 1;
      while (result.nextCursor && pages < 5 && !dshConnectionSummary(rows).servers.length) {
        if (generation !== state.openGeneration) return;
        if (cursors.has(result.nextCursor)) break; cursors.add(result.nextCursor);
        result = await rpc('mcpServerStatus/list', { limit: 100, cursor: result.nextCursor, ...(scopedThread ? { threadId: scopedThread } : {}) });
        rows.push(...(result.data || [])); pages++;
      }
      if (generation !== state.openGeneration) return;
      const summary = dshConnectionSummary(rows.slice(0, 500), scope, {sessionScoped:!!scopedThread}); const partial = !!result.nextCursor;
      if (!summary.servers.length && partial) summary.label = '已读取的列表中未见 DSH（清单未完整）';
      state.dshConnection = { ...summary, checkedAt: new Date().toLocaleTimeString('zh-CN'), partial };
    } catch (e) { if (generation === state.openGeneration) state.dshConnection = { label: '无法读取 DSH 连接状态', scope: e.message, servers: [] }; }
    finally { state.dshRefreshing = false; renderDshConnection(); }
  }
  let dshRenderTimer = null;
  function dshPanelVisible() {
    return !$('details').classList.contains('hidden') && !$('dsh-panel').classList.contains('hidden') && document.visibilityState !== 'hidden';
  }
  function syncDshLiveContext() {
    dshLive.setContext({
      threadId: state.thread?.id || null,
      connected: state.connected,
      visible: document.visibilityState !== 'hidden' && !$('chat-page').classList.contains('hidden'),
      serverInstance: state.serverInstance,
    });
    if (dshPanelVisible()) renderDshLiveMeta();
  }
  function scheduleDshRender() {
    if (dshRenderTimer !== null) return;
    dshRenderTimer = setTimeout(() => {
      dshRenderTimer = null;
      if (dshPanelVisible()) renderDshTasks();
    }, 32);
  }
  function formatDshTime(value) {
    if (value === undefined || value === null || value === '') return '未提供';
    let date;
    if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
      let stamp = Number(value); if (!Number.isFinite(stamp)) return boundedText(value, 120);
      if (Math.abs(stamp) < 100000000000) stamp *= 1000;
      date = new Date(stamp);
    } else date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? boundedText(value, 120) : date.toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });
  }
  function hasDshOmission(value) {
    if (value === null || value === undefined || value === false || value === 0 || value === '0' || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }
  function renderDshLiveMeta(snapshot = dshLive.snapshot()) {
    if (!$('dsh-live-state')) return;
    const stateLabel = !snapshot.context.threadId ? '等待对话'
      : !snapshot.context.connected ? '自动刷新暂停：未连接'
        : !snapshot.context.visible ? '自动刷新暂停：不可见'
          : snapshot.list.loading ? '正在刷新…'
            : snapshot.list.nextRetryAt ? '等待重试'
              : '当前对话 · 自动刷新';
    $('dsh-live-state').textContent = stateLabel;
    $('dsh-live-state').classList.toggle('paused', !snapshot.actionable || !!snapshot.list.nextRetryAt);
    const parts = [];
    if (!snapshot.context.threadId) {
      parts.push('打开对话后查看子代理');
    } else {
      parts.push(`最后检查：${snapshot.list.checkedAt ? formatDshTime(snapshot.list.checkedAt) : '尚未检查'}`);
      if (snapshot.list.cwd) parts.push(`目录：${boundedText(snapshot.list.cwd, 4000)}`);
      parts.push(`匹配 ${snapshot.list.matched} / 返回 ${snapshot.list.count} / 总 ${snapshot.list.total}`);
      if (snapshot.list.error) parts.push('上次读取失败，旧列表可能已过时');
      if (snapshot.list.nextRetryAt) parts.push(`下次自动重试：${formatDshTime(snapshot.list.nextRetryAt)}`);
      if (snapshot.pauseReason) parts.push(snapshot.pauseReason);
      if (snapshot.selectedAgentId) parts.push(`正在查看：${snapshot.selectedAgentId}`);
    }
    $('dsh-live-meta').textContent = parts.join(' · ');
    const warnings = [];
    if (hasDshOmission(snapshot.list.omitted)) warnings.push('列表提示可能有遗漏：' + boundedText(snapshot.list.omitted, 500));
    if (snapshot.list.error) warnings.push(/thread not found/i.test(snapshot.list.error) ? '子代理暂时无法刷新：当前后端未载入对应会话。' : '子代理刷新失败：' + boundedText(snapshot.list.error, 220));
    const warning = warnings.join('\n');
    $('dsh-live-warning').textContent = warning;
    $('dsh-live-warning').title = snapshot.list.error || warning;
    $('dsh-live-warning').classList.toggle('hidden', !warning);
    $('dsh-live-refresh').disabled = !snapshot.actionable;
    $('dsh-live-refresh').title = snapshot.actionable ? '刷新子代理' : snapshot.pauseReason || '自动刷新已暂停';
  }
  const inspector=createAgentInspector({document,state,host:$('dsh-tasks'),dshTasks,dshLive,rpc,readDshTask,el});
  $('dsh-live-refresh').addEventListener('click',()=>inspector.refresh());
  function renderDshTasks(){renderDshLiveMeta();inspector.render();}
  function openAgent(id,kind){return inspector.open(id,kind);}
  function ingestDshSnapshot(snapshot) {
    if (snapshot?.threadId !== state.thread?.id || !snapshot.agentId || !['dsh_status','dsh_result','dsh_events'].includes(snapshot.tool)) return false;
    let changed = false;
    if (snapshot.tool === 'dsh_events') {
      const projection = dshEventsSnapshot(snapshot.result);
      if (projection.available) changed = dshTasks.ingestLiveEvents(snapshot.threadId, snapshot.agentId, projection.events, {
        checkedAt: snapshot.checkedAt, cursor: projection.next_cursor, hasMore: projection.has_more,
        syncingHistory: projection.has_more, source: 'DSH 只读事件（bridge 广播）',
      });
    } else if (snapshot.tool === 'dsh_status') {
      const projection = dshStatusSnapshot(snapshot.result);
      if (projection.available) changed = dshTasks.ingestLiveStatus(snapshot.threadId, snapshot.agentId, projection, {
        checkedAt: snapshot.checkedAt, source: 'DSH 只读状态（bridge 广播）',
      });
    }
    if (!changed) {
      const item = { id: snapshot.itemId || `manual-dsh-${++state.dshReadSequence}`, type: 'mcpToolCall', server: 'dsh_subagent', tool: snapshot.tool, arguments: { agent_id: snapshot.agentId }, result: snapshot.result, status: 'completed' };
      changed = dshTasks.ingest(snapshot.threadId, item, { source: snapshot.tool === 'dsh_result' ? '历史 DSH 结果快照（未发起新任务）' : 'DSH 只读快照（bridge 广播）' });
    }
    if (changed) renderDshTasks(); return changed;
  }
  async function readDshTask(agentId, kind = 'status') {
    if (kind !== 'status') return;
    const threadId = state.thread?.id; if (!threadId || !state.connected) return;
    const key = `${threadId}:${agentId}`; if (state.dshReads.has(key)) return;
    const generation = state.openGeneration; const readGeneration = state.dshReadGeneration;
    state.dshReads.set(key, kind); state.dshReadErrors.delete(key); renderDshTasks();
    try {
      const snapshot = await api('/api/dsh/read', { threadId, agentId, kind: 'status' });
      if (generation === state.openGeneration && readGeneration === state.dshReadGeneration && state.thread?.id === threadId) ingestDshSnapshot(snapshot);
    } catch (error) { if (generation === state.openGeneration && readGeneration === state.dshReadGeneration) state.dshReadErrors.set(key, error.message + '。没有改用模型查询，也没有重新创建任务。'); }
    finally { state.dshReads.delete(key); if (generation === state.openGeneration && readGeneration === state.dshReadGeneration) renderDshTasks(); }
  }

  return { renderDshConnection, refreshDsh, syncDshLiveContext, scheduleDshRender, renderDshTasks, ingestDshSnapshot, readDshTask, openAgent };
}
