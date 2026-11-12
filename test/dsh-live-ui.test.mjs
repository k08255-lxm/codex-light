import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDocument, visibleText } from './mini-dom.mjs';
import { createDshView } from '../public/ui/dsh-view.js';

// Behaviour of the real DSH view module over a minimal DOM. The monitor/task store are fakes that
// record calls; polling/cursor semantics of DshLiveMonitor itself are covered by dsh-live.test.mjs.
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');

function liveSnapshot(overrides = {}) {
  return { context: { threadId: 't', connected: true, visible: true }, list: { matched: 1, count: 1, total: 1, checkedAt: null }, actionable: true, selectedAgentId: null, selected: null, ...overrides };
}

function harness({ tasks = [], snapshot = liveSnapshot(), state: extra = {}, api } = {}) {
  const document = createDocument(); document.visibilityState = 'visible';
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) { const node = document.createElement('div'); node.id = id; nodes.set(id, node); } return nodes.get(id); };
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const calls = { api: [], contexts: [], selected: [], ingested: [] };
  const state = { thread: { id: 't' }, connected: true, serverInstance: 'i', openGeneration: 1, dshReadGeneration: 1, dshReads: new Map(), dshReadErrors: new Map(), dshOpenDetails: new Set(), dshReadSequence: 0, ...extra };
  const dshLive = { snapshot: () => snapshot, setContext: context => calls.contexts.push(context), selectAgent: id => calls.selected.push(id) };
  const record = kind => (threadId, ...rest) => { calls.ingested.push([kind, threadId]); return false; };
  const dshTasks = { values: () => tasks, ingest: record('ingest'), ingestLiveEvents: record('events'), ingestLiveStatus: record('status') };
  const view = createDshView({ document, state, $, dshLive, dshTasks, el, rpc: async () => ({ data: [] }),
    api: api || (async (path, body) => { calls.api.push([path, body]); return { threadId: 't', agentId: body.agentId, tool: 'dsh_status', result: {} }; }) });
  return { view, $, state, calls, document };
}

const task = (overrides = {}) => ({ threadId: 't', agentId: 'agent-1', name: 'Worker', status: 'running', ...overrides });
const buttons = h => h.$('dsh-tasks').querySelectorAll('button');

test('task cards offer only read-only live and status actions; status reads use the fixed status kind', async () => {
  const h = harness({ tasks: [task()] });
  h.view.renderDshTasks();
  const labels = buttons(h).map(button => button.textContent);
  assert.deepEqual(labels, ['查看实时进展', '刷新任务状态']);
  buttons(h)[0].click();
  assert.deepEqual(h.calls.selected, ['agent-1'], 'live selection goes to the monitor, not a new request');
  buttons(h)[1].click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.api, [['/api/dsh/read', { threadId: 't', agentId: 'agent-1', kind: 'status' }]]);
  assert.equal(h.calls.ingested.length > 0, true, 'a current read is ingested');
  await h.view.readDshTask('agent-1', 'result');
  assert.equal(h.calls.api.length, 1, 'result reads are never issued');
});

test('a failed status read is shown as a read error without creating tasks or using a model', async () => {
  const h = harness({ tasks: [task()], api: async () => { throw new Error('offline'); } });
  await h.view.readDshTask('agent-1', 'status');
  assert.match(visibleText(h.$('dsh-tasks')), /offline/);
  assert.equal(h.state.dshReads.size, 0, 'the in-flight marker is released');
});

test('a late status read for a previous thread or generation is ignored', async () => {
  let resolve; const h = harness({ tasks: [task()], api: () => new Promise(done => { resolve = done; }) });
  const pending = h.view.readDshTask('agent-1', 'status').catch(error => error);
  await new Promise(done => setImmediate(done));
  h.state.openGeneration++;
  resolve({ threadId: 't', agentId: 'agent-1', tool: 'dsh_status', result: { structuredContent: { status: 'completed' } } });
  await pending;
  assert.equal(h.state.dshReads.size, 0);
  assert.deepEqual(h.calls.ingested, [], 'a stale result never reaches the task store');
});

test('empty states never imply that a conversation will be created', () => {
  const noThread = harness({ state: { thread: null }, snapshot: liveSnapshot({ context: { threadId: null, connected: true, visible: true } }) });
  noThread.view.renderDshTasks();
  assert.match(visibleText(noThread.$('dsh-tasks')), /不会偷偷创建对话/);
  assert.equal(noThread.$('dsh-live-state').textContent, '等待对话');
  const empty = harness();
  empty.view.renderDshTasks();
  assert.match(visibleText(empty.$('dsh-tasks')), /尚未发现 DSH agent/);
});

test('list errors keep the old list, surface a warning and disable refresh when not actionable', () => {
  const h = harness({ snapshot: liveSnapshot({ list: { matched: 0, count: 0, total: 0, error: 'timeout', nextRetryAt: null }, actionable: false, pauseReason: '未连接' }) });
  h.view.renderDshTasks();
  assert.match(h.$('dsh-live-warning').textContent, /自动列表读取失败：timeout/);
  assert.equal(h.$('dsh-live-warning').classList.contains('hidden'), false);
  assert.equal(h.$('dsh-live-refresh').disabled, true);
});

test('context sync forwards thread, connection, visibility and instance to the monitor', () => {
  const h = harness();
  h.view.syncDshLiveContext();
  h.$('details').classList.add('hidden');
  h.state.connected = false;
  h.view.syncDshLiveContext();
  assert.deepEqual(h.calls.contexts, [
    { threadId: 't', connected: true, visible: true, serverInstance: 'i' },
    { threadId: 't', connected: false, visible: false, serverInstance: 'i' },
  ]);
});

test('static shell mounts each DSH live element once; list and event areas scroll in place', () => {
  for (const id of ['open-dsh', 'rail-dsh', 'dsh-panel', 'dsh-live-state', 'dsh-live-meta', 'dsh-live-warning', 'dsh-live-refresh', 'dsh-tasks']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} mounted once`);
  }
  for (const selector of ['.dsh-task-list', '.dsh-live-events']) {
    const rule = css.match(new RegExp(`\\${selector}\\s*\\{([^}]+)\\}`))?.[1] || '';
    assert.match(rule, /max-height:/, selector);
    assert.match(rule, /overflow-y:\s*auto/, selector);
    assert.match(rule, /overscroll-behavior:\s*contain/, selector);
  }
});
