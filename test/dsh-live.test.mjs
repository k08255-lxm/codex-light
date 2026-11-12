import test from 'node:test';
import assert from 'node:assert/strict';
import { DshLiveMonitor } from '../public/dsh-live.js';

const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
class FakeClock {
  constructor() { this.time = 0; this.nextId = 1; this.timers = new Map(); }
  now() { return this.time; }
  setTimeout(fn, delay) { const id = this.nextId++; this.timers.set(id, { id, at: this.time + Math.max(0, delay), fn }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  async advance(ms) {
    const target = this.time + Math.max(0, ms); let guard = 0;
    while (guard++ < 500) {
      await flush();
      let due = null;
      for (const timer of this.timers.values()) if (timer.at <= target && (!due || timer.at < due.at || (timer.at === due.at && timer.id < due.id))) due = timer;
      if (!due) {
        this.time = target;
        await flush();
        for (const timer of this.timers.values()) if (timer.at <= target && (!due || timer.at < due.at || (timer.at === due.at && timer.id < due.id))) due = timer;
        if (!due) break;
      }
      this.timers.delete(due.id); this.time = due.at; due.fn();
    }
    this.time = target; await flush();
  }
}
const listResponse = (threadId, items, extra = {}) => ({
  threadId, cwd: 'C:/work', tool: 'dsh_list', checkedAt: '2026-11-11T12:00:00.000Z',
  result: { structuredContent: { items, count: items.length, matched: items.length, total: items.length, ...extra } },
});
const statusResponse = (threadId, agentId, status = 'running', extra = {}) => ({
  threadId, agentId, tool: 'dsh_status', checkedAt: '2026-11-11T12:00:01.000Z',
  result: { structuredContent: { agent_id: agentId, status, updated_at: '2026-11-11T12:00:01.000Z', ...extra } },
});
const eventsResponse = (threadId, agentId, events, nextCursor, hasMore) => ({
  threadId, agentId, tool: 'dsh_events', checkedAt: '2026-11-11T12:00:02.000Z',
  result: { structuredContent: { events, next_cursor: nextCursor, has_more: hasMore } },
});
function harness(handler, options = {}) {
  const clock = new FakeClock(); const calls = [];
  const monitor = new DshLiveMonitor({
    api: async (path, body) => { calls.push({ path, body }); return handler(path, body, calls); },
    now: () => clock.now(), setTimeout: (fn, delay) => clock.setTimeout(fn, delay),
    clearTimeout: id => clock.clearTimeout(id), ...options,
  });
  return {
    clock, calls, monitor,
    lists: () => calls.filter(call => call.path === '/api/dsh/monitor'),
    statuses: () => calls.filter(call => call.path === '/api/dsh/read' && call.body.kind === 'status'),
    events: () => calls.filter(call => call.path === '/api/dsh/read' && call.body.kind === 'events'),
    open: async () => { monitor.setContext({ threadId: 't1', connected: true, visible: true, serverInstance: 's1' }); await clock.advance(0); },
  };
}

test('default browser timers keep the required global receiver and dispose clears them', async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let scheduled = 0, cleared = 0;
  const strictSet = function (...args) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    scheduled++;
    return Reflect.apply(originalSet, globalThis, args);
  };
  const strictClear = function (id) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    cleared++;
    return Reflect.apply(originalClear, globalThis, [id]);
  };
  globalThis.setTimeout = strictSet; globalThis.clearTimeout = strictClear;
  try {
    const monitor = new DshLiveMonitor({ api: async () => listResponse('t1', [{ agent_id: 'a', status: 'running' }]) });
    monitor.setContext({ threadId: 't1', connected: true, visible: true, serverInstance: 's1' });
    await flush();
    assert.equal(monitor.snapshot().list.count, 1);
    assert.ok(scheduled >= 1, 'default timer must be invoked with the global receiver');
    monitor.dispose();
    assert.ok(cleared >= 1, 'dispose must clear the scheduled timer with the global receiver');
  } finally {
    globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
  }
});

test('list runs every 5s and selected events every 3s only in a visible connected thread', async () => {
  const h = harness((path, body) => {
    if (path === '/api/dsh/monitor') return listResponse('t1', [{ agent_id: 'a', name: 'A', status: 'running' }]);
    if (body.kind === 'status') return statusResponse('t1', 'a');
    return eventsResponse('t1', 'a', [{ event_id: 'e1', seq: 1, type: 'progress', text: 'step' }], 1, false);
  });
  h.monitor.setContext({ threadId: 't1', connected: true, visible: false, serverInstance: 's1' });
  await h.clock.advance(10000);
  assert.equal(h.calls.length, 0, 'hidden context must not schedule');
  h.monitor.setContext({ threadId: 't1', connected: true, visible: true, serverInstance: 's1' });
  await h.clock.advance(0);
  assert.equal(h.lists().length, 1, 'becoming visible refreshes immediately');
  h.monitor.selectAgent('a');
  await h.clock.advance(0);
  assert.equal(h.events().length, 1, 'selection refreshes events immediately');
  await h.clock.advance(2999);
  assert.equal(h.events().length, 1, 'events wait three seconds');
  await h.clock.advance(1);
  assert.equal(h.events().length, 2, 'events poll every three seconds');
  await h.clock.advance(2000);
  assert.equal(h.lists().length, 2, 'list polls every five seconds');
  h.monitor.setContext({ threadId: 't1', connected: false, visible: true, serverInstance: 's1' });
  const stoppedAt = h.calls.length;
  await h.clock.advance(10000);
  assert.equal(h.calls.length, stoppedAt, 'disconnect stops all automatic scheduling');
});

test('events continue numeric/string cursors serially, dedupe repeats, and cap at three pages per cycle', async () => {
  let eventCalls = 0;
  const h = harness((path, body) => {
    if (path === '/api/dsh/monitor') return listResponse('t1', [{ agent_id: 'a', name: 'A', status: 'running' }]);
    if (body.kind === 'status') return statusResponse('t1', 'a');
    eventCalls++;
    if (eventCalls === 1) return eventsResponse('t1', 'a', [{ event_id: 'e1', seq: 1, type: 'progress', text: 'one' }], '12:0:3', true);
    if (eventCalls === 2) return eventsResponse('t1', 'a', [{ event_id: 'e1', seq: 1, type: 'progress', text: 'one' }, { event_id: 'e2', seq: 2, type: 'progress', text: 'two' }], '12:0:4', true);
    return eventsResponse('t1', 'a', [{ event_id: 'e3', seq: 3, type: 'progress', text: 'three' }], '12:0:5', false);
  });
  await h.open(); h.monitor.selectAgent('a'); await h.clock.advance(0);
  assert.deepEqual(h.events().map(call => call.body.after), [0, '12:0:3', '12:0:4']);
  let snapshot = h.monitor.snapshot();
  assert.equal(snapshot.selected.events.length, 3, 'duplicate event is not shown twice');
  assert.equal(snapshot.selected.next_cursor, '12:0:5');
  await h.clock.advance(3000);
  assert.deepEqual(h.events().map(call => call.body.after), [0, '12:0:3', '12:0:4', '12:0:5']);
  snapshot = h.monitor.snapshot();
  assert.equal(snapshot.selected.syncing_history, false);
});

test('more than three pages shows syncing history and continues from the retained cursor', async () => {
  const h = harness((path, body) => {
    if (path === '/api/dsh/monitor') return listResponse('t1', [{ agent_id: 'a', status: 'running' }]);
    if (body.kind === 'status') return statusResponse('t1', 'a');
    const after = Number(body.after || 0);
    return eventsResponse('t1', 'a', [{ event_id: `e${after}`, seq: after, type: 'progress', text: `p${after}` }], String(after + 1), true);
  });
  await h.open(); h.monitor.selectAgent('a'); await h.clock.advance(0);
  assert.equal(h.events().length, 3, 'one cycle stops after three pages');
  assert.equal(h.monitor.snapshot().selected.syncing_history, true);
  await h.clock.advance(2999);
  assert.equal(h.events().length, 3, 'next page waits for the event interval');
  await h.clock.advance(1);
  assert.equal(h.events().length, 6, 'the next cycle reads another bounded three pages');
  assert.equal(h.events()[3].body.after, '3', 'cursor continues instead of restarting at zero');
  assert.equal(h.events().at(-1).body.after, '5');
});

test('unchanged cursor with has_more stops the loop, reports an error, and manual refresh retries', async () => {
  let stall = true;
  const h = harness((path, body) => {
    if (path === '/api/dsh/monitor') return listResponse('t1', [{ agent_id: 'a', status: 'running' }]);
    if (body.kind === 'status') return statusResponse('t1', 'a');
    if (stall) return eventsResponse('t1', 'a', [{ event_id: 'e1', seq: 1, type: 'progress', text: 'one' }], 0, true);
    return eventsResponse('t1', 'a', [{ event_id: 'e2', seq: 2, type: 'progress', text: 'two' }], 2, false);
  });
  await h.open(); h.monitor.selectAgent('a'); await h.clock.advance(0);
  let snapshot = h.monitor.snapshot();
  assert.equal(snapshot.selected.stalled, true);
  assert.match(snapshot.selected.event_error, /游标没有前进/);
  const callsAtStall = h.events().length;
  await h.clock.advance(10000);
  assert.equal(h.events().length, callsAtStall, 'stalled cursor must not keep polling');
  stall = false;
  h.monitor.refresh(); await h.clock.advance(0);
  snapshot = h.monitor.snapshot();
  assert.equal(snapshot.selected.stalled, false);
  assert.equal(snapshot.selected.event_error, null);
  assert.equal(snapshot.selected.events.length, 2);
});

test('list errors preserve old data as stale, back off, and manual refresh retries immediately', async () => {
  let listCalls = 0;
  const h = harness(path => {
    if (path === '/api/dsh/monitor') {
      listCalls++;
      if (listCalls === 2) return { threadId: 't1', tool: 'dsh_list', result: { isError: true, content: [{ type: 'text', text: 'list unavailable' }] } };
      return listResponse('t1', [{ agent_id: 'a', name: 'A', status: 'running' }]);
    }
    return {};
  });
  await h.open();
  await h.clock.advance(5000);
  let snapshot = h.monitor.snapshot();
  assert.equal(snapshot.list.stale, true);
  assert.match(snapshot.list.error, /list unavailable/);
  assert.equal(snapshot.list.items.length, 1, 'old list remains visible but stale');
  const callsAtError = h.lists().length;
  await h.clock.advance(9999);
  assert.equal(h.lists().length, callsAtError, 'backoff prevents immediate retries');
  h.monitor.refresh(); await h.clock.advance(0);
  snapshot = h.monitor.snapshot();
  assert.equal(snapshot.list.error, null);
  assert.equal(snapshot.list.stale, false);
  assert.equal(h.lists().length, callsAtError + 1, 'manual refresh bypasses the backoff timer');
});

test('events errors back off and recover on the next scheduled try', async () => {
  let eventCalls = 0;
  const h = harness((path, body) => {
    if (path === '/api/dsh/monitor') return listResponse('t1', [{ agent_id: 'a', status: 'running' }]);
    if (body.kind === 'status') return statusResponse('t1', 'a');
    eventCalls++;
    if (eventCalls === 1) { const error = new Error('events unavailable'); throw error; }
    return eventsResponse('t1', 'a', [{ event_id: 'e1', seq: 1, type: 'progress', text: 'ok' }], 1, false);
  });
  await h.open(); h.monitor.selectAgent('a'); await h.clock.advance(0);
  assert.match(h.monitor.snapshot().selected.event_error, /events unavailable/);
  const callsAtError = h.events().length;
  await h.clock.advance(2999);
  assert.equal(h.events().length, callsAtError, 'event backoff is longer than its normal interval');
  await h.clock.advance(3001);
  assert.equal(h.events().length, callsAtError + 1);
  assert.equal(h.monitor.snapshot().selected.event_error, null);
  assert.equal(h.monitor.snapshot().selected.events.length, 1);
});

test('late results from another thread and another selection cannot pollute the current context', async () => {
  let releaseOldThread;
  let releaseOldSelection;
  const oldThread = new Promise(resolve => { releaseOldThread = resolve; });
  const oldSelection = new Promise(resolve => { releaseOldSelection = resolve; });
  const h = harness((path, body) => {
    if (path === '/api/dsh/monitor') {
      if (body.threadId === 't1') return oldThread;
      return listResponse('t2', [{ agent_id: 'b', status: 'running' }]);
    }
    if (body.kind === 'status') return statusResponse(body.threadId, body.agentId);
    if (body.agentId === 'a') return oldSelection;
    return eventsResponse(body.threadId, body.agentId, [{ event_id: 'b1', seq: 1, type: 'progress', text: 'new' }], 1, false);
  });
  h.monitor.setContext({ threadId: 't1', connected: true, visible: true, serverInstance: 's1' });
  await h.clock.advance(0);
  h.monitor.setContext({ threadId: 't2', connected: true, visible: true, serverInstance: 's1' });
  await h.clock.advance(0);
  releaseOldThread(listResponse('t1', [{ agent_id: 'old', status: 'completed' }]));
  await flush();
  assert.deepEqual(h.monitor.snapshot().list.items.map(item => item.agent_id), ['b']);
  h.monitor.setContext({ threadId: 't1', connected: true, visible: true, serverInstance: 's1' });
  await h.clock.advance(0);
  h.monitor.selectAgent('a'); await h.clock.advance(0);
  h.monitor.selectAgent('b'); await h.clock.advance(0);
  releaseOldSelection(eventsResponse('t1', 'a', [{ event_id: 'a1', seq: 1, type: 'progress', text: 'old' }], 1, false));
  await flush();
  const snapshot = h.monitor.snapshot();
  assert.equal(snapshot.selectedAgentId, 'b');
  assert.equal(snapshot.selected.events.some(event => event.event_id === 'a1'), false);
  assert.equal(snapshot.selected.events.some(event => event.event_id === 'b1'), true);
});

test('terminal tasks stop event polling and a list followup restarts it without losing the cursor', async () => {
  let listStatus = 'completed';
  const h = harness((path, body) => {
    if (path === '/api/dsh/monitor') return listResponse('t1', [{ agent_id: 'a', name: 'A', status: listStatus }]);
    if (body.kind === 'status') return statusResponse('t1', 'a', listStatus);
    return eventsResponse('t1', 'a', [{ event_id: 'final', seq: 9, type: 'assistant/final', text: 'old output' }], 9, false);
  });
  await h.open(); h.monitor.selectAgent('a'); await h.clock.advance(0);
  assert.equal(h.monitor.snapshot().selected.events_stopped, true);
  const stoppedCalls = h.events().length;
  await h.clock.advance(4000);
  assert.equal(h.events().length, stoppedCalls, 'terminal task must not poll events every three seconds');
  listStatus = 'running';
  await h.clock.advance(1000);
  assert.equal(h.events().length, stoppedCalls + 1, 'list followup restarts event polling');
  assert.equal(h.events().at(-1).body.after, 9, 'followup retains the old cursor');
  assert.ok(h.monitor.snapshot().selected.final_cleared_at);
});

test('status running clears the old final state but retains the event cursor', async () => {
  let status = 'completed';
  const h = harness((path, body) => {
    if (path === '/api/dsh/monitor') return listResponse('t1', [{ agent_id: 'a', status }]);
    if (body.kind === 'status') return statusResponse('t1', 'a', status);
    return eventsResponse('t1', 'a', [{ event_id: 'e9', seq: 9, type: 'assistant/final', text: 'old' }], '7:2:1', false);
  });
  await h.open(); h.monitor.selectAgent('a'); await h.clock.advance(0);
  assert.equal(h.monitor.snapshot().selected.events_stopped, true);
  status = 'running';
  h.monitor.refresh(); await h.clock.advance(0);
  const snapshot = h.monitor.snapshot();
  assert.ok(snapshot.selected.final_cleared_at);
  assert.equal(snapshot.selected.events_stopped, false);
  assert.equal(h.events().at(-1).body.after, '7:2:1');
});

test('an event end observed while running is not trusted after a later completed list; the terminal tail is read again', async () => {
  let completed = false;
  const h = harness((path, body) => {
    if (path === '/api/dsh/monitor') return listResponse('t1', [{
      agent_id: 'a', name: 'A', status: completed ? 'completed' : 'running',
      updated_at: '2026-11-11T12:00:01.000Z',
    }]);
    if (body.kind === 'status') return statusResponse('t1', 'a', completed ? 'completed' : 'running', {
      updated_at: '2026-11-11T12:00:01.000Z',
    });
    if (completed) return eventsResponse('t1', 'a', [{ event_id: 'last-final', seq: 2, type: 'assistant/final', text: 'final output' }], 2, false);
    return eventsResponse('t1', 'a', [{ event_id: 'tail', seq: 1, type: 'progress', text: 'last progress while running' }], 1, false);
  });
  await h.open(); h.monitor.selectAgent('a'); await h.clock.advance(0);
  assert.equal(h.monitor.snapshot().selected.events_stopped, false, 'running event end does not stop polling');
  await h.clock.advance(3000);
  assert.equal(h.events().length, 2, 'running status continues its normal event cadence');
  const beforeCompletion = h.events().length;
  completed = true;
  await h.clock.advance(2000);
  const snapshot = h.monitor.snapshot();
  assert.equal(h.events().length, beforeCompletion + 1, 'completed list forces one more event catch-up');
  assert.equal(h.events().at(-1).body.after, 1, 'the catch-up starts at the retained cursor');
  assert.equal(snapshot.selected.events.some(event => event.event_id === 'last-final'), true);
  assert.equal(snapshot.selected.events_stopped, true);
  assert.equal(snapshot.selected.event_end_round, snapshot.selected.status_round);
  const stoppedAt = h.events().length;
  await h.clock.advance(3000);
  assert.equal(h.events().length, stoppedAt, 'only the current terminal round can stop polling');
});

test('a completed task with a new updated_at is read again even while its status stays completed', async () => {
  let listCalls = 0;
  const h = harness((path, body) => {
    if (path === '/api/dsh/monitor') {
      listCalls++;
      return listResponse('t1', [{
        agent_id: 'a', name: 'A', status: 'completed',
        updated_at: listCalls === 1 ? '2026-11-11T12:00:01.000Z' : '2026-11-11T12:00:05.000Z',
      }]);
    }
    if (body.kind === 'status') return statusResponse('t1', 'a', 'completed', { updated_at: '2026-11-11T12:00:01.000Z' });
    if (body.after === 0) return eventsResponse('t1', 'a', [{ event_id: 'old-final', seq: 1, type: 'assistant/final', text: 'old output' }], '4:0:1', false);
    return eventsResponse('t1', 'a', [{ event_id: 'new-final', seq: 2, type: 'assistant/final', text: 'new output' }], '4:0:2', false);
  });
  await h.open(); h.monitor.selectAgent('a'); await h.clock.advance(0);
  let snapshot = h.monitor.snapshot();
  assert.equal(snapshot.selected.events_stopped, true);
  assert.equal(snapshot.selected.next_cursor, '4:0:1');
  await h.clock.advance(3000);
  assert.equal(h.events().length, 1, 'completed task does not poll without a new round');
  await h.clock.advance(2000);
  snapshot = h.monitor.snapshot();
  assert.equal(h.events().length, 2, 'new terminal updated_at forces a catch-up');
  assert.equal(h.events().at(-1).body.after, '4:0:1', 'the new catch-up keeps the continuation cursor');
  assert.equal(snapshot.selected.events.some(event => event.event_id === 'new-final'), true);
  assert.equal(snapshot.selected.next_cursor, '4:0:2');
  assert.equal(snapshot.selected.events_stopped, true);
  assert.equal(snapshot.selected.status_round, 2);
  assert.equal(snapshot.selected.event_end_round, 2);
});

test('callback failures are recorded in the snapshot and logged instead of being swallowed', async () => {
  const logged = []; const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const h = harness(path => path === '/api/dsh/monitor' ? listResponse('t1', [{ agent_id: 'a', status: 'running' }]) : {}, {
      onList: () => { throw new Error('list render failed'); },
    });
    await h.open();
    const snapshot = h.monitor.snapshot();
    assert.match(snapshot.list.error, /list render failed/);
    assert.equal(snapshot.callbackError.callback, 'onList');
    assert.match(snapshot.callbackError.error, /list render failed/);
    assert.ok(logged.some(args => String(args[0]).includes('[DshLiveMonitor]')));
  } finally {
    console.error = original;
  }
});

test('agent rotation is capped at 100 while preserving the selected agent and current list', async () => {
  let current = 'a0';
  const h = harness((path, body) => {
    if (path === '/api/dsh/monitor') return listResponse('t1', [{ agent_id: current, name: current, status: 'completed', updated_at: '2026-11-11T12:00:01.000Z' }]);
    if (body.kind === 'status') return statusResponse('t1', body.agentId, 'completed');
    return eventsResponse('t1', body.agentId, [], 0, false);
  });
  await h.open(); h.monitor.selectAgent('a0'); await h.clock.advance(0);
  for (let index = 1; index <= 101; index++) {
    current = `a${index}`;
    await h.clock.advance(5000);
  }
  const snapshot = h.monitor.snapshot();
  const ids = snapshot.list.items.map(item => item.agent_id);
  assert.equal(ids.length, 100);
  assert.equal(snapshot.selectedAgentId, 'a0');
  assert.ok(snapshot.selected, 'selected agent is not evicted');
  assert.ok(ids.includes('a101'), 'current list entry is not evicted');
  assert.ok(!ids.includes('a1'), 'old unselected entry is evicted');
});

test('only one agent is selected and at most 100 bounded events are retained per agent', async () => {
  const events = Array.from({ length: 120 }, (_, index) => ({ event_id: `e${index}`, seq: index, type: 'progress', text: `text-${index}`, summary: { step: index } }));
  const h = harness((path, body) => {
    if (path === '/api/dsh/monitor') return listResponse('t1', [{ agent_id: 'a', status: 'running' }, { agent_id: 'b', status: 'running' }]);
    if (body.kind === 'status') return statusResponse('t1', body.agentId);
    return eventsResponse('t1', body.agentId, events, 120, false);
  });
  await h.open(); h.monitor.selectAgent('a'); await h.clock.advance(0);
  h.monitor.selectAgent('b'); await h.clock.advance(0);
  const snapshot = h.monitor.snapshot();
  assert.equal(snapshot.selectedAgentId, 'b');
  assert.equal(snapshot.selected.events.length, 100);
  assert.match(snapshot.selected.events[0].summary, /"step":20/, 'oldest events are trimmed, summary objects become text');
  assert.equal(h.events().filter(call => call.body.agentId === 'b').length, 1, 'only the selected agent is polled');
});
