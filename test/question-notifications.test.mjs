import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, visibleText } from './mini-dom.mjs';
import { createQuestionNoticeState, createQuestionNotifications } from '../public/ui/question-notifications.js';

const request = (id = 1, token = 'instance-1', method = 'item/tool/requestUserInput') => ({ id, bridgeRequestToken: token, method, params: { threadId: 'thread-a', questions: [{ question: 'private question' }] } });
const rows = (...values) => new Map(values.map((value, index) => [index, value]));
const tick = () => new Promise(resolve => setImmediate(resolve));

test('only actual request instances alert, and reconnect snapshots remain silent', () => {
  const state = createQuestionNoticeState(), a = request();
  assert.equal(state.sync(rows(a), { notify: false }).fresh.length, 0);
  assert.equal(state.sync(rows(a)).fresh.length, 0);
  assert.equal(state.sync(rows()).removed.length, 1);
  assert.equal(state.sync(rows(a)).fresh.length, 0, 'replayed resolved request is not new');
  assert.equal(state.sync(rows(request(1, 'replacement'))).fresh.length, 1, 'new bridge token is a new instance');
  assert.equal(state.sync(rows({ ...request(), method: 'item/completed' }, { ...request(), bridgeRequestToken: undefined })).items.length, 0);
});

test('question and approval methods have separate, stable reminders', () => {
  const state = createQuestionNoticeState();
  const value = state.sync(rows(request(), request('1', 'second', 'item/permissions/requestApproval')));
  assert.deepEqual(value.items.map(item => item.kind), ['question', 'approval']);
  const same = state.sync(rows(request(), request('1', 'second', 'item/permissions/requestApproval')));
  assert.deepEqual(same.items.map(item => item.id), value.items.map(item => item.id));
  assert.equal(same.fresh.length, 0);
});

const asyncItem = (id = 'item-a') => ({ id, type: 'agentMessage', delivery: 'async', questions: [{ title: 'Choose a mode', options: ['Fast', 'Full'] }] });
const asyncEvent = (item = asyncItem(), method = 'item/started', threadId = 'thread-a') => ({ method, params: { threadId, item } });

test('async questions deduplicate started/completed and survive turn completion until explicitly answered', () => {
  const state = createQuestionNoticeState();
  assert.equal(state.observe(asyncEvent()).fresh.length, 1);
  assert.equal(state.observe(asyncEvent(asyncItem(), 'item/completed')).fresh.length, 0);
  assert.equal(state.observe({ method: 'turn/completed', params: { threadId: 'thread-a' } }).items.length, 1);
  assert.equal(state.sync(rows()).items.length, 1, 'RPC reconciliation does not clear async questions');
  const done = state.answered('thread-a', 'item-a'); assert.equal(done.items.length, 0); assert.equal(done.removed.length, 1);
  assert.equal(state.observe(asyncEvent()).items.length, 0, 'late event cannot restore an answered question');
  assert.equal(state.observe(asyncEvent(asyncItem(), 'item/started', 'thread-b')).fresh.length, 1, 'same item id in another thread remains distinct');
});

test('async historical and malformed messages never trigger new system reminders', () => {
  const state = createQuestionNoticeState();
  assert.equal(state.hydrateQuiet([asyncItem()], 'thread-a').items.length, 0);
  assert.equal(state.observe(asyncEvent()).fresh.length, 0);
  assert.equal(state.observe(asyncEvent()).items.length, 0, 'replayed history does not become a pending banner');
  assert.equal(state.observe(asyncEvent({ ...asyncItem('bad'), questions: [{ title: '' }] })).fresh.length, 0);
  assert.equal(state.observe(asyncEvent({ ...asyncItem('normal'), delivery: 'streaming' })).fresh.length, 0);
});

test('environment reset clears async and RPC identities without reusing native click identifiers', () => {
  const state = createQuestionNoticeState();
  const prior = state.sync(rows(request())).items[0].id; state.observe(asyncEvent());
  assert.equal(state.reset().removed.length, 2);
  const next = state.sync(rows(request())); assert.equal(next.fresh.length, 1); assert.notEqual(next.items[0].id, prior);
  assert.equal(state.observe(asyncEvent()).fresh.length, 1);
});

function fixture({ focus = false, visible = true } = {}) {
  const document = createDocument(), host = document.createElement('aside'), window = new EventTarget();
  document.visibilityState = visible ? 'visible' : 'hidden'; document.hasFocus = () => focus;
  const calls = [], opened = [], notices = []; let enabled = true;
  window.codexLightQuestionNotifications = Object.fromEntries(['show', 'clear', 'clearAll'].map(name => [name, async value => calls.push({ name, value })]));
  const controller = createQuestionNotifications({ document, window, host, enabled: () => enabled,
    openThread: async (...args) => opened.push(args), notice: (...args) => notices.push(args) });
  return { document, window, host, controller, calls, opened, notices, disable() { enabled = false; } };
}

test('background system reminder excludes private request content and clears resolved requests', async () => {
  const f = fixture(); f.controller.sync(rows(request())); await tick();
  const shown = f.calls.filter(call => call.name === 'show');
  assert.equal(shown.length, 1); assert.deepEqual(Object.keys(shown[0].value), ['id', 'threadId', 'kind']);
  assert.equal(JSON.stringify(shown).includes('private question'), false);
  f.controller.sync(rows(request())); await tick(); assert.equal(f.calls.filter(call => call.name === 'show').length, 1);
  const event = new Event('codex-light-question-open'); event.detail = shown[0].value; f.window.dispatchEvent(event); await tick();
  assert.equal(f.opened[0][0], 'thread-a');
  f.controller.sync(rows()); await tick(); assert.equal(f.host.hidden, true);
  f.window.dispatchEvent(event); await tick(); assert.equal(f.opened.length, 1, 'stale native click cannot activate a removed request');
  assert.equal(f.calls.at(-1).name, 'clear');
});

test('foreground reminder is persistent, clickable, dismissible and respects preferences', async () => {
  const f = fixture({ focus: true }); f.controller.sync(rows(request())); await tick();
  assert.equal(f.calls.filter(call => call.name === 'show').length, 0);
  assert.equal(f.host.hidden, false); assert.match(visibleText(f.host), /等待你的回答/);
  f.host.children[0].dispatch('click'); await tick(); assert.equal(f.opened.length, 1);
  f.host.children[1].dispatch('click'); assert.equal(f.host.hidden, true);
  f.controller.sync(rows(request(), request(2, 'second'))); assert.equal(f.host.hidden, false);
  f.disable(); f.controller.sync(rows(request(3, 'third'))); await tick();
  assert.equal(f.host.hidden, true); assert.equal(f.calls.at(-1).name, 'clearAll');
  const count = f.calls.length;
  for (let index = 0; index < 10; index++) {
    f.controller.observe({ method: 'item/agentMessage/delta', params: { delta: 'text' } });
    f.controller.hydrateQuiet([asyncItem()], 'thread-a'); f.controller.sync(rows(request(3, 'third')));
  }
  await tick(); assert.equal(f.calls.length, count, 'disabled rendering and tokens do not flood native clear IPC');
  f.controller.dispose(); assert.equal(f.host.hidden, true);
});

test('hidden page gets a reminder even if document reports focus; failed native delivery stays visible', async () => {
  const f = fixture({ focus: true, visible: false });
  f.window.codexLightQuestionNotifications.show = async () => { throw new Error('native unavailable'); };
  f.controller.sync(rows(request())); await tick();
  assert.equal(f.host.hidden, false); assert.equal(f.notices.length, 1);
  f.controller.sync(rows(request(), request(2, 'second'))); await tick(); assert.equal(f.notices.length, 1);
});

test('async notification click carries item identity and clears only after confirmed answer', async () => {
  const f = fixture(); f.controller.observe(asyncEvent()); await tick();
  assert.equal(f.calls.filter(call => call.name === 'show').length, 1);
  f.host.children[0].dispatch('click'); await tick();
  assert.equal(f.opened[0][1].params.itemId, 'item-a');
  f.controller.observe(asyncEvent(asyncItem(), 'item/completed')); await tick();
  assert.equal(f.calls.filter(call => call.name === 'show').length, 1);
  f.controller.answered('thread-a', 'item-a'); await tick();
  assert.equal(f.host.hidden, true); assert.equal(f.calls.at(-1).name, 'clear');
});
