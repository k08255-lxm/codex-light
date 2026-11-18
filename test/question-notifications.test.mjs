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
const asyncEvent = (item = asyncItem(), method = 'item/started', threadId = 'thread-a', turnId = 'question-turn') => ({ method, params: { threadId, turnId, item } });
const transcript = (...items) => [{ id: 'question-turn', items }];
const echo = (id = 'echo', tagged = true) => ({ id, type: 'userMessage', content: [{ type: 'text', text: (tagged ? '对提问的回答\n\n' : '') + '1. Choose a mode\n回答：Fast' }] });

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
  assert.equal(state.hydrateQuiet(transcript(asyncItem()), 'thread-a').items.length, 0);
  assert.equal(state.observe(asyncEvent()).fresh.length, 0);
  assert.equal(state.observe(asyncEvent()).items.length, 0, 'replayed history does not become a pending banner');
  assert.equal(state.observe(asyncEvent({ ...asyncItem('bad'), questions: [{ title: '' }] })).fresh.length, 0);
  assert.equal(state.observe(asyncEvent({ ...asyncItem('normal'), delivery: 'streaming' })).fresh.length, 0);
});

test('confirmed external echoes remove matching async reminders once, including in another thread', () => {
  const state = createQuestionNoticeState();
  state.observe(asyncEvent(asyncItem(), 'item/started', 'thread-b'));
  assert.equal(state.observe(asyncEvent(echo(), 'item/started', 'thread-b')).items.length, 1);
  assert.equal(state.observe(asyncEvent(echo(), 'item/completed', 'thread-a')).items.length, 1);
  assert.equal(state.observe(asyncEvent(echo(), 'item/completed', 'thread-b', 'answer-turn')).removed.length, 1);
  state.observe(asyncEvent(asyncItem('another-item'), 'item/started', 'thread-b', 'another-turn'));
  assert.equal(state.observe(asyncEvent(echo(), 'item/completed', 'thread-b', 'answer-turn')).items.length, 1, 'repeated echo cannot answer the next matching question');
});

test('hydration clears only confirmed transcript replies, preserving pending, draft and ambiguous answers', () => {
  const state = createQuestionNoticeState(), question = asyncItem(), other = asyncItem('another-item');
  state.observe(asyncEvent());
  assert.equal(state.hydrateQuiet(transcript(), 'thread-a').items.length, 1);
  assert.equal(state.hydrateQuiet(transcript(question, { ...echo(), _local: true }), 'thread-a').items.length, 1);
  assert.equal(state.hydrateQuiet(transcript(question, other, echo()), 'thread-a').items.length, 1);
  assert.equal(state.observe(asyncEvent(echo('legacy', false), 'item/completed')).items.length, 1);
  assert.equal(state.hydrateQuiet(transcript(question, echo('legacy', false)), 'thread-a').removed.length, 1);
  assert.equal(state.observe(asyncEvent()).items.length, 0);
});

test('confirmed archive removes that thread only and restoration keeps old prompts silent', () => {
  const state = createQuestionNoticeState(), archived = request(), other = { ...request(2, 'other'), params: { threadId: 'thread-b' } };
  state.sync(rows(archived, other)); state.observe(asyncEvent());
  const result = state.forgetThread('thread-a');
  assert.deepEqual(result.items.map(item => item.threadId), ['thread-b']);
  assert.equal(result.removed.length, 2);
  assert.equal(state.sync(rows(archived, other)).items.length, 1);
  const replay = asyncEvent(asyncItem('replay'));
  assert.equal(state.observe(replay).items.length, 1);
  state.restoreThread('thread-a');
  assert.equal(state.observe(replay).items.length, 1);
  assert.equal(state.observe(asyncEvent(asyncItem('fresh'))).fresh.length, 1);
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
  const calls = [], opened = [], notices = [], counts = []; let enabled = true, canOpen = true;
  window.codexLightQuestionNotifications = Object.fromEntries(['show', 'clear', 'clearAll'].map(name => [name, async value => calls.push({ name, value })]));
  const controller = createQuestionNotifications({ document, window, host, enabled: () => enabled, canOpen: () => canOpen,
    onPendingQuestions: (...args) => counts.push(args),
    openThread: async (...args) => opened.push(args), notice: (...args) => notices.push(args) });
  return { document, window, host, controller, calls, opened, notices, counts, disable() { enabled = false; }, allowOpen(value) { canOpen = value; } };
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
  assert.equal(f.calls.filter(call => call.name === 'show').length, 1);
  assert.equal(f.host.hidden, false); assert.match(visibleText(f.host), /等待你的回答/);
  f.host.children[0].dispatch('click'); await tick(); assert.equal(f.opened.length, 1);
  f.host.children[1].dispatch('click'); assert.equal(f.host.hidden, true);
  assert.deepEqual(f.counts, [[0,true],[1,true]], 'dismissing the card leaves the outstanding count');
  f.controller.sync(rows(request(), request(2, 'second'))); assert.equal(f.host.hidden, false);
  f.disable(); f.controller.sync(rows(request(3, 'third'))); await tick();
  assert.equal(f.host.hidden, true); assert.equal(f.calls.at(-1).name, 'clearAll');
  assert.deepEqual(f.counts.at(-1), [1,false], 'disabled notifications preserve the outstanding question count');
  const count = f.calls.length;
  for (let index = 0; index < 10; index++) {
    f.controller.observe({ method: 'item/agentMessage/delta', params: { delta: 'text' } });
    f.controller.hydrateQuiet(transcript(asyncItem()), 'thread-a'); f.controller.sync(rows(request(3, 'third')));
  }
  await tick(); assert.equal(f.calls.length, count, 'disabled rendering and tokens do not flood native clear IPC');
  f.controller.dispose(); assert.equal(f.host.hidden, true);
  assert.deepEqual(f.counts.at(-1), [0,false]);
});

test('count includes outstanding questions but excludes approvals and replays', async () => {
  const f = fixture();
  const approval = request('approval', 'approval', 'item/permissions/requestApproval');
  f.controller.sync(rows(request(), approval), { notify: false });
  f.controller.observe(asyncEvent());
  f.controller.observe(asyncEvent(asyncItem(), 'item/completed'));
  f.controller.answered('thread-a', 'item-a');
  f.controller.sync(rows(approval));
  f.controller.reset();
  await tick();
  assert.deepEqual(f.counts, [[0,true],[1,true],[2,true],[1,true],[0,true]]);
  assert.equal(f.calls.filter(call => call.name === 'show').length, 0, 'reconciled and immediately resolved requests are not posted');
});

test('native click identifies a specific live card and waits for a navigation already in progress', async () => {
  const f = fixture();
  f.controller.sync(rows(request(), { ...request(2, 'second'), params: { threadId: 'thread-b' } }));
  await tick();
  const target = f.calls.filter(call => call.name === 'show').at(-1).value;
  const dispatch = value => {
    const event = new Event('codex-light-question-open'); event.detail = value; f.window.dispatchEvent(event);
  };
  f.allowOpen(false);
  dispatch(target);
  dispatch({ ...target, threadId: 'thread-a' });
  assert.equal(f.opened.length, 0);
  f.allowOpen(true);
  await f.controller.flushOpen();
  assert.equal(f.opened[0][0], 'thread-b');
  assert.equal(f.opened[0][1].id, 2);
});

test('browser permission requires an explicit gesture and only applies to new requests', async () => {
  const document = createDocument(), window = new EventTarget();
  const host = document.createElement('aside'), permissionStatus = document.createElement('p'), permissionButton = document.createElement('button');
  const shown = [], opened = []; let prompts = 0, focused = 0;
  window.isSecureContext = true;
  window.focus = () => focused++;
  window.Notification = class {
    static permission = 'default';
    static async requestPermission() { prompts++; return this.permission = 'granted'; }
    constructor(title, options) { this.title = title; this.options = options; shown.push(this); }
    close() { this.closed = true; }
  };
  const controller = createQuestionNotifications({ document, window, host, permissionStatus, permissionButton, openThread: (...args) => opened.push(args) });
  controller.sync(rows(request())); await tick();
  assert.equal(prompts, 0); assert.equal(shown.length, 0); assert.equal(permissionButton.hidden, false);
  permissionButton.dispatch('click'); await tick();
  assert.equal(prompts, 1); assert.equal(shown.length, 0); assert.equal(permissionButton.hidden, true);
  controller.sync(rows(request(), request(2, 'second'))); await tick();
  assert.equal(shown.length, 1); assert.doesNotMatch(JSON.stringify(shown[0]), /private question|thread-a/);
  shown[0].onclick(new Event('click')); await tick();
  assert.equal(focused, 1); assert.equal(opened[0][1].id, 2); assert.equal(shown[0].closed, true);
  window.Notification.permission = 'denied';
  controller.sync(rows(request(3, 'third'))); await tick();
  assert.equal(shown.length, 1); assert.match(permissionStatus.textContent, /通知已关闭/);
});

test('Android question bridge receives private-free events and uses only an explicit permission or settings action', async () => {
  const document = createDocument(), window = new EventTarget(), host = document.createElement('aside');
  const permissionStatus = document.createElement('p'), permissionButton = document.createElement('button');
  let status = 'permission_required', prompts = 0, settings = 0;
  const calls = [];
  window.CodexLightNative = {
    getQuestionNotificationStatus: () => status,
    requestQuestionNotificationPermission: () => prompts++,
    openTaskNotificationSettings: () => settings++,
    updateQuestionNotification: json => calls.push(JSON.parse(json)),
  };
  const controller = createQuestionNotifications({ document, window, host, permissionStatus, permissionButton, openThread() {} });
  await tick();
  assert.equal(prompts, 0); permissionButton.dispatch('click'); await tick(); assert.equal(prompts, 1);
  status = 'ready'; window.dispatchEvent(new Event('codexlight-question-notification-status'));
  assert.equal(permissionButton.hidden, true);
  controller.sync(rows(request())); await tick();
  assert.deepEqual(calls.at(-1), { operation: 'show', id: 'question-1', threadId: 'thread-a', kind: 'question' });
  status = 'blocked'; window.dispatchEvent(new Event('focus'));
  permissionButton.dispatch('click'); await tick(); assert.equal(settings, 1);
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
