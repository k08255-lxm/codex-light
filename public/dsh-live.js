import {
  dshEventsSnapshot,
  dshListSnapshot,
  dshResultError,
  dshStatusSnapshot,
  isDshTerminalStatus,
  mergeDshEvents,
} from './dsh.js';

const DEFAULT_LIST_INTERVAL = 5000;
const DEFAULT_EVENT_INTERVAL = 3000;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_MAX_BACKOFF = 30000;
const MAX_AGENTS = 100;
const ACTIVE_STATUSES = new Set(['starting', 'running', 'interrupting']);

const isActiveStatus = status => ACTIVE_STATUSES.has(String(status || '').toLowerCase());
const messageOf = error => String(error?.message || error || '未知错误').slice(0, 1000);
const sameCursor = (left, right) => String(left ?? '') === String(right ?? '');
const isoAt = (value, fallback) => typeof value === 'string' && value ? value : fallback;

/**
 * Pure, injectable scheduler for read-only DSH list/status/events refreshes.
 * It never creates, starts, resumes or stops an agent. Results from an older
 * context or selection are ignored rather than rendered into the new context.
 */
export class DshLiveMonitor {
  constructor({
    api,
    onChange = () => {},
    onList = () => {},
    onEvents = () => {},
    onStatus = () => {},
    onError = () => {},
    now = () => Date.now(),
    setTimeout: scheduleTimeout = (...args) => globalThis.setTimeout(...args),
    clearTimeout: cancelTimeout = (...args) => globalThis.clearTimeout(...args),
    listInterval = DEFAULT_LIST_INTERVAL,
    eventInterval = DEFAULT_EVENT_INTERVAL,
    maxPages = DEFAULT_MAX_PAGES,
    maxBackoff = DEFAULT_MAX_BACKOFF,
  } = {}) {
    if (typeof api !== 'function') throw new Error('DshLiveMonitor 需要 api 函数');
    this.api = api;
    this.onChange = onChange;
    this.onList = onList;
    this.onEvents = onEvents;
    this.onStatus = onStatus;
    this.onError = onError;
    this.now = now;
    this.scheduleTimeout = scheduleTimeout;
    this.cancelTimeout = cancelTimeout;
    this.listInterval = Math.max(1000, Number(listInterval) || DEFAULT_LIST_INTERVAL);
    this.eventInterval = Math.max(1000, Number(eventInterval) || DEFAULT_EVENT_INTERVAL);
    this.maxPages = Math.max(1, Math.min(10, Number(maxPages) || DEFAULT_MAX_PAGES));
    this.maxBackoff = Math.max(this.listInterval, Number(maxBackoff) || DEFAULT_MAX_BACKOFF);

    this.disposed = false;
    this.generation = 0;
    this.selectionGeneration = 0;
    this.context = { threadId: null, connected: false, visible: false, serverInstance: null };
    this.agents = new Map();
    this.selectedAgentId = null;
    this.timers = { list: null, events: null };
    this.inflight = { list: null, events: null, status: null };
    this.list = this._emptyList();
    this.listSequence = 0;
    this.callbackErrors = new Map();
    this.callbackError = null;
  }

  _emptyList() {
    return { loading: false, checkedAt: null, error: null, stale: false, failures: 0, nextRetryAt: null, cwd: null, count: 0, matched: 0, total: 0, omitted: null };
  }

  _newAgent(agentId) {
    return {
      agentId: String(agentId), name: '', cwd: '', status: '', updated_at: '', progress: '', last_event: '',
      present: false, listCheckedAt: null, lastListSeen: 0,
      events: [], nextCursor: 0, hasMore: false, syncingHistory: false,
      eventError: null, eventStale: false, eventCheckedAt: null, eventFailures: 0, eventNextRetryAt: null,
      eventLoading: false, eventsStopped: false, stalled: false, finalClearedAt: null,
      statusRound: 0, eventEndRound: null,
      statusLoading: false, statusError: null, statusCheckedAt: null, statusStale: false,
    };
  }

  _agent(agentId) {
    const id = String(agentId || '');
    if (!this.agents.has(id)) this.agents.set(id, this._newAgent(id));
    return this.agents.get(id);
  }

  _actionable() {
    return !this.disposed && !!this.context.threadId && !!this.context.connected && !!this.context.visible;
  }

  _pauseReason() {
    if (this.disposed) return '监控已停止';
    if (!this.context.threadId) return '请先打开或开始一个对话';
    if (!this.context.connected) return '连接已断开，自动刷新已暂停';
    if (!this.context.visible) return 'DSH 侧栏或页面不可见，自动刷新已暂停';
    return '';
  }

  snapshot() {
    const selected = this.selectedAgentId ? this.agents.get(this.selectedAgentId) || null : null;
    return {
      generation: this.generation,
      context: { ...this.context },
      actionable: this._actionable(),
      pauseReason: this._pauseReason(),
      list: {
        ...this.list,
        items: [...this.agents.values()].map(agent => this._agentRow(agent)),
      },
      selectedAgentId: this.selectedAgentId,
      selected: selected ? this._selectedSnapshot(selected) : null,
      callbackError: this.callbackError ? { ...this.callbackError } : null,
    };
  }

  _agentRow(agent) {
    return {
      agent_id: agent.agentId, name: agent.name, cwd: agent.cwd, status: agent.status,
      updated_at: agent.updated_at, progress: agent.progress, last_event: agent.last_event,
      present: agent.present, checked_at: agent.listCheckedAt,
      event_error: agent.eventError, event_stale: agent.eventStale,
      event_checked_at: agent.eventCheckedAt, has_more: agent.hasMore,
      syncing_history: agent.syncingHistory, events_stopped: agent.eventsStopped,
      status_round: agent.statusRound, event_end_round: agent.eventEndRound,
    };
  }

  _selectedSnapshot(agent) {
    return {
      ...this._agentRow(agent), events: agent.events.map(event => ({ ...event })),
      next_cursor: agent.nextCursor, has_more: agent.hasMore,
      syncing_history: agent.syncingHistory, event_loading: agent.eventLoading,
      event_failures: agent.eventFailures, next_retry_at: agent.eventNextRetryAt,
      stalled: agent.stalled, final_cleared_at: agent.finalClearedAt,
      status_error: agent.statusError, status_checked_at: agent.statusCheckedAt, status_stale: agent.statusStale,
    };
  }

  _recordCallbackError(callbackName, error) {
    const record = { callback: callbackName, error: messageOf(error), at: new Date(this.now()).toISOString() };
    this.callbackErrors.set(callbackName, record);
    this.callbackError = record;
    try { console.error(`[DshLiveMonitor] ${callbackName} callback failed:`, error); } catch {}
  }

  _notify(callbackName, payload, { failChannel = false } = {}) {
    const callback = this[callbackName];
    if (typeof callback !== 'function') return;
    try {
      callback(payload);
      this.callbackErrors.delete(callbackName);
      if (this.callbackError?.callback === callbackName) this.callbackError = [...this.callbackErrors.values()].at(-1) || null;
    } catch (error) {
      this._recordCallbackError(callbackName, error);
      if (failChannel) throw error;
    }
  }

  _emit(reason) {
    const snapshot = this.snapshot();
    this._notify('onChange', snapshot, { reason });
  }

  _clearTimer(name) {
    const timer = this.timers[name];
    if (timer !== null && timer !== undefined) this.cancelTimeout(timer);
    this.timers[name] = null;
  }

  _schedule(name, delay, callback) {
    this._clearTimer(name);
    this.timers[name] = this.scheduleTimeout(() => {
      this.timers[name] = null;
      callback();
    }, Math.max(0, delay));
  }

  _scheduleList(delay) {
    this._schedule('list', delay, () => { void this._pollList(); });
  }

  _scheduleEvents(delay) {
    if (!this.selectedAgentId || !this._actionable()) return;
    this._schedule('events', delay, () => { void this._pollEvents(); });
  }

  setContext(next = {}) {
    const context = {
      threadId: typeof next.threadId === 'string' && next.threadId ? next.threadId : null,
      connected: !!next.connected,
      visible: !!next.visible,
      serverInstance: typeof next.serverInstance === 'string' && next.serverInstance ? next.serverInstance : null,
    };
    const previous = this.context;
    if (context.threadId === previous.threadId && context.connected === previous.connected && context.visible === previous.visible && context.serverInstance === previous.serverInstance) return;
    const wasActionable = this._actionable();
    const threadChanged = context.threadId !== previous.threadId;
    const instanceChanged = context.serverInstance !== previous.serverInstance;
    this.generation++;
    this._clearTimer('list');
    this._clearTimer('events');
    this.inflight.list = null;
    this.inflight.events = null;
    this.inflight.status = null;
    this.list.loading = false;
    for (const agent of this.agents.values()) { agent.eventLoading = false; agent.statusLoading = false; }
    this.context = context;
    if (threadChanged || instanceChanged) {
      this.agents.clear();
      this.selectedAgentId = null;
      this.selectionGeneration++;
      this.list = this._emptyList();
    } else if (!context.connected || !context.visible) {
      if (this.list.checkedAt) this.list.stale = true;
      for (const agent of this.agents.values()) {
        if (agent.eventCheckedAt) agent.eventStale = true;
        if (agent.statusCheckedAt) agent.statusStale = true;
      }
    }
    this._emit('context');
    if (!this._actionable()) return;
    const becameActionable = !wasActionable;
    if (threadChanged || instanceChanged || becameActionable) {
      void this._pollList();
      if (this.selectedAgentId) {
        const agent = this.agents.get(this.selectedAgentId);
        if (agent) {
          void this._pollStatus(this.selectedAgentId);
          if (!agent.eventsStopped) void this._pollEvents();
        }
      }
    }
  }

  selectAgent(agentId) {
    if (this.disposed) return;
    const id = typeof agentId === 'string' && agentId ? agentId : null;
    if (id === this.selectedAgentId) {
      if (id) this._refreshSelected();
      return;
    }
    this.selectionGeneration++;
    this._clearTimer('events');
    this.inflight.events = null;
    this.inflight.status = null;
    this.selectedAgentId = id;
    if (id) this._agent(id);
    this._emit('select');
    if (!id || !this._actionable()) return;
    void this._pollStatus(id);
    const agent = this.agents.get(id);
    if (agent && !agent.eventsStopped) void this._pollEvents();
  }

  _refreshSelected() {
    if (!this.selectedAgentId || !this._actionable()) return;
    const agent = this.agents.get(this.selectedAgentId);
    if (!agent) return;
    void this._pollStatus(this.selectedAgentId);
    if (!agent.eventsStopped || agent.stalled) {
      agent.stalled = false;
      agent.eventsStopped = false;
      agent.eventFailures = 0;
      agent.eventNextRetryAt = null;
      void this._pollEvents();
    }
  }

  refresh() {
    if (this.disposed) return Promise.resolve([]);
    this._clearTimer('list');
    this._clearTimer('events');
    this.list.error = null;
    this.list.failures = 0;
    this.list.nextRetryAt = null;
    const agent = this.selectedAgentId ? this.agents.get(this.selectedAgentId) : null;
    if (agent) {
      agent.eventError = null;
      agent.eventFailures = 0;
      agent.eventNextRetryAt = null;
      if (agent.stalled) { agent.stalled = false; agent.eventsStopped = false; }
      agent.statusError = null;
    }
    if (!this._actionable()) { this._emit('refresh-paused'); return Promise.resolve([]); }
    this._emit('refresh');
    const operations = [this._pollList()];
    if (this.selectedAgentId) {
      operations.push(this._pollStatus(this.selectedAgentId));
      if (agent && (!agent.eventsStopped || agent.stalled)) operations.push(this._pollEvents());
    }
    return Promise.allSettled(operations);
  }

  reset() {
    this.disposed = false;
    this.generation++;
    this.selectionGeneration++;
    this._clearTimer('list');
    this._clearTimer('events');
    this.inflight = { list: null, events: null, status: null };
    this.context = { threadId: null, connected: false, visible: false, serverInstance: null };
    this.agents.clear();
    this.selectedAgentId = null;
    this.list = this._emptyList();
    this.listSequence = 0;
    this.callbackErrors.clear();
    this.callbackError = null;
    this._emit('reset');
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    this.selectionGeneration++;
    this._clearTimer('list');
    this._clearTimer('events');
    this.inflight = { list: null, events: null, status: null };
    this.agents.clear();
    this.selectedAgentId = null;
    this.list = this._emptyList();
    this.listSequence = 0;
    this.callbackErrors.clear();
    this.callbackError = null;
    this.context = { threadId: null, connected: false, visible: false, serverInstance: null };
  }

  _currentList(op) {
    return !this.disposed && this.generation === op.generation && this.context.threadId === op.threadId;
  }

  _currentSelection(op) {
    return this._currentList(op) && this.selectionGeneration === op.selectionGeneration && this.selectedAgentId === (op.agentId || null);
  }

  _backoff(base, failures) {
    return Math.min(this.maxBackoff, base * (2 ** Math.min(6, Math.max(1, failures))));
  }

  _failList(error) {
    this.list.loading = false;
    this.list.error = messageOf(error);
    this.list.stale = !!this.list.checkedAt;
    this.list.failures += 1;
    const delay = this._backoff(this.listInterval, this.list.failures);
    this.list.nextRetryAt = this.now() + delay;
    this._notify('onError', { scope: 'list', error: this.list.error, stale: this.list.stale, retryAt: this.list.nextRetryAt });
    this._emit('list-error');
    if (this._actionable()) this._scheduleList(delay);
  }

  _pollList() {
    if (!this._actionable()) return Promise.resolve(false);
    if (this.inflight.list) return this.inflight.list.promise;
    const op = { generation: this.generation, threadId: this.context.threadId };
    this.list.loading = true;
    this._emit('list-loading');
    let promise;
    promise = (async () => {
      try {
        const data = await this.api('/api/dsh/monitor', { threadId: op.threadId });
        if (!this._currentList(op)) return false;
        if (data?.threadId && data.threadId !== op.threadId) throw new Error('DSH 返回了其他对话的列表，已丢弃');
        const toolError = dshResultError(data?.result);
        if (toolError) throw new Error(toolError);
        const projection = dshListSnapshot(data?.result);
        if (!projection.available) throw new Error('DSH 列表返回格式无法识别');
        const checkedAt = isoAt(data?.checkedAt, new Date(this.now()).toISOString());
        const poked = this._applyList(projection, { checkedAt, cwd: data?.cwd || null });
        this.list.loading = false;
        this.list.checkedAt = checkedAt;
        this.list.cwd = data?.cwd || this.list.cwd;
        this.list.count = projection.count;
        this.list.matched = projection.matched;
        this.list.total = projection.total;
        this.list.omitted = projection.omitted;
        this.list.error = null;
        this.list.stale = false;
        this.list.failures = 0;
        this.list.nextRetryAt = null;
        this._notify('onList', { threadId: op.threadId, cwd: data?.cwd || null, list: projection, checkedAt }, { failChannel: true });
        this._emit('list');
        this._scheduleList(this.listInterval);
        if (poked && this.selectedAgentId) {
          const agent = this.agents.get(this.selectedAgentId);
          if (agent && !agent.eventsStopped) void this._pollEvents();
        }
        return true;
      } catch (error) {
        if (!this._currentList(op)) return false;
        this._failList(error);
        return false;
      } finally {
        if (this.inflight.list?.promise === promise) this.inflight.list = null;
        if (this._currentList(op) && this.list.loading) {
          this.list.loading = false;
          this._emit('list-settled');
        }
      }
    })();
    this.inflight.list = { promise, generation: op.generation, threadId: op.threadId };
    return promise;
  }

  _noteStatus(agent, status, updatedAt) {
    const previousStatus = agent.status;
    const previousUpdated = agent.updated_at;
    const nextStatus = status || previousStatus;
    const nextUpdated = updatedAt || previousUpdated;
    const previousTerminal = isDshTerminalStatus(previousStatus);
    const nextTerminal = isDshTerminalStatus(nextStatus);
    const nextActive = isActiveStatus(nextStatus);
    const terminalTransition = nextTerminal && !previousTerminal;
    const terminalUpdated = nextTerminal && previousTerminal && !!updatedAt && nextUpdated !== previousUpdated;
    const resumed = nextActive && previousTerminal;
    const invalidated = terminalTransition || terminalUpdated || resumed;
    if (invalidated) {
      // An event end belongs to one lifecycle round. A terminal transition or a new
      // terminal updated_at starts a new round and must be caught up once more.
      agent.statusRound += 1;
      agent.eventEndRound = null;
      agent.eventsStopped = false;
      agent.stalled = false;
    }
    if (nextActive) { agent.eventsStopped = false; agent.stalled = false; }
    if (resumed || terminalUpdated) agent.finalClearedAt = new Date(this.now()).toISOString();
    return { invalidated, resumed, terminalTransition, terminalUpdated };
  }

  _trimAgents(seen) {
    if (this.agents.size <= MAX_AGENTS) return;
    const removable = [...this.agents.values()]
      .filter(agent => agent.agentId !== this.selectedAgentId && !seen.has(agent.agentId))
      .sort((left, right) => (left.lastListSeen || 0) - (right.lastListSeen || 0));
    while (this.agents.size > MAX_AGENTS && removable.length) this.agents.delete(removable.shift().agentId);
  }

  _applyList(projection, { checkedAt, cwd }) {
    this.listSequence += 1;
    const seen = new Set();
    let pokeSelected = false;
    for (const row of projection.items) {
      const id = row.agent_id;
      if (!id) continue;
      seen.add(id);
      const agent = this._agent(id);
      const transition = this._noteStatus(agent, row.status, row.updated_at);
      agent.present = true;
      agent.listCheckedAt = checkedAt;
      agent.lastListSeen = this.listSequence;
      if (cwd) agent.cwd = cwd;
      for (const field of ['name', 'cwd', 'status', 'updated_at', 'progress', 'last_event']) {
        if (row[field] !== undefined && row[field] !== null && row[field] !== '') agent[field] = row[field];
      }
      if (transition.invalidated && id === this.selectedAgentId) pokeSelected = true;
    }
    for (const agent of this.agents.values()) if (!seen.has(agent.agentId)) agent.present = false;
    this._trimAgents(seen);
    return pokeSelected;
  }

  _applyStatus(agent, status, checkedAt) {
    const transition = this._noteStatus(agent, status.status, status.updated_at);
    for (const field of ['name', 'cwd', 'status', 'updated_at', 'progress', 'last_event']) {
      if (status[field] !== undefined && status[field] !== null && status[field] !== '') agent[field] = status[field];
    }
    agent.statusCheckedAt = checkedAt;
    agent.statusError = null;
    agent.statusStale = false;
    return transition.invalidated;
  }

  _pollStatus(agentId = this.selectedAgentId) {
    if (!agentId || !this._actionable() || this.selectedAgentId !== agentId) return Promise.resolve(false);
    if (this.inflight.status) return this.inflight.status.promise;
    const agent = this._agent(agentId);
    const op = { generation: this.generation, selectionGeneration: this.selectionGeneration, agentId, threadId: this.context.threadId };
    agent.statusLoading = true;
    this._emit('status-loading');
    let promise;
    promise = (async () => {
      try {
        const data = await this.api('/api/dsh/read', { threadId: op.threadId, agentId, kind: 'status' });
        if (!this._currentSelection(op)) return false;
        if (data?.threadId && data.threadId !== op.threadId) throw new Error('DSH 状态返回了其他对话，已丢弃');
        if (data?.agentId && data.agentId !== agentId) throw new Error('DSH 状态返回了其他 agent，已丢弃');
        const toolError = dshResultError(data?.result);
        if (toolError) throw new Error(toolError);
        const projection = dshStatusSnapshot(data?.result);
        if (!projection.available) throw new Error('DSH 状态返回格式无法识别');
        const checkedAt = isoAt(data?.checkedAt, new Date(this.now()).toISOString());
        const invalidated = this._applyStatus(agent, projection, checkedAt);
        this._notify('onStatus', { threadId: op.threadId, agentId, status: projection, checkedAt }, { failChannel: true });
        this._emit('status');
        if (invalidated && !agent.eventsStopped) this._scheduleEvents(0);
        return true;
      } catch (error) {
        if (!this._currentSelection(op)) return false;
        agent.statusError = messageOf(error);
        agent.statusStale = !!agent.statusCheckedAt;
        this._notify('onError', { scope: 'status', agentId, error: agent.statusError, stale: agent.statusStale, retryAt: null });
        this._emit('status-error');
        return false;
      } finally {
        if (this.inflight.status?.promise === promise) this.inflight.status = null;
        if (this.selectedAgentId === agentId) agent.statusLoading = false;
        if (this._currentSelection(op)) this._emit('status-settled');
      }
    })();
    this.inflight.status = { promise, generation: op.generation, selectionGeneration: op.selectionGeneration, agentId };
    return promise;
  }

  _pollEvents(forcedAgentId = null) {
    if (!this.selectedAgentId || this.selectedAgentId !== (forcedAgentId || this.selectedAgentId) || !this._actionable()) return Promise.resolve(false);
    const agentId = this.selectedAgentId;
    const agent = this._agent(agentId);
    if (agent.eventsStopped && !agent.stalled) return Promise.resolve(false);
    if (this.inflight.events?.agentId === agentId) return this.inflight.events.promise;
    if (this.inflight.events) return this.inflight.events.promise;
    const op = { generation: this.generation, selectionGeneration: this.selectionGeneration, agentId, threadId: this.context.threadId };
    const eventRound = agent.statusRound;
    agent.eventLoading = true;
    agent.eventError = null;
    this._emit('events-loading');
    let promise;
    promise = (async () => {
      let pages = 0;
      let cursor = agent.nextCursor ?? 0;
      let hasMore = !!agent.hasMore;
      try {
        while (pages < this.maxPages) {
          const data = await this.api('/api/dsh/read', { threadId: op.threadId, agentId, kind: 'events', after: cursor });
          if (!this._currentSelection(op)) return false;
          if (data?.threadId && data.threadId !== op.threadId) throw new Error('DSH 事件返回了其他对话，已丢弃');
          if (data?.agentId && data.agentId !== agentId) throw new Error('DSH 事件返回了其他 agent，已丢弃');
          const toolError = dshResultError(data?.result);
          if (toolError) throw new Error(toolError);
          const projection = dshEventsSnapshot(data?.result);
          if (!projection.available) throw new Error('DSH 事件返回格式无法识别');
          const checkedAt = isoAt(data?.checkedAt, new Date(this.now()).toISOString());
          const previousCursor = cursor;
          const merged = mergeDshEvents(agent.events, projection.events);
          agent.events = merged;
          agent.nextCursor = projection.next_cursor;
          agent.hasMore = projection.has_more;
          hasMore = projection.has_more;
          agent.eventCheckedAt = checkedAt;
          agent.eventError = null;
          agent.eventStale = false;
          agent.eventFailures = 0;
          agent.eventNextRetryAt = null;
          agent.stalled = false;
          pages++;
          cursor = agent.nextCursor;
          this._notify('onEvents', {
            threadId: op.threadId, agentId, events: projection.events, allEvents: merged,
            checkedAt, nextCursor: agent.nextCursor, hasMore: agent.hasMore,
            syncingHistory: agent.hasMore,
          }, { failChannel: true });
          this._emit('events');
          if (!agent.hasMore) break;
          if (sameCursor(previousCursor, agent.nextCursor)) {
            const error = new Error('DSH 事件游标没有前进，已停止本轮读取以避免死循环');
            error.code = 'cursorStalled';
            throw error;
          }
        }
        agent.syncingHistory = hasMore;
        agent.eventLoading = false;
        const roundCurrent = agent.statusRound === eventRound;
        if (isDshTerminalStatus(agent.status) && !agent.hasMore && roundCurrent) {
          agent.eventsStopped = true;
          agent.eventEndRound = eventRound;
          this._clearTimer('events');
          agent.eventNextRetryAt = null;
        } else {
          agent.eventsStopped = false;
          agent.eventEndRound = null;
          if (this._actionable()) this._scheduleEvents(roundCurrent ? this.eventInterval : 0);
        }
        this._emit('events-settled');
        return true;
      } catch (error) {
        if (!this._currentSelection(op)) return false;
        this._failEvents(agent, error);
        return false;
      } finally {
        if (this.inflight.events?.promise === promise) this.inflight.events = null;
        if (this.selectedAgentId === agentId) agent.eventLoading = false;
        if (this._currentSelection(op)) this._emit('events-settled');
      }
    })();
    this.inflight.events = { promise, generation: op.generation, selectionGeneration: op.selectionGeneration, agentId };
    return promise;
  }

  _failEvents(agent, error) {
    agent.eventLoading = false;
    agent.eventError = messageOf(error);
    agent.eventStale = !!agent.eventCheckedAt;
    agent.syncingHistory = !!agent.hasMore;
    agent.eventFailures += 1;
    const stalled = error?.code === 'cursorStalled';
    if (stalled) {
      agent.stalled = true;
      agent.eventsStopped = true;
      agent.eventNextRetryAt = null;
    } else {
      const delay = this._backoff(this.eventInterval, agent.eventFailures);
      agent.eventNextRetryAt = this.now() + delay;
      if (this._actionable()) this._scheduleEvents(delay);
    }
    this._notify('onError', {
      scope: 'events', agentId: agent.agentId, error: agent.eventError,
      stale: agent.eventStale, retryAt: agent.eventNextRetryAt, stalled,
    });
    this._emit('events-error');
  }
}

export { DEFAULT_EVENT_INTERVAL, DEFAULT_LIST_INTERVAL };
