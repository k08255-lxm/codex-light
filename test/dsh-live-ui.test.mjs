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
  const details=$('details');details.className='inspector';
  const head=el('div','inspector-head');const panel=$('dsh-panel');panel.className='inspector-body';
  const section=el('section','agent-inspector');section.append(el('div','agent-list-toolbar'),$('dsh-live-warning'),$('dsh-tasks'));panel.append(section);details.append(head,panel);document.body.append(details);
  const state = { thread: { id: 't' },store:{values:()=>[]}, connected: true, serverInstance: 'i', openGeneration: 1, dshReadGeneration: 1, dshReads: new Map(), dshReadErrors: new Map(), dshOpenDetails: new Set(), dshReadSequence: 0, ...extra };
  const dshLive = { snapshot: () => snapshot, setContext: context => calls.contexts.push(context), selectAgent: id => calls.selected.push(id) };
  const record = kind => (threadId, ...rest) => { calls.ingested.push([kind, threadId]); return false; };
  const dshTasks = { values: () => tasks, ingest: record('ingest'), ingestLiveEvents: record('events'), ingestLiveStatus: record('status') };
  const view = createDshView({ document, state, $, dshLive, dshTasks, el, rpc: async () => ({ data: [] }),
    api: api || (async (path, body) => { calls.api.push([path, body]); return { threadId: 't', agentId: body.agentId, tool: 'dsh_status', result: {} }; }) });
  return { view, $, state, calls, document };
}

const task = (overrides = {}) => ({ threadId: 't', agentId: 'agent-1', name: 'Worker', status: 'running', ...overrides });
const buttons = h => h.$('dsh-tasks').querySelectorAll('button');

test('overview hydrates read-only status automatically and opens one detail surface', async () => {
  const h = harness({ tasks: [task()] });
  h.view.renderDshTasks();
  assert.equal(buttons(h).length,1,'one compact row, not a card with duplicate actions');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.calls.api, [['/api/dsh/read', { threadId: 't', agentId: 'agent-1', kind: 'status' }]]);
  buttons(h)[0].click();
  assert.deepEqual(h.calls.selected, ['agent-1'], 'live selection goes to the monitor, not a new request');
  assert.equal(h.$('details').classList.contains('agent-detail-mode'),true);
  assert.equal(h.$('dsh-tasks').querySelectorAll('.agent-detail-toolbar').length,1);
  assert.equal(h.calls.ingested.length > 0, true, 'a current read is ingested');
  await h.view.readDshTask('agent-1', 'result');
  assert.equal(h.calls.api.length, 1, 'result reads are never issued');
  buttons(h)[0].click();assert.equal(h.$('details').classList.contains('agent-detail-mode'),false,'return restores list chrome');
});

test('a failed status read is shown as a read error without creating tasks or using a model', async () => {
  const h = harness({ tasks: [task()], api: async () => { throw new Error('offline'); } });
  await h.view.readDshTask('agent-1', 'status');
  h.view.openAgent('agent-1','dsh');
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
  assert.equal(visibleText(noThread.$('dsh-tasks')), '当前对话暂无子代理');assert.equal(noThread.calls.api.length,0);
  assert.equal(noThread.$('dsh-live-state').textContent, '等待对话');
  const empty = harness();
  empty.view.renderDshTasks();
  assert.equal(visibleText(empty.$('dsh-tasks')), '当前对话暂无子代理');
});

test('list errors keep the old list, surface a warning and disable refresh when not actionable', () => {
  const h = harness({ snapshot: liveSnapshot({ list: { matched: 0, count: 0, total: 0, error: 'timeout', nextRetryAt: null }, actionable: false, pauseReason: '未连接' }) });
  h.view.renderDshTasks();
  assert.match(h.$('dsh-live-warning').textContent, /子代理刷新失败：timeout/);
  assert.equal(h.$('dsh-live-warning').classList.contains('hidden'), false);
  assert.equal(h.$('dsh-live-refresh').disabled, true);
});

test('context sync forwards thread, connection, visibility and instance to the monitor', () => {
  const h = harness();
  h.view.syncDshLiveContext();
  h.$('details').classList.add('hidden');
  h.view.syncDshLiveContext();
  h.$('chat-page').classList.add('hidden');
  h.state.connected = false;
  h.view.syncDshLiveContext();
  assert.deepEqual(h.calls.contexts, [
    { threadId: 't', connected: true, visible: true, serverInstance: 'i' },
    { threadId: 't', connected: true, visible: true, serverInstance: 'i' },
    { threadId: 't', connected: false, visible: false, serverInstance: 'i' },
  ]);
});

test('static shell mounts one inspector scroll surface rather than nested event scrollers', () => {
  for (const id of ['toggle-details', 'rail-dsh', 'dsh-panel', 'dsh-live-state', 'dsh-live-meta', 'dsh-live-warning', 'dsh-live-refresh', 'dsh-tasks']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} mounted once`);
  }
  assert.doesNotMatch(html, /id="open-dsh"/, 'Activity is the single conversation panel entry');
  assert.match(html,/id="dsh-panel" class="inspector-body hidden"/);
  assert.match(html,/id="dsh-tasks" class="agent-inspector-content"/);
  const rule=css.match(/\.inspector-body\s*\{([^}]+)\}/)?.[1]||'';
  assert.match(rule,/overflow:\s*auto/);
});
