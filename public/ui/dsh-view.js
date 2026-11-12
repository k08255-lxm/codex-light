// DSH subagent panel: MCP connection summary, live task cards, read-only status reads.
// Read-only by design: nothing here creates, continues, stops or retries an agent, and an MCP
// call returning is never shown as task completion.
import { boundedText } from '../store.js';
import { dshConnectionSummary, dshStatusLabel, dshRuntimeStatusLabel, dshEventsSnapshot, dshStatusSnapshot } from '../dsh.js';
import { icon } from '../icons.js';

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
      visible: dshPanelVisible(),
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
          : snapshot.list.loading ? '正在刷新当前目录…'
            : snapshot.list.nextRetryAt ? '自动刷新退避中'
              : '当前目录 · 每 5 秒自动刷新';
    $('dsh-live-state').textContent = stateLabel;
    $('dsh-live-state').classList.toggle('paused', !snapshot.actionable || !!snapshot.list.nextRetryAt);
    const parts = [];
    if (!snapshot.context.threadId) {
      parts.push('请先打开一个已有对话，或开始一个新对话并发送消息；不会自动创建对话，也不会查询其他目录。');
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
    if (snapshot.list.error) warnings.push('自动列表读取失败：' + snapshot.list.error + '。保留上次结果并标记为可能过时；不会改查其他目录。');
    const warning = warnings.join('\n');
    $('dsh-live-warning').textContent = warning;
    $('dsh-live-warning').classList.toggle('hidden', !warning);
    $('dsh-live-refresh').disabled = !snapshot.actionable;
    $('dsh-live-refresh').title = snapshot.actionable ? '立即重试当前目录列表；不会创建或停止任务' : snapshot.pauseReason || '自动刷新已暂停';
  }
  function rememberDshDetails(details, key) {
    details.open = state.dshOpenDetails.has(key);
    details.addEventListener('toggle', () => {
      if (details.open) state.dshOpenDetails.add(key); else state.dshOpenDetails.delete(key);
    });
    return details;
  }
  function renderDshLiveEvents(task, live) {
    const section = el('section', 'dsh-live-progress');
    const head = el('div', 'dsh-live-progress-head');
    head.append(el('strong', '', '实时进展'));
    const liveState = !live ? '未选择' : live.event_loading ? '读取中…' : live.syncing_history ? '同步历史中' : live.events_stopped ? '轮询已停止' : '每 3 秒读取事件';
    head.append(el('span', 'dsh-live-progress-state', liveState));
    section.append(head);
    section.append(el('p', 'dsh-live-facts', [
      `生命周期：${dshStatusLabel({ ...task, status: live?.status || task.status })}`,
      `最新活动：${boundedText(live?.progress || live?.last_event || task.progress || task.last_event || '未提供', 4000)}`,
      `更新时间：${formatDshTime(live?.updated_at || task.updated_at)}`,
      `事件检查：${live?.event_checked_at ? formatDshTime(live.event_checked_at) : '尚未读取'}`,
    ].join('\n')));
    if (!live) {
      section.append(el('p', 'muted', '选择此 agent 后才会读取该 agent 的事件。'));
      return section;
    }
    if (live.syncing_history) section.append(el('p', 'dsh-live-note', '历史尚未追完：本轮最多读取 3 页，稍后从当前游标继续同步。'));
    if (live.has_more && !live.event_loading) section.append(el('p', 'dsh-live-note', '还有更多事件待读取；不会跳到其他 agent，也不会丢失当前游标。'));
    if (live.events_stopped) section.append(el('p', 'dsh-live-note', '任务已结束且事件已追到当前末尾，事件轮询已停止；列表仍会检查 followup 并以 running 恢复读取。'));
    if (live.event_error) section.append(el('p', 'dsh-error', `事件读取错误：${live.event_error}${live.event_stale ? '。旧事件可能过时。' : ''}`));
    if (live.status_error) section.append(el('p', 'dsh-error', `状态读取错误：${live.status_error}${live.status_stale ? '。显示状态可能过时。' : ''}`));
    if (live.final_cleared_at && ['starting','running','interrupting'].includes(String(live.status || '').toLowerCase())) section.append(el('p', 'dsh-live-note', `检测到重新运行；旧最终展示已清除，历史事件保留并继续从原游标读取。`));
    section.append(el('p', 'dsh-live-note', '以下仅为 DSH 实际返回事件（最多保留 100 条）。仅显示已公开的进展，不把事件类型当成任务完成。'));
    const events = Array.isArray(live.events) ? live.events.slice(-100).reverse() : [];
    if (!events.length) {
      section.append(el('p', 'muted', live.events_stopped ? '事件已追到末尾；此任务没有可显示的事件。列表仍会检查 followup。' : '尚未读取到事件；会按游标继续等待。'));
      return section;
    }
    section.append(el('h4', '', '事件记录（新→旧，最多 100 条）'));
    const list = el('ol', 'dsh-live-events');
    for (const event of events) {
      const item = el('li', 'dsh-live-event');
      const meta = el('div', 'dsh-live-event-meta');
      meta.append(el('span', 'dsh-live-event-type', event.type || 'event'));
      if (event.seq !== undefined && event.seq !== null && event.seq !== '') meta.append(el('span', '', `#${boundedText(event.seq, 80)}`));
      if (event.event_id) meta.append(el('span', '', boundedText(event.event_id, 200)));
      item.append(meta);
      if (event.text) item.append(el('p', 'dsh-live-event-text', event.text));
      if (event.summary && event.summary !== event.text) item.append(el('p', 'dsh-live-event-summary', event.summary));
      list.append(item);
    }
    section.append(list);
    return section;
  }
  function renderDshTasks() {
    const snapshot = dshLive.snapshot(); renderDshLiveMeta(snapshot);
    const previousScroll = $('dsh-tasks').scrollTop;
    const focusedAction = document.activeElement?.closest?.('#dsh-tasks [data-dsh-action]')?.dataset.dshAction || null;
    const frag = document.createDocumentFragment(); const tasks = dshTasks.values();
    for (const task of tasks) {
      const selected = !!task.agentId && task.agentId === snapshot.selectedAgentId;
      // DSH task card: identity, last known DSH status, concise live progress, expandable details.
      // The MCP call state is shown separately: a returned call is not a finished task.
      const card = el('article', 'agent-card dsh-task' + (selected ? ' selected' : ''));
      const statusText = dshStatusLabel(task); const raw = String(task.status || '').toLowerCase();
      card.dataset.tone = /error|fail/.test(raw) ? 'fail' : /complete|done|finish|success/.test(raw) ? 'ok' : /cancel|stop|interrupt/.test(raw) ? 'stop' : /run|progress|start|pending|queue/.test(raw) ? 'run' : 'idle';
      const head = el('header', 'agent-head'); const glyph = el('span', 'agent-glyph'); glyph.append(icon(document, 'branch', { size: 16 }));
      const title = el('div', 'agent-title'); title.append(el('strong', '', task.name || task.agentId || '等待任务标识'), el('span', 'agent-id mono', task.agentId ? String(task.agentId).slice(0, 14) : '尚未返回 ID'));
      const chip = el('span', 'agent-state', statusText); chip.dataset.tone = card.dataset.tone;
      head.append(glyph, title, chip); card.append(head);
      const facts = el('div', 'agent-facts');
      const fact = (label, value) => { if (!value) return; const f = el('span', 'agent-fact'); f.append(el('span', '', label), el('b', '', value)); facts.append(f); };
      fact('来源', 'DSH'); fact('MCP 调用', ({inProgress:'进行中',completed:'已返回',failed:'失败',snapshot:'自动快照'})[task.callState] || task.callState || '');
      if (task.updated_at) fact('最近更新', formatDshTime(task.updated_at));
      if (task.cwd) fact('目录', String(task.cwd).split(/[\\/]/).filter(Boolean).at(-1));
      if (facts.children.length) card.append(facts);
      const progress = task.progress || task.last_event || task.mcpProgress;
      if (progress) card.append(el('p', 'agent-progress', String(progress).split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 400) || ''));
      const more = (title, value, className = '') => { if (!value) return; const d = rememberDshDetails(el('details', 'agent-more'), `${title}:${task.key || task.agentId}`); d.append(el('summary', '', title), el('pre', className, value)); card.append(d); };
      more('部分输出（非最终结果）', task.partial_text);
      more('返回结果（历史记录，不代表当前完成）', task.answer);
      if (task.eventSummary && !(selected && task.liveEvents?.length)) more('最近事件摘要', task.eventSummary);
      more('结束原因', task.finish_reason); if (task.error) card.append(el('p', 'agent-progress dsh-error', 'DSH 任务错误：' + String(task.error).slice(0, 400))); more('MCP 调用错误（不等同任务状态）', task.callError, 'dsh-error');
      if (task.agentId) {
        const key = `${task.threadId}:${task.agentId}`; const actions = el('div', 'dsh-read-actions'); const pending = state.dshReads.get(key);
        const liveButton = el('button', 'btn small'); liveButton.append(icon(document, 'branch', { size:15 }), document.createTextNode(selected ? '正在查看实时进展' : '查看实时进展'));
        liveButton.disabled = !state.connected; liveButton.setAttribute('aria-pressed', String(selected)); liveButton.dataset.dshAction = `live:${task.agentId}`;
        liveButton.title = '只读查看此 agent 的状态与事件；不创建、停止或重试任务';
        liveButton.addEventListener('click', () => { dshLive.selectAgent(task.agentId); scheduleDshRender(); });
        actions.append(liveButton);
        const statusButton = el('button', 'btn small'); statusButton.append(icon(document, 'refresh', { size:15 }), document.createTextNode(pending === 'status' ? '读取中…' : '刷新任务状态'));
        statusButton.disabled = !!pending || !state.connected; statusButton.title = '只读查询此任务状态，不创建任务，不请求模型生成'; statusButton.dataset.dshAction = `status:${task.agentId}`;
        statusButton.addEventListener('click', () => readDshTask(task.agentId, 'status')); actions.append(statusButton);
        card.append(actions);
        const readError = state.dshReadErrors.get(key);
        if (readError) { const p = el('p', 'agent-progress dsh-error', '读取错误：' + boundedText(readError, 400)); p.setAttribute('role', 'status'); card.append(p); }
        if (selected) card.append(renderDshLiveEvents(task, snapshot.selected));
      }
      frag.append(card);
    }
    if (!tasks.length) {
      if (!state.thread) frag.append(el('p', 'muted', '先打开一个已有对话，或开始一个新对话并发送消息。这里不会偷偷创建对话，也不会读取全局所有目录。'));
      else if (snapshot.list.loading) frag.append(el('p', 'muted', '正在读取当前对话工作目录中的 DSH agent…'));
      else if (snapshot.list.error) frag.append(el('p', 'muted', '无法读取当前目录的 DSH agent 列表；未改查其他目录。已加载的对话历史仍会显示在这里。'));
      else frag.append(el('p', 'muted', '当前目录的自动列表中尚未发现 DSH agent；已加载的对话历史仍会显示在这里。'));
    }
    $('dsh-tasks').replaceChildren(frag);
    $('dsh-tasks').scrollTop = previousScroll;
    if (focusedAction) [...$('dsh-tasks').querySelectorAll('[data-dsh-action]')].find(button => button.dataset.dshAction === focusedAction)?.focus({ preventScroll: true });
  }
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

  return { renderDshConnection, refreshDsh, syncDshLiveContext, scheduleDshRender, renderDshTasks, ingestDshSnapshot, readDshTask };
}
